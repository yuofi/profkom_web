"""
Тесты эндпоинта POST /api/auth/vk (main.py:344).

Сеть НЕ трогается никогда: фикстура `mock_vk` подменяет urllib.request.urlopen,
фикстура `mock_s3` (autouse) подменяет upload_image_from_url.

Часть тестов помечена @pytest.mark.xfail(strict=True) — это НЕ «сломанные тесты»,
а зафиксированные дефекты бэкенда: тест утверждает КОРРЕКТНОЕ поведение и
покраснеет ровно в тот момент, когда баг починят (и маркер надо будет снять).
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any, Optional

import pytest
from sqlalchemy import text

import auth as auth_module
import database as database_module
from database import db

URL = "/api/auth/vk"


# ─────────────────────────────────────────────────────────────
#  Вспомогательные утилиты
# ─────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _clean_cookies(client):
    """client — session-scoped, его банка кук общая для всех тестов. Чистим."""
    client.cookies.clear()
    yield
    client.cookies.clear()


def _post(client, **body) -> Any:
    return client.post(URL, json=body)


def _sub(access_token: str) -> int:
    """user_id из выданного access-токена (проверяем подпись боевым секретом)."""
    from jose import jwt

    payload = jwt.decode(access_token, auth_module.SECRET_KEY, algorithms=[auth_module.ALGORITHM])
    assert payload["type"] == "access", "выдан токен не типа access"
    return int(payload["sub"])


def _b64url(obj: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).rstrip(b"=").decode("ascii")


def _unsigned_id_token(claims: dict) -> str:
    """JWT с alg=none и пустой подписью — подпись отсутствует физически."""
    return f'{_b64url({"alg": "none", "typ": "JWT"})}.{_b64url(claims)}.'


def _foreign_id_token(claims: dict) -> str:
    """JWT, подписанный произвольным секретом злоумышленника."""
    from jose import jwt

    return jwt.encode(claims, "attacker-controlled-secret", algorithm="HS256")


def _refresh_rows(user_id: Optional[int] = None) -> int:
    with database_module.engine.begin() as conn:
        if user_id is None:
            return conn.execute(text("SELECT COUNT(*) FROM refresh_tokens")).scalar_one()
        return conn.execute(
            text("SELECT COUNT(*) FROM refresh_tokens WHERE user_id = :uid"), {"uid": user_id}
        ).scalar_one()


def _set_cookie_header(response) -> str:
    cookies = response.headers.get_list("set-cookie")
    assert len(cookies) == 1, f"ожидалась ровно одна кука, получено: {cookies}"
    return cookies[0]


# ─────────────────────────────────────────────────────────────
#  1. Happy path: новый пользователь
# ─────────────────────────────────────────────────────────────
def test_novyy_polzovatel_poluchaet_paru_tokenov(client, mock_vk):
    """Новый VK-пользователь: 200 и полный TokenPair из трёх полей."""
    mock_vk(user_id="777")

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 200, f"ожидали 200, тело: {r.text}"
    body = r.json()
    assert set(body.keys()) == {"access_token", "refresh_token", "token_type"}, (
        f"схема ответа не совпадает с TokenPair: {sorted(body.keys())}"
    )
    assert isinstance(body["access_token"], str) and body["access_token"], "access_token пуст"
    assert isinstance(body["refresh_token"], str) and body["refresh_token"], "refresh_token пуст"
    assert body["token_type"] == "bearer", "token_type должен быть 'bearer'"

    created = db.get_user_by_email("vk_777@vk.com")
    assert created is not None, "пользователь не создан"
    assert _sub(body["access_token"]) == created.user_id, "access-токен выдан не тому пользователю"


def test_refresh_token_sohranyaetsya_v_bd(client, mock_vk):
    """Выданный refresh-токен реально лежит в таблице refresh_tokens."""
    mock_vk(user_id="777")

    r = _post(client, access_token="vk-access-token")

    body = r.json()
    stored = db.get_refresh_token(body["refresh_token"])
    assert stored is not None, "refresh-токен не сохранён в базе"
    assert stored["user_id"] == _sub(body["access_token"]), "refresh-токен привязан к другому user_id"
    assert _refresh_rows() == 1, "должна быть создана ровно одна запись refresh-токена"


def test_kuka_refresh_token_vystavlyaetsya(client, mock_vk):
    """Успех выставляет httponly/secure куку refresh_token с TTL из настроек."""
    mock_vk(user_id="777")

    r = _post(client, access_token="vk-access-token")

    raw = _set_cookie_header(r)
    assert raw.startswith(f"refresh_token={r.json()['refresh_token']}"), (
        f"в куке лежит не тот refresh-токен: {raw}"
    )
    low = raw.lower()
    assert "httponly" in low, "кука обязана быть HttpOnly"
    assert "secure" in low, "кука обязана быть Secure"
    assert "samesite=none" in low, "кука обязана быть SameSite=none"
    assert f"max-age={auth_module.REFRESH_TTL_DAYS * 24 * 60 * 60}" in low, (
        f"неверный Max-Age куки: {raw}"
    )


def test_novyy_polzovatel_sozdaetsya_s_pravilnym_kontaktom(client, mock_vk):
    """Побочный эффект: в БД появляется contact_info с фиксированными VK-дефолтами."""
    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров")

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    contact = db.get_contact(uid)
    assert contact is not None, "contact_info не создан"
    assert contact.email == "vk_777@vk.com", "должен подставляться синтетический email"
    assert contact.name == "Пётр", "имя взято не из VK"
    assert contact.surname == "Сидоров", "фамилия взята не из VK"
    assert contact.patronymic == "", "отчество должно быть пустым"
    assert contact.kkr_name == "Пётр Сидоров", "kkr_name = 'first_name last_name'"
    assert contact.vk == "https://vk.com/id777", "vk-ссылка собрана неверно"
    assert contact.group_number == "0", "group_number для VK-регистрации = '0'"
    assert contact.budget is True, "budget для VK-регистрации жёстко True"
    assert contact.in_profcom is False, "in_profcom должен быть False"
    assert contact.phone == "", "телефона не было — поле должно остаться пустым"
    assert contact.tg == "", "tg должен быть пустым"
    assert contact.blocks == "", "блоков быть не должно"
    assert contact.location == "", "location должен быть пустым"


def test_novyy_polzovatel_sozdaetsya_bez_parolya_i_bez_prav(client, mock_vk):
    """Запись в users: пустой хеш пароля, ноль баллов, никаких прав."""
    mock_vk(user_id="777")

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    u = db.get_user(uid)
    assert u is not None, "пользователь не создан"
    assert u.hashed_password == "", "VK-аккаунт обязан быть без пароля"
    assert u.kkr_score == 0, "kkr_score должен быть 0"
    assert u.group_number == "0", "group_number должен быть '0'"
    assert u.blocks == "", "блоков быть не должно"
    assert u.banned is False, "новый пользователь не забанен"
    assert u.admin is False, "новый пользователь не админ"
    assert u.super_user is False, "новый пользователь не суперюзер"
    assert u.photo_url is None, "аватарки не было — photo_url должен быть None"


def test_email_ot_vk_ispolzuetsya_vmesto_sinteticheskogo(client, mock_vk):
    """Если VK вернул email — синтетический vk_<id>@vk.com не подставляется."""
    mock_vk(user_id="777", email="petr@vk-mail.ru")

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    assert db.get_contact(uid).email == "petr@vk-mail.ru", "email от VK проигнорирован"
    assert db.get_user_by_email("vk_777@vk.com") is None, "создан лишний синтетический email"


def test_povtornyy_vhod_ne_sozdaet_dublikat(client, mock_vk):
    """Идемпотентность: второй вход тем же VK-аккаунтом переиспользует пользователя."""
    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров")

    first = _post(client, access_token="vk-access-token")
    second = _post(client, access_token="vk-access-token")

    assert second.status_code == 200, f"повторный вход упал: {second.text}"
    assert _sub(first.json()["access_token"]) == _sub(second.json()["access_token"]), (
        "повторный вход выдал токен другому пользователю"
    )
    assert len(db.list_contacts()) == 1, "повторный вход создал дубликат пользователя"
    assert _refresh_rows() == 2, "каждый вход обязан выдавать новый refresh-токен"


# ─────────────────────────────────────────────────────────────
#  2. Сопоставление с существующим пользователем
# ─────────────────────────────────────────────────────────────
def test_sushchestvuyushchiy_polzovatel_nayden_po_email(client, mock_vk, make_user):
    """Совпал email → используется существующий аккаунт, дубликат не создаётся."""
    victim = make_user(email="ivan@test.ru", name="Иван", surname="Иванов")
    mock_vk(user_id="777", email="ivan@test.ru", first_name="Совсем", last_name="Другой")

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 200, f"ожидали 200, тело: {r.text}"
    assert _sub(r.json()["access_token"]) == victim.user_id, "выдан токен не тому пользователю"
    assert len(db.list_contacts()) == 1, "создан дубликат вместо переиспользования"
    contact = db.get_contact(victim.user_id)
    assert contact.name == "Иван", "имя существующего пользователя не должно перетираться данными VK"
    assert contact.kkr_name == "Иван Иванов", "kkr_name существующего пользователя не должен меняться"


def test_polzovatel_nayden_po_kkr_name_kogda_email_ne_sovpal(client, mock_vk, make_user):
    """
    Email не совпал → аккаунт ищется по отображаемому имени 'first_name last_name'.

    ВНИМАНИЕ (дефект безопасности, main.py:447-449): достаточно поставить в профиле
    VK имя и фамилию как у существующего пользователя, чтобы войти в его аккаунт.
    Тест фиксирует фактическое поведение, чтобы оно не изменилось незаметно.
    """
    victim = make_user(email="victim@test.ru", name="Иван", surname="Иванов", kkr_name="Иван Иванов")
    mock_vk(user_id="777", first_name="Иван", last_name="Иванов", email="attacker@evil.ru")

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 200, f"ожидали 200, тело: {r.text}"
    assert _sub(r.json()["access_token"]) == victim.user_id, (
        "по совпадению kkr_name должен был найтись существующий пользователь"
    )
    assert len(db.list_contacts()) == 1, "новый пользователь не должен создаваться"
    assert db.get_contact(victim.user_id).email == "victim@test.ru", "email аккаунта не должен меняться"


def test_pri_nesovpadenii_i_email_i_imeni_sozdaetsya_novyy(client, mock_vk, make_user):
    """Ни email, ни kkr_name не совпали → создаётся отдельный пользователь."""
    existing = make_user(email="ivan@test.ru", name="Иван", surname="Иванов", kkr_name="Иван Иванов")
    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров", email="petr@vk-mail.ru")

    r = _post(client, access_token="vk-access-token")

    uid = _sub(r.json()["access_token"])
    assert uid != existing.user_id, "выдан токен чужого аккаунта"
    assert len(db.list_contacts()) == 2, "должно быть два независимых пользователя"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: vk-ссылка не проставляется существующему пользователю при входе через VK — "
           "аккаунт остаётся никак не связан с VK id (main.py:491-500)",
)
def test_vk_ssylka_propisyvaetsya_sushchestvuyushchemu_polzovatelyu(client, mock_vk, make_user):
    """Вход через VK должен связывать существующий аккаунт с VK id."""
    victim = make_user(email="ivan@test.ru", name="Иван", surname="Иванов")
    mock_vk(user_id="777", email="ivan@test.ru")

    _post(client, access_token="vk-access-token")

    assert db.get_contact(victim.user_id).vk == "https://vk.com/id777", (
        "поле vk существующего пользователя не заполнено"
    )


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: VK-пользователи без имени и фамилии получают kkr_name='' и склеиваются "
           "в один аккаунт через get_user_by_name('') (main.py:445-449)",
)
def test_raznye_vk_akkaunty_bez_imeni_ne_skleivayutsya(client, mock_vk):
    """Два разных VK id без имени/фамилии обязаны стать двумя разными пользователями."""
    mock_vk(user_id="111", first_name="", last_name="")
    first = _post(client, access_token="token-1")

    mock_vk(user_id="222", first_name="", last_name="")
    second = _post(client, access_token="token-2")

    assert _sub(first.json()["access_token"]) != _sub(second.json()["access_token"]), (
        "два разных VK-аккаунта склеились в один"
    )
    assert len(db.list_contacts()) == 2, "должно быть два независимых пользователя"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: повышение привилегий — create_user_with_contact вызывает _sync_admin_rights, "
           "и новый VK-пользователь с ФИО мастера блока получает admin=True "
           "(main.py:489 → database.py:509)",
)
def test_novyy_vk_polzovatel_s_fio_mastera_ne_stanovitsya_adminom(client, mock_vk, make_block):
    """Совпадение отображаемого имени VK с master блока не должно давать прав админа."""
    make_block(name="Медиа", master="Пётр Сидоров")
    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров")

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    assert db.get_user(uid).admin is False, "самозванец из VK получил права администратора"


# ─────────────────────────────────────────────────────────────
#  3. Телефон
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "vk_phone, expected",
    [
        ("79991234567", "+79991234567"),
        ("+79991234567", "+79991234567"),
        ("  79991234567  ", "+79991234567"),
        ("8 (999) 123-45-67", "+8 (999) 123-45-67"),
    ],
    ids=["bez-plyusa", "s-plyusom", "s-probelami", "s-formatirovaniem"],
)
def test_normalizaciya_telefona_dlya_novogo_polzovatelya(client, mock_vk, vk_phone, expected):
    """Телефон нормализуется (ведущий '+') и пишется в contact_info."""
    mock_vk(user_id="777", phone=vk_phone)

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    assert db.get_contact(uid).phone == expected, "телефон нормализован неверно"


def test_telefon_zapisyvaetsya_sushchestvuyushchemu_polzovatelyu(client, mock_vk, make_user):
    """Для найденного пользователя телефон обновляется через update_contact."""
    victim = make_user(email="ivan@test.ru", phone="")
    mock_vk(user_id="777", email="ivan@test.ru", phone="79990000000")

    _post(client, access_token="vk-access-token")

    assert db.get_contact(victim.user_id).phone == "+79990000000", "телефон не записан в контакт"


def test_bez_telefona_sushchestvuyushchiy_ne_zatiraetsya(client, mock_vk, make_user):
    """VK не вернул телефон → существующее значение не трогаем."""
    victim = make_user(email="ivan@test.ru", phone="+70000000000")
    mock_vk(user_id="777", email="ivan@test.ru")

    _post(client, access_token="vk-access-token")

    assert db.get_contact(victim.user_id).phone == "+70000000000", "существующий телефон затёрт"


# ─────────────────────────────────────────────────────────────
#  4. Аватар и S3
# ─────────────────────────────────────────────────────────────
def test_avatar_novogo_polzovatelya_zagruzhaetsya_s_cs_150x150(client, mock_vk, mock_s3):
    """Часть 'cs=...' переписывается в 'cs=150x150', файл уходит в папку avatars."""
    mock_vk(user_id="777", avatar="https://sun1.vk.com/photo.jpg?size=400x400&cs=400x400")

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    assert mock_s3["upload"] == [
        {"url": "https://sun1.vk.com/photo.jpg?size=400x400&cs=150x150", "folder": "avatars"}
    ], f"upload_image_from_url вызван неверно: {mock_s3['upload']}"
    photo = db.get_user(uid).photo_url
    assert isinstance(photo, str) and photo.startswith("https://"), "photo_url не сохранён в БД"


def test_avatar_bez_cs_peredaetsya_bez_izmeneniy(client, mock_vk, mock_s3):
    """В URL нет 'cs=' → регулярка ничего не меняет."""
    mock_vk(user_id="777", avatar="https://sun1.vk.com/photo.jpg")

    _post(client, access_token="vk-access-token")

    assert mock_s3["upload"] == [{"url": "https://sun1.vk.com/photo.jpg", "folder": "avatars"}], (
        f"URL аватара изменён без нужды: {mock_s3['upload']}"
    )


def test_bez_avatara_s3_ne_vyzyvaetsya(client, mock_vk, mock_s3):
    """VK не вернул аватар → в S3 не ходим вовсе."""
    mock_vk(user_id="777")

    _post(client, access_token="vk-access-token")

    assert mock_s3["upload"] == [], "загрузка в S3 при отсутствии аватара"


def test_avatar_zagruzhaetsya_sushchestvuyushchemu_bez_photo_url(client, mock_vk, mock_s3, make_user):
    """У найденного пользователя нет photo_url → аватар подтягивается."""
    victim = make_user(email="ivan@test.ru", photo_url=None)
    mock_vk(user_id="777", email="ivan@test.ru", avatar="https://sun1.vk.com/p.jpg?cs=400x400")

    _post(client, access_token="vk-access-token")

    assert len(mock_s3["upload"]) == 1, f"ожидали одну загрузку: {mock_s3['upload']}"
    assert mock_s3["upload"][0]["url"] == "https://sun1.vk.com/p.jpg?cs=150x150", "URL не переписан"
    assert db.get_user(victim.user_id).photo_url is not None, "photo_url не обновлён в БД"


def test_avatar_ne_perezapisyvaetsya_esli_photo_url_uzhe_est(client, mock_vk, mock_s3, make_user):
    """У пользователя уже есть аватар → повторной загрузки в S3 нет."""
    victim = make_user(email="ivan@test.ru", photo_url="https://cdn.test/old.jpg")
    mock_vk(user_id="777", email="ivan@test.ru", avatar="https://sun1.vk.com/p.jpg?cs=400x400")

    _post(client, access_token="vk-access-token")

    assert mock_s3["upload"] == [], "аватар перезалит поверх существующего"
    assert db.get_user(victim.user_id).photo_url == "https://cdn.test/old.jpg", "photo_url затёрт"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: жадная регулярка r'cs=.*$' срезает все query-параметры после cs=, "
           "ломая подписанные URL аватаров VK (main.py:474-475 и main.py:494-495)",
)
def test_perepisyvanie_cs_ne_teryaet_ostalnye_parametry(client, mock_vk, mock_s3):
    """Переписывать надо только значение cs=, остальные параметры обязаны сохраниться."""
    mock_vk(user_id="777", avatar="https://sun1.vk.com/p.jpg?cs=400x400&ava=1&sign=abc")

    _post(client, access_token="vk-access-token")

    assert mock_s3["upload"][0]["url"] == "https://sun1.vk.com/p.jpg?cs=150x150&ava=1&sign=abc", (
        f"потеряны параметры URL: {mock_s3['upload']}"
    )


# ─────────────────────────────────────────────────────────────
#  5. Забаненный пользователь
# ─────────────────────────────────────────────────────────────
def test_zabanennyy_polzovatel_403(client, mock_vk, make_user):
    """Найденный забаненный аккаунт → 403 'User is banned'."""
    banned = make_user(email="ban@test.ru", banned=True)
    tokens_before = _refresh_rows()
    mock_vk(user_id="777", email="ban@test.ru")

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 403, f"ожидали 403, получили {r.status_code}: {r.text}"
    assert r.json() == {"detail": "User is banned"}, "неверное тело ошибки"
    assert r.headers.get_list("set-cookie") == [], "забаненному выставлена кука refresh_token"
    assert _refresh_rows() == tokens_before, "забаненному выдан refresh-токен"
    assert _refresh_rows(banned.user_id) == 1, "у забаненного появились новые refresh-токены"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: проверка banned стоит ПОСЛЕ записи в БД, поэтому вход забаненного "
           "всё равно перезаписывает его телефон и аватар (main.py:499-503)",
)
def test_zabanennyy_ne_modificiruetsya_pered_otkazom(client, mock_vk, make_user):
    """403 не должен сопровождаться записью данных в аккаунт забаненного."""
    banned = make_user(email="ban@test.ru", banned=True, phone="+70000000000")
    mock_vk(user_id="777", email="ban@test.ru", phone="79991112233")

    _post(client, access_token="vk-access-token")

    assert db.get_contact(banned.user_id).phone == "+70000000000", (
        "данные забаненного изменены до отказа в доступе"
    )


def test_novyy_vk_polzovatel_nikogda_ne_zabanen(client, mock_vk):
    """Свежесозданный VK-аккаунт не может получить 403."""
    mock_vk(user_id="777")

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"


# ─────────────────────────────────────────────────────────────
#  6. Отказы VK API
# ─────────────────────────────────────────────────────────────
def test_padenie_osnovnogo_endpointa_perehodit_na_api_vk_com(client, mock_vk):
    """id.vk.ru недоступен → успешный fallback на api.vk.com/method/users.get."""
    state = mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров", fail_primary=True)

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 200, f"fallback не отработал: {r.text}"
    assert len(state["requests"]) == 2, f"ожидали два обращения к VK: {state['requests']}"
    assert "id.vk.ru/oauth2/user_info" in state["requests"][0], "первым должен идти id.vk.ru"
    assert "api.vk.com/method/users.get" in state["requests"][1], "вторым должен идти api.vk.com"
    uid = _sub(r.json()["access_token"])
    contact = db.get_contact(uid)
    assert contact.kkr_name == "Пётр Сидоров", "ФИО из fallback-ответа не применены"
    assert contact.email == "vk_777@vk.com", "api.vk.com не отдаёт email → нужен синтетический"
    assert contact.vk == "https://vk.com/id777", "vk-ссылка собрана неверно во fallback"


def test_fallback_beret_photo_max_i_mobile_phone(client, mock_vk, mock_s3):
    """Во fallback-ветке аватар берётся из photo_max, телефон — из mobile_phone."""
    mock_vk(
        user_id="777",
        fail_primary=True,
        avatar="https://sun1.vk.com/max.jpg?cs=400x400",
        phone="79995554433",
    )

    r = _post(client, access_token="vk-access-token")
    uid = _sub(r.json()["access_token"])

    assert mock_s3["upload"] == [
        {"url": "https://sun1.vk.com/max.jpg?cs=150x150", "folder": "avatars"}
    ], f"аватар из photo_max не обработан: {mock_s3['upload']}"
    assert db.get_contact(uid).phone == "+79995554433", "mobile_phone не попал в контакт"


def test_oba_endpointa_nedostupny_401(client, mock_vk):
    """Оба обращения к VK упали → 401 'Failed to verify VK token', ничего не создано."""
    state = mock_vk(fail_all=True)

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json() == {"detail": "Failed to verify VK token"}, "неверное тело ошибки"
    assert len(state["requests"]) == 2, "должны быть попытаны оба эндпоинта VK"
    assert db.list_contacts() == [], "при провале верификации создан пользователь"
    assert _refresh_rows() == 0, "при провале верификации выдан refresh-токен"


def test_pustoy_user_id_401(client, mock_vk):
    """VK ответил успешно, но без user_id → 401 'Could not identify VK user'."""
    mock_vk(user_id="")

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json() == {"detail": "Could not identify VK user"}, "неверное тело ошибки"
    assert db.list_contacts() == [], "создан пользователь без VK id"
    assert _refresh_rows() == 0, "выдан refresh-токен без идентификации пользователя"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: vk_id = str(vk_user.get('user_id')) превращает отсутствующий id в строку 'None', "
           "которая проходит проверку `if not vk_id` и создаёт аккаунт с "
           "vk=https://vk.com/idNone (main.py:390, 432)",
)
def test_otsutstvuyushchiy_user_id_401(client, mock_vk):
    """Ключ user_id = null в ответе VK — это тоже 'Could not identify VK user'."""
    mock_vk(user_id=None)

    r = _post(client, access_token="vk-access-token")

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json() == {"detail": "Could not identify VK user"}, "неверное тело ошибки"
    assert db.list_contacts() == [], "создан аккаунт без реального VK id"


# ─────────────────────────────────────────────────────────────
#  7. Валидация тела запроса
# ─────────────────────────────────────────────────────────────
def test_bez_access_token_422(client, mock_vk):
    """Обязательное поле access_token отсутствует → 422 от pydantic."""
    mock_vk()

    r = client.post(URL, json={})

    assert r.status_code == 422, f"ожидали 422, получили {r.status_code}: {r.text}"
    errors = r.json()["detail"]
    assert any(e["loc"] == ["body", "access_token"] and e["type"] == "missing" for e in errors), (
        f"нет ошибки о пропущенном access_token: {errors}"
    )
    assert db.list_contacts() == [], "при 422 не должно быть записей в БД"


def test_telo_ne_obekt_422(client, mock_vk):
    """Совсем не тот тип тела → 422."""
    mock_vk()

    r = client.post(URL, json=["access_token"])

    assert r.status_code == 422, f"ожидали 422, получили {r.status_code}: {r.text}"


@pytest.mark.parametrize(
    "body, bad_field",
    [
        ({"access_token": 12345}, "access_token"),
        ({"access_token": None}, "access_token"),
        ({"access_token": ["a"]}, "access_token"),
        ({"access_token": {"a": 1}}, "access_token"),
        ({"access_token": "ok", "id_token": 42}, "id_token"),
        ({"access_token": "ok", "id_token": ["a"]}, "id_token"),
    ],
    ids=["int", "null", "list", "dict", "id_token-int", "id_token-list"],
)
def test_nevernye_tipy_polej_422(client, mock_vk, body, bad_field):
    """Неверные типы полей отсекаются pydantic до похода в VK."""
    state = mock_vk()

    r = client.post(URL, json=body)

    assert r.status_code == 422, f"ожидали 422, получили {r.status_code}: {r.text}"
    assert any(e["loc"] == ["body", bad_field] for e in r.json()["detail"]), (
        f"ошибка указывает не на поле {bad_field}: {r.json()['detail']}"
    )
    assert state["requests"] == [], "при 422 запрос в VK всё-таки ушёл"


def test_lishnie_polya_ignoriruyutsya(client, mock_vk):
    """Неизвестные поля в теле не ломают запрос (pydantic их отбрасывает)."""
    mock_vk(user_id="777")

    r = client.post(URL, json={"access_token": "tok", "admin": True, "user_id": 1})

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    uid = _sub(r.json()["access_token"])
    assert db.get_user(uid).admin is False, "лишнее поле admin=True попало в модель"


@pytest.mark.parametrize(
    "token",
    ["", "   ", "\t\n", "токен-в-юникоде-🎉", "a" * 10000],
    ids=["pustaya-stroka", "probely", "tabulyaciya", "unicode", "ochen-dlinnaya"],
)
def test_access_token_lyuboy_stroki_prohodit_validaciyu(client, mock_vk, token):
    """
    В VKLoginIn нет ни min_length, ни strip — любая строка уходит в VK как есть.

    Тест фиксирует отсутствие серверной валидации: пустая строка и пробелы
    доходят до внешнего сервиса (см. отчёт о дефектах).
    """
    state = mock_vk(user_id="777")

    r = _post(client, access_token=token)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert len(state["requests"]) == 1, "ожидался ровно один поход в VK"


def test_id_token_neobyazatelen(client, mock_vk):
    """id_token = null — валидное тело."""
    mock_vk(user_id="777")

    r = client.post(URL, json={"access_token": "tok", "id_token": None})

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"


# ─────────────────────────────────────────────────────────────
#  8. id_token: подпись не проверяется
# ─────────────────────────────────────────────────────────────
def test_musornyy_id_token_ne_lomaet_endpoint(client, mock_vk):
    """Нераспарсиваемый id_token проглатывается, данные берутся из VK API."""
    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров")

    r = _post(client, access_token="tok", id_token="это-вообще-не-jwt")

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    uid = _sub(r.json()["access_token"])
    assert db.get_contact(uid).kkr_name == "Пётр Сидоров", "данные должны прийти из VK API"


@pytest.mark.xfail(
    strict=True,
    reason="УЯЗВИМОСТЬ: jwt.get_unverified_claims читает id_token БЕЗ проверки подписи, "
           "поэтому email из подделанного JWT позволяет войти в чужой аккаунт "
           "(main.py:361-362 → main.py:441-443)",
)
def test_podpisannyy_chuzhim_klyuchom_id_token_ne_daet_zahvatit_akkaunt(client, mock_vk, make_user):
    """Claims из JWT с чужой подписью не должны определять, в чей аккаунт мы входим."""
    victim = make_user(email="victim@test.ru", name="Жертва", surname="Жертвина")
    mock_vk(user_id="777", first_name="Злоу", last_name="Мышленник")
    forged = _foreign_id_token({"email": "victim@test.ru", "first_name": "Злоу", "last_name": "Мышленник"})

    r = _post(client, access_token="tok", id_token=forged)

    assert _sub(r.json()["access_token"]) != victim.user_id, (
        "подделанный id_token дал доступ к чужому аккаунту"
    )


@pytest.mark.xfail(
    strict=True,
    reason="УЯЗВИМОСТЬ: JWT с alg=none и пустой подписью принимается как источник email "
           "(main.py:361-362)",
)
def test_id_token_bez_podpisi_ne_ispolzuetsya(client, mock_vk):
    """JWT с alg=none вообще не имеет подписи — его claims нельзя использовать."""
    mock_vk(user_id="777")
    unsigned = _unsigned_id_token({"email": "podmena@evil.ru"})

    r = _post(client, access_token="tok", id_token=unsigned)
    uid = _sub(r.json()["access_token"])

    assert db.get_contact(uid).email == "vk_777@vk.com", (
        "email взят из неподписанного id_token вместо синтетического"
    )


def test_telefon_iz_id_token_ispolzuetsya_esli_vk_ego_ne_vernul(client, mock_vk):
    """
    Фиксируем фактический поток данных: phone из id_token доживает до контакта,
    если VK API телефон не отдал. Подпись id_token при этом не проверяется.
    """
    mock_vk(user_id="777")
    token = _unsigned_id_token({"phone": "79998887766"})

    r = _post(client, access_token="tok", id_token=token)
    uid = _sub(r.json()["access_token"])

    assert db.get_contact(uid).phone == "+79998887766", "телефон из id_token не применён"


# ─────────────────────────────────────────────────────────────
#  9. Утечка и инъекция access_token
# ─────────────────────────────────────────────────────────────
@pytest.mark.xfail(
    strict=True,
    reason="БАГ: access_token подставляется в URL fallback-запроса f-строкой без "
           "urllib.parse.quote — символы & и = позволяют дописать чужие query-параметры "
           "(main.py:405)",
)
def test_access_token_ekraniruetsya_v_url_fallbacka(client, mock_vk):
    """Токен обязан быть закодирован, иначе в запрос к VK можно вписать свои параметры."""
    from urllib.parse import parse_qs, urlparse

    state = mock_vk(user_id="777", fail_primary=True)

    _post(client, access_token="tok&user_ids=1&v=5.199")

    fallback_url = state["requests"][1]
    query = parse_qs(urlparse(fallback_url).query)
    assert query.get("access_token") == ["tok&user_ids=1&v=5.199"], "токен не экранирован"
    assert "user_ids" not in query, "через access_token в запрос внедрён чужой параметр"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: логгирование секрета — logging.info пишет сырой VK access_token в логи "
           "приложения (main.py:382)",
)
def test_access_token_ne_popadaet_v_logi(client, mock_vk, caplog):
    """Секрет пользователя не должен утекать в логи."""
    mock_vk(user_id="777")
    secret = "super-secret-vk-access-token"

    with caplog.at_level(logging.INFO):
        _post(client, access_token=secret)

    assert all(secret not in rec.getMessage() for rec in caplog.records), (
        "VK access_token найден в логах"
    )


# ─────────────────────────────────────────────────────────────
#  10. Эндпоинт публичный: заголовок Authorization не влияет
# ─────────────────────────────────────────────────────────────
def test_bez_zagolovka_authorization_rabotaet(client, mock_vk, anon):
    """Эндпоинт публичный — токен не нужен."""
    mock_vk(user_id="777")

    r = client.post(URL, json={"access_token": "tok"}, headers=anon)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"


@pytest.mark.parametrize(
    "header_kind",
    ["musor", "bez-bearer", "prosrochennyy", "tipa-refresh", "chuzhaya-podpis", "udalennyy-user"],
)
def test_nekorrektnyy_authorization_ignoriruetsya(
    client,
    mock_vk,
    make_user,
    expired_access_token,
    refresh_typed_token,
    foreign_signed_token,
    header_kind,
):
    """Любой мусор в Authorization не должен влиять на публичный /auth/vk."""
    holder = make_user(email="holder@test.ru", name="Держатель", surname="Токенов")
    if header_kind == "musor":
        value = "Bearer not-a-token"
    elif header_kind == "bez-bearer":
        value = holder.access_token
    elif header_kind == "prosrochennyy":
        value = f"Bearer {expired_access_token(holder.user_id)}"
    elif header_kind == "tipa-refresh":
        value = f"Bearer {refresh_typed_token(holder.user_id)}"
    elif header_kind == "chuzhaya-podpis":
        value = f"Bearer {foreign_signed_token(holder.user_id)}"
    else:
        db.delete_user(holder.user_id)
        value = f"Bearer {holder.access_token}"

    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров")

    r = client.post(URL, json={"access_token": "tok"}, headers={"Authorization": value})

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    uid = _sub(r.json()["access_token"])
    assert db.get_contact(uid).kkr_name == "Пётр Сидоров", "личность определена не по данным VK"


def test_zabanennyy_v_zagolovke_ne_meshaet_chuzhomu_vhodu(client, mock_vk, banned_user):
    """Чужой забаненный access-токен в заголовке не блокирует вход другого VK-пользователя."""
    mock_vk(user_id="777", first_name="Пётр", last_name="Сидоров")

    r = client.post(URL, json={"access_token": "tok"}, headers=banned_user.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert _sub(r.json()["access_token"]) != banned_user.user_id, "выдан токен забаненного аккаунта"


# ─────────────────────────────────────────────────────────────
#  11. Юникод и экстремальные значения от VK
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "first_name, last_name",
    [
        ("Ярослав", "Мудрый"),
        ("🎉", "🚀"),
        ("A" * 500, "B" * 500),
        ("  Пётр  ", "  Сидоров  "),
    ],
    ids=["kirillica", "emoji", "ochen-dlinnye", "s-probelami"],
)
def test_imena_iz_vk_sohranyayutsya_kak_est(client, mock_vk, first_name, last_name):
    """Имя/фамилия из VK кладутся в контакт без санитизации, kkr_name = 'name surname'."""
    mock_vk(user_id="777", first_name=first_name, last_name=last_name)

    r = _post(client, access_token="tok")
    uid = _sub(r.json()["access_token"])

    contact = db.get_contact(uid)
    assert contact.name == first_name, "имя изменено при сохранении"
    assert contact.surname == last_name, "фамилия изменена при сохранении"
    assert contact.kkr_name == f"{first_name} {last_name}".strip(), "kkr_name собран неверно"
