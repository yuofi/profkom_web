"""
Тесты профильных ручек:

    GET    /api/profile/me          (main.py:562)
    GET    /api/profile/{user_id}   (main.py:580)
    PATCH  /api/profile/{user_id}   (main.py:591)
    DELETE /api/profile/{user_id}   (main.py:638)

Тесты, помеченные ``xfail(strict=True)``, описывают КОРРЕКТНОЕ поведение,
которого бэкенд сегодня не даёт. Они станут «красными» ровно в тот момент,
когда баг починят и забудут снять маркер, — это и есть цель.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

import database as database_module
from database import db

API = "/api/profile"


# ─────────────────────────────────────────────────────────────
#  Вспомогательные функции работы с базой напрямую
# ─────────────────────────────────────────────────────────────
def _drop_contact(user_id: int) -> None:
    """Удаляет строку contact_info, оставляя пользователя, — воспроизводит рассинхрон базы."""
    with database_module.engine.begin() as conn:
        conn.execute(text("DELETE FROM contact_info WHERE user_id = :u"), {"u": user_id})


def _refresh_token_count(user_id: int) -> int:
    with database_module.engine.begin() as conn:
        return conn.execute(
            text("SELECT COUNT(*) FROM refresh_tokens WHERE user_id = :u"), {"u": user_id}
        ).scalar_one()


def _contact_row_exists(user_id: int) -> bool:
    with database_module.engine.begin() as conn:
        return (
            conn.execute(
                text("SELECT COUNT(*) FROM contact_info WHERE user_id = :u"), {"u": user_id}
            ).scalar_one()
            > 0
        )


MISSING_ID = 987654


# ═════════════════════════════════════════════════════════════
#  GET /api/profile/me
# ═════════════════════════════════════════════════════════════
ME_FIELDS = {
    "user_id": int,
    "email": str,
    "surname": str,
    "name": str,
    "patronymic": str,
    "kkr_name": str,
    "group_number": str,
    "location": str,
    "blocks": str,
    "phone": str,
    "vk": str,
    "tg": str,
    "budget": bool,
    "in_profcom": bool,
    "photo_url": str,
    "banned": bool,
    "super_user": bool,
    "admin": bool,
    "pgas_admin": bool,
    "has_password": bool,
    "participation_periods": list,
}


def test_me_счастливый_путь_полная_схема_ответа(client, make_user):
    """GET /profile/me отдаёт 200 и ВСЕ поля MeOut с правильными типами."""
    actor = make_user(
        email="me@test.ru",
        name="Иван",
        surname="Петров",
        patronymic="Сергеевич",
        group_number="205",
        location="ДСВ",
        phone="+79990001122",
        vk="ivan",
        tg="@ivan_tg",
        budget=True,
        in_profcom=True,
    )

    resp = client.get(f"{API}/me", headers=actor.headers)

    assert resp.status_code == 200, f"ожидали 200, получили {resp.status_code}: {resp.text}"
    body = resp.json()

    assert set(body) == set(ME_FIELDS), (
        "набор полей MeOut отличается от ожидаемого; "
        f"лишние={set(body) - set(ME_FIELDS)}, недостающие={set(ME_FIELDS) - set(body)}"
    )
    for field, expected_type in ME_FIELDS.items():
        assert isinstance(body[field], expected_type), (
            f"поле {field!r} должно быть типа {expected_type.__name__}, "
            f"а пришло {type(body[field]).__name__}"
        )

    assert body["user_id"] == actor.user_id, "user_id должен совпадать с id владельца токена"
    assert body["email"] == "me@test.ru", "почта должна прийти из contact_info"
    assert body["name"] == "Иван", "имя должно прийти из contact_info"
    assert body["surname"] == "Петров", "фамилия должна прийти из contact_info"
    assert body["patronymic"] == "Сергеевич", "отчество должно прийти из contact_info"
    assert body["kkr_name"] == "Иван Петров", "kkr_name собирается как 'имя фамилия'"
    assert body["group_number"] == "205", "группа в MeOut — строка"
    assert body["location"] == "ДСВ", "место проживания должно прийти из contact_info"
    assert body["phone"] == "+79990001122", "телефон должен прийти из contact_info"
    assert body["vk"] == "ivan", "vk должен прийти из contact_info"
    assert body["tg"] == "@ivan_tg", "tg должен прийти из contact_info"
    assert body["budget"] is True, "бюджет должен прийти из contact_info"
    assert body["in_profcom"] is True, "признак профкома должен прийти из contact_info"
    assert "kkr_score" not in body, "у нового пользователя ККР-счёт равен нулю"
    assert body["banned"] is False, "новый пользователь не забанен"
    assert body["super_user"] is False, "новый пользователь не суперюзер"
    assert body["admin"] is False, "новый пользователь не админ"
    assert body["has_password"] is True, "у парольного аккаунта has_password=True"


def test_me_photo_url_отдаётся_из_строки_users(client, make_user):
    """photo_url хранится в users, но попадает в MeOut."""
    actor = make_user(photo_url="https://global.s3.cloud.ru/test-bucket/avatars/a.jpg")

    body = client.get(f"{API}/me", headers=actor.headers).json()

    assert "get_object" in body["photo_url"], (
        "photo_url должен подтягиваться из строки users"
    )


def test_me_has_password_false_для_vk_аккаунта(client, make_user):
    """Аккаунт без пароля (вход только через VK) отдаёт has_password=False."""
    actor = make_user(password=None)

    body = client.get(f"{API}/me", headers=actor.headers).json()

    assert body["has_password"] is False, (
        "у аккаунта с пустым hashed_password has_password обязан быть False"
    )


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({}, {"admin": False, "super_user": False}),
        ({"admin": True}, {"admin": True, "super_user": False}),
        ({"super_user": True}, {"admin": False, "super_user": True}),
        ({"admin": True, "super_user": True}, {"admin": True, "super_user": True}),
    ],
    ids=["обычный", "админ", "суперюзер", "админ+суперюзер"],
)
def test_me_флаги_ролей_повторяют_базу(client, make_user, kwargs, expected):
    """Ролевые флаги в MeOut берутся из строки users один в один."""
    actor = make_user(**kwargs)

    body = client.get(f"{API}/me", headers=actor.headers).json()

    assert body["admin"] is expected["admin"], "флаг admin должен повторять базу"
    assert body["super_user"] is expected["super_user"], "флаг super_user должен повторять базу"
    row = db.get_user(actor.user_id)
    assert body["admin"] is row.admin and body["super_user"] is row.super_user, (
        "ответ разошёлся с фактическим состоянием базы"
    )


def test_me_скрывает_ккр_от_обычного_владельца(client, make_user):
    actor=make_user()
    db.update_user(actor.user_id,kkr_score=42)
    r=client.get(f'{API}/me',headers=actor.headers)
    assert r.status_code==200 and 'kkr_score' not in r.json()


def test_me_без_токена_401(client, anon):
    """Без заголовка Authorization — 401 Not authenticated."""
    resp = client.get(f"{API}/me", headers=anon)

    assert resp.status_code == 401, "анонимный запрос к /profile/me обязан отбиваться"
    assert resp.json()["detail"] == "Not authenticated", "текст ошибки FastAPI-схемы OAuth2"


@pytest.mark.parametrize(
    ("header", "detail"),
    [
        ("Bearer", "Access token invalid or expired"),
        ("Bearer ", "Access token invalid or expired"),
        ("Basic YWJjOmRlZg==", "Not authenticated"),
        ("Bearer not.a.jwt", "Access token invalid or expired"),
        ("Bearer aaa.bbb.ccc", "Access token invalid or expired"),
    ],
    ids=["пустой-bearer", "bearer-с-пробелом", "чужая-схема", "мусор", "похоже-на-jwt"],
)
def test_me_битый_заголовок_401(client, header, detail):
    """Некорректный Authorization-заголовок — всегда 401 с ожидаемым detail."""
    resp = client.get(f"{API}/me", headers={"Authorization": header})

    assert resp.status_code == 401, f"заголовок {header!r} не должен пускать в /profile/me"
    assert resp.json()["detail"] == detail, f"неожиданный detail для заголовка {header!r}"


def test_me_протухший_токен_401(client, user, expired_access_token):
    """Валидно подписанный, но просроченный access-токен не принимается."""
    token = expired_access_token(user.user_id)

    resp = client.get(f"{API}/me", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 401, "просроченный токен обязан отбиваться"
    assert resp.json()["detail"] == "Access token invalid or expired", "неожиданный detail"


def test_me_refresh_типизированный_токен_401(client, user, refresh_typed_token):
    """JWT с type=refresh нельзя использовать как access."""
    token = refresh_typed_token(user.user_id)

    resp = client.get(f"{API}/me", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 401, "refresh-JWT не должен пускать в защищённые ручки"
    assert resp.json()["detail"] == "Not an access token", "неожиданный detail"


def test_me_токен_подписанный_чужим_секретом_401(client, user, foreign_signed_token):
    """Подпись чужим секретом — 401."""
    token = foreign_signed_token(user.user_id)

    resp = client.get(f"{API}/me", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 401, "токен с чужой подписью обязан отбиваться"
    assert resp.json()["detail"] == "Access token invalid or expired", "неожиданный detail"


def test_me_токен_удалённого_пользователя_401(client, user):
    """Токен живёт 30 минут, но пользователя уже нет — 401 User not found."""
    db.delete_user(user.user_id)

    resp = client.get(f"{API}/me", headers=user.headers)

    assert resp.status_code == 401, "токен удалённого пользователя не должен работать"
    assert resp.json()["detail"] == "User not found", "неожиданный detail"


def test_me_забаненный_пользователь_403(client, banned_user):
    """Забаненному отдаём 403 User is banned."""
    resp = client.get(f"{API}/me", headers=banned_user.headers)

    assert resp.status_code == 403, "забаненный пользователь не должен читать свой профиль"
    assert resp.json()["detail"] == "User is banned", "неожиданный detail"


def test_me_без_contact_info_500(client, user):
    """Рассинхрон базы (нет строки contact_info) — 500 с внятным detail."""
    _drop_contact(user.user_id)

    resp = client.get(f"{API}/me", headers=user.headers)

    assert resp.status_code == 500, "без contact_info ручка обязана явно падать"
    assert resp.json()["detail"] == "Contact info missing for user", "неожиданный detail"


# ═════════════════════════════════════════════════════════════
#  GET /api/profile/{user_id}
# ═════════════════════════════════════════════════════════════
PROFILE_FIELDS = {
    "user_id": int,
    "kkr_name": str,
    "group_number": int,
    "blocks": str,
    "photo_url": str,
    "banned": bool,
    "super_user": bool,
    "admin": bool,
    "pgas_admin": bool,
    "email": str,
    "tg": str,
}


def test_профиль_по_id_счастливый_путь(client, make_user):
    """GET /profile/{id} отдаёт 200 и все поля ProfileOut с правильными типами."""
    actor = make_user(
        email="target@test.ru", name="Пётр", surname="Сидоров", tg="@petr_tg", group_number="301"
    )

    resp = client.get(f"{API}/{actor.user_id}", headers=actor.headers)

    assert resp.status_code == 200, f"ожидали 200, получили {resp.status_code}: {resp.text}"
    body = resp.json()

    assert set(body) == set(PROFILE_FIELDS), (
        "набор полей ProfileOut отличается от ожидаемого; "
        f"лишние={set(body) - set(PROFILE_FIELDS)}, недостающие={set(PROFILE_FIELDS) - set(body)}"
    )
    for field, expected_type in PROFILE_FIELDS.items():
        assert isinstance(body[field], expected_type), (
            f"поле {field!r} должно быть типа {expected_type.__name__}, "
            f"а пришло {type(body[field]).__name__}"
        )
    assert body["user_id"] == actor.user_id, "user_id должен совпадать с запрошенным"
    assert body["kkr_name"] == "Пётр Сидоров", "kkr_name берётся из contact_info"
    assert body["email"] == "target@test.ru", "почта берётся из contact_info"
    assert body["tg"] == "@petr_tg", "телеграм берётся из contact_info"
    assert body["group_number"] == 301, "в ProfileOut группа приведена к int"


def test_профиль_по_id_не_отдаёт_хеш_пароля(client, user):
    """ProfileOut строится из user.__dict__ — убеждаемся, что hashed_password не утёк."""
    body = client.get(f"{API}/{user.user_id}", headers=user.headers).json()

    assert "hashed_password" not in body, (
        "хеш пароля не должен попадать в ответ (ProfileOut собирается из user.__dict__)"
    )


def test_профиль_по_id_анонимно_отдаёт_чужую_почту_и_телеграм(client, make_user, anon):
    victim=make_user()
    assert client.get(f'{API}/{victim.user_id}',headers=anon).status_code==401


def test_профиль_по_id_должен_требовать_авторизацию(client, make_user, anon):
    """Правильное поведение: чужой профиль читается только по токену."""
    victim = make_user()

    resp = client.get(f"{API}/{victim.user_id}", headers=anon)

    assert resp.status_code == 401, "чтение чужого профиля обязано требовать авторизации"


def test_профиль_по_id_несуществующий_404(client, user):
    """Несуществующий id — 404 User not found."""
    resp = client.get(f"{API}/{MISSING_ID}", headers=user.headers)

    assert resp.status_code == 404, "для отсутствующего пользователя ожидаем 404"
    assert resp.json()["detail"] == "User not found", "неожиданный detail"


@pytest.mark.parametrize(
    "raw_id",
    ["abc", "1.5", "%20", "-", "1e5", "0x10", "١٢٣"],
    ids=["буквы", "дробное", "пробел", "дефис", "экспонента", "hex", "арабские-цифры"],
)
def test_профиль_по_id_нечисловой_идентификатор_422(client, raw_id, user):
    """Нечисловой path-параметр отбивается pydantic-валидацией пути."""
    resp = client.get(f"{API}/{raw_id}", headers=user.headers)

    assert resp.status_code == 422, f"id={raw_id!r} должен давать 422, а пришло {resp.status_code}"
    assert resp.json()["detail"][0]["loc"] == ["path", "user_id"], (
        "ошибка должна указывать на path-параметр user_id"
    )


@pytest.mark.parametrize("raw_id", ["0", "-1", "-999"], ids=["ноль", "минус-один", "минус-много"])
def test_профиль_по_id_неположительный_идентификатор_404(client, raw_id, user):
    """0 и отрицательные id парсятся как int, пользователя нет — 404."""
    resp = client.get(f"{API}/{raw_id}", headers=user.headers)

    assert resp.status_code == 404, f"id={raw_id!r} должен давать 404"
    assert resp.json()["detail"] == "User not found", "неожиданный detail"


def test_профиль_me_не_перехватывается_маршрутом_по_id(client, anon):
    """/profile/me объявлен раньше /profile/{user_id}, поэтому 'me' не парсится как int."""
    resp = client.get(f"{API}/me", headers=anon)

    assert resp.status_code == 401, (
        "если бы порядок маршрутов был обратным, пришло бы 422 int_parsing"
    )


def test_профиль_по_id_без_contact_info_500(client, user):
    """Пользователь есть, строки contact_info нет — 500 Contact info missing for user."""
    _drop_contact(user.user_id)

    resp = client.get(f"{API}/{user.user_id}", headers=user.headers)

    assert resp.status_code == 500, "рассинхрон базы обязан давать явную 500"
    assert resp.json()["detail"] == "Contact info missing for user", "неожиданный detail"


def test_профиль_по_id_забаненного_виден(client, banned_user, user):
    """Профиль забаненного читается и содержит banned=True."""
    resp = client.get(f"{API}/{banned_user.user_id}", headers=user.headers)

    assert resp.status_code == 200, "профиль забаненного всё ещё читается"
    assert resp.json()["banned"] is True, "флаг banned должен быть виден в ответе"


# ═════════════════════════════════════════════════════════════
#  PATCH /api/profile/{user_id} — авторизация и права
# ═════════════════════════════════════════════════════════════
USEROUT_FIELDS = {
    "user_id": int,
    "kkr_name": str,
    "group_number": int,
    "blocks": str,
    "photo_url": str,
    "banned": bool,
    "super_user": bool,
    "admin": bool,
    "pgas_admin": bool,
}


def test_patch_счастливый_путь_схема_ответа(client, make_user):
    """PATCH себя: 200 и полная схема UserOut с правильными типами."""
    actor = make_user(name="Иван", surname="Петров", group_number="101")

    resp = client.patch(
        f"{API}/{actor.user_id}", headers=actor.headers, json={"phone": "+79990001122"}
    )

    assert resp.status_code == 200, f"ожидали 200, получили {resp.status_code}: {resp.text}"
    body = resp.json()
    assert set(body) == set(USEROUT_FIELDS), (
        "набор полей ответа PATCH отличается от UserOut; "
        f"лишние={set(body) - set(USEROUT_FIELDS)}, недостающие={set(USEROUT_FIELDS) - set(body)}"
    )
    for field, expected_type in USEROUT_FIELDS.items():
        assert isinstance(body[field], expected_type), (
            f"поле {field!r} должно быть типа {expected_type.__name__}, "
            f"а пришло {type(body[field]).__name__}"
        )
    assert body["user_id"] == actor.user_id, "user_id в ответе должен совпадать с целью"
    assert body["kkr_name"] == "Иван Петров", "handler явно докладывает kkr_name в UserOut"
    assert db.get_contact(actor.user_id).phone == "+79990001122", "телефон обязан лечь в базу"


def test_patch_ответ_не_содержит_обновлённых_контактных_полей(client, user):
    """
    ДЕФЕКТ (main.py:591, 637): response_model=UserOut.

    Ручка правит contact_info, но возвращает только поля строки users
    (плюс kkr_name). Клиент не видит, что записалось в почту/телефон/tg,
    и вынужден делать второй запрос к /profile/me.
    """
    resp = client.patch(
        f"{API}/{user.user_id}",
        headers=user.headers,
        json={"phone": "+70000000000", "tg": "@new_tg", "location": "ГЗ"},
    )

    body = resp.json()
    assert resp.status_code == 200, "запрос успешен"
    for leaked in ("phone", "tg", "location", "email", "surname", "name", "patronymic"):
        assert leaked not in body, (
            f"UserOut не содержит поле {leaked!r} — обновление контактов не видно в ответе"
        )
    assert db.get_contact(user.user_id).tg == "@new_tg", "в базе изменение всё-таки применилось"


def test_patch_без_токена_401(client, user, anon):
    """Аноним не может править чужой профиль."""
    resp = client.patch(f"{API}/{user.user_id}", headers=anon, json={"phone": "1"})

    assert resp.status_code == 401, "PATCH без токена обязан отбиваться"
    assert resp.json()["detail"] == "Not authenticated", "неожиданный detail"
    assert db.get_contact(user.user_id).phone == "", "анонимный запрос не должен ничего писать"


@pytest.mark.parametrize(
    ("token_fixture", "detail"),
    [
        ("expired_access_token", "Access token invalid or expired"),
        ("refresh_typed_token", "Not an access token"),
        ("foreign_signed_token", "Access token invalid or expired"),
    ],
    ids=["протухший", "refresh-типа", "чужая-подпись"],
)
def test_patch_негодный_токен_401(client, user, request, token_fixture, detail):
    """Протухший / refresh-типизированный / чужеподписанный токен не пускает в PATCH."""
    token = request.getfixturevalue(token_fixture)(user.user_id)

    resp = client.patch(
        f"{API}/{user.user_id}",
        headers={"Authorization": f"Bearer {token}"},
        json={"phone": "+79990000000"},
    )

    assert resp.status_code == 401, f"токен {token_fixture} не должен приниматься"
    assert resp.json()["detail"] == detail, "неожиданный detail"
    assert db.get_contact(user.user_id).phone == "", "отклонённый запрос не должен писать в базу"


def test_patch_токеном_удалённого_пользователя_401(client, user, make_user):
    """Пользователь удалён, токен ещё не истёк — 401 User not found."""
    victim = make_user()
    db.delete_user(user.user_id)

    resp = client.patch(f"{API}/{victim.user_id}", headers=user.headers, json={"phone": "1"})

    assert resp.status_code == 401, "токен удалённого пользователя не должен работать"
    assert resp.json()["detail"] == "User not found", "неожиданный detail"
    assert db.get_contact(victim.user_id).phone == "", "жертва не должна быть изменена"


def test_patch_забаненный_403(client, banned_user):
    """Забаненный не может править даже сам себя."""
    resp = client.patch(
        f"{API}/{banned_user.user_id}", headers=banned_user.headers, json={"phone": "+7"}
    )

    assert resp.status_code == 403, "забаненный не должен править профиль"
    assert resp.json()["detail"] == "User is banned", "неожиданный detail"
    assert db.get_contact(banned_user.user_id).phone == "", "запись не должна была произойти"


def test_patch_себя_разрешён(client, user):
    """Обычный пользователь правит собственный профиль."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"location": "ДСЛ"})

    assert resp.status_code == 200, "правка своего профиля должна быть разрешена"
    assert db.get_contact(user.user_id).location == "ДСЛ", "изменение обязано лечь в базу"


def test_patch_чужого_профиля_обычным_пользователем_403(client, user, make_user):
    """Обычный пользователь НЕ может править чужой профиль — 403 Forbidden."""
    victim = make_user(location="ГЗ")

    resp = client.patch(f"{API}/{victim.user_id}", headers=user.headers, json={"location": "взлом"})

    assert resp.status_code == 403, "чужой профиль обычному пользователю недоступен"
    assert resp.json()["detail"] == "Forbidden", "неожиданный detail"
    assert db.get_contact(victim.user_id).location == "ГЗ", "чужие данные не должны измениться"


@pytest.mark.parametrize("role", ["admin", "superuser"], ids=["админ", "суперюзер"])
def test_patch_чужого_профиля_привилегированным_запрещён(client, request, make_user, role):
    actor=request.getfixturevalue(role);victim=make_user();old=db.get_contact(victim.user_id).location
    r=client.patch(f'{API}/{victim.user_id}',headers=actor.headers,json={'location':'Unwanted edit'})
    assert r.status_code==403 and db.get_contact(victim.user_id).location==old


def test_patch_несуществующего_пользователя_404(client, superuser):
    r=client.patch(f'{API}/{MISSING_ID}',headers=superuser.headers,json={'phone':'1'})
    assert r.status_code==403


def test_patch_чужого_несуществующего_id_отвечает_404_а_не_403(client, user):
    assert client.patch(f'{API}/{MISSING_ID}',headers=user.headers,json={}).status_code==403


def test_patch_не_должен_различать_отсутствие_цели_и_отсутствие_прав(client, user, make_user):
    """Правильное поведение: непривилегированный получает 403 в обоих случаях."""
    resp = client.patch(f"{API}/{MISSING_ID}", headers=user.headers, json={"phone": "1"})

    assert resp.status_code == 403, "код ответа не должен раскрывать существование чужого id"


# ═════════════════════════════════════════════════════════════
#  PATCH — валидация тела
# ═════════════════════════════════════════════════════════════
def test_patch_пустое_тело_разрешено(client, user):
    """У ProfileUpdate нет обязательных полей — {} проходит как 200."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={})

    assert resp.status_code == 200, "пустой патч допустим — обязательных полей в схеме нет"


def test_patch_без_тела_422(client, user):
    """Совсем отсутствующее тело — 422 (body required)."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, content=b"")

    assert resp.status_code == 422, "без тела запроса ожидаем 422"
    assert resp.json()["detail"][0]["loc"] == ["body"], "ошибка должна указывать на body"


@pytest.mark.parametrize(
    ("payload", "field", "err_type"),
    [
        ({"group_number": 500}, "group_number", "string_type"),
        ({"name": 123}, "name", "string_type"),
        ({"surname": ["Петров"]}, "surname", "string_type"),
        ({"phone": {"n": 1}}, "phone", "string_type"),
        ({"budget": "может быть"}, "budget", "bool_parsing"),
        ({"in_profcom": 2}, "in_profcom", "bool_parsing"),
        ({"in_profcom": "нет"}, "in_profcom", "bool_parsing"),
        ({"photo_url": 5}, "photo_url", "string_type"),
        ({"kkr_name": False}, "kkr_name", "string_type"),
    ],
    ids=[
        "группа-числом",
        "имя-числом",
        "фамилия-списком",
        "телефон-объектом",
        "бюджет-мусор",
        "профком-двойка",
        "профком-по-русски",
        "фото-числом",
        "kkr_name-булев",
    ],
)
def test_patch_неверные_типы_422(client, user, payload, field, err_type):
    """Неправильный тип поля отбивается pydantic-валидацией до записи в базу."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json=payload)

    assert resp.status_code == 422, f"payload {payload} должен отбиваться 422"
    err = resp.json()["detail"][0]
    assert err["loc"] == ["body", field], f"ошибка должна указывать на поле {field}"
    assert err["type"] == ("extra_forbidden" if field in ("in_profcom","photo_url") else err_type), f"ожидали тип ошибки {err_type}, получили {err['type']}"


@pytest.mark.parametrize(
    "bad_email",
    ["", "не-почта", "@test.ru", "user@", "user@@test.ru", "user @test.ru", "user@test", " "],
    ids=["пусто", "без-собаки", "без-локали", "без-домена", "две-собаки", "пробел", "без-тлд", "пробел-один"],
)
def test_patch_некорректная_почта_422(client, user, bad_email):
    """EmailStr отбивает всё, что не похоже на адрес, и в базу ничего не пишет."""
    old_email = db.get_contact(user.user_id).email

    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"email": bad_email})

    assert resp.status_code == 422, f"почта {bad_email!r} должна отбиваться 422"
    assert resp.json()["detail"][0]["loc"] == ["body", "email"], "ошибка должна указывать на email"
    assert db.get_contact(user.user_id).email == old_email, "почта в базе не должна измениться"


def test_patch_невалидный_json_422(client, user):
    """Синтаксически битый JSON — 422, а не 500."""
    resp = client.patch(
        f"{API}/{user.user_id}",
        headers={**user.headers, "Content-Type": "application/json"},
        content="{не json".encode("utf-8"),
    )

    assert resp.status_code == 422, "битый JSON должен отбиваться 422"


def test_patch_неизвестные_поля_отклоняются_без_повышения_прав(client, user):
    """
    Попытка передать admin/super_user/banned/kkr_score в теле.

    ProfileUpdate этих полей не содержит и (extra='ignore') молча их отбрасывает —
    эскалации привилегий через тело запроса нет.
    """
    resp = client.patch(
        f"{API}/{user.user_id}",
        headers=user.headers,
        json={"admin": True, "super_user": True, "banned": True, "kkr_score": 9999, "user_id": 1},
    )

    assert resp.status_code == 422, "лишние поля просто игнорируются"
    row = db.get_user(user.user_id)
    assert row.admin is False, "через PATCH профиля нельзя стать админом"
    assert row.super_user is False, "через PATCH профиля нельзя стать суперюзером"
    assert row.banned is False, "через PATCH профиля нельзя изменить признак бана"
    assert row.kkr_score == 0, "через PATCH профиля нельзя накрутить ККР-счёт"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("name", "Ёжик🦔"),
        ("surname", "Ли"),
        ("location", "общежитие ДСВ, к. 1234"),
        ("phone", "+7 (999) 000-11-22"),
        ("vk", "https://vk.com/id1"),
        ("tg", "@valid_user"),
        ("kkr_name", "Имя Фамилия"),
    ],
    ids=["юникод-эмодзи", "короткая-фамилия", "кириллица-с-запятой", "телефон-с-форматом", "ссылка", "тг-имя", "kkr_name"],
)
def test_patch_юникод_и_свободный_текст_сохраняются(client, user, field, value):
    """Свободные текстовые поля не валидируются и сохраняются как есть."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={field: value})

    assert resp.status_code == 200, f"поле {field}={value!r} должно приниматься"
    assert getattr(db.get_contact(user.user_id), field) == value, (
        f"значение поля {field} обязано лечь в базу без изменений"
    )


def test_patch_очень_длинные_строки_принимаются_без_ограничений(client, user):
    """
    ДЕФЕКТ: в ProfileUpdate нет ни одного max_length.

    Строка в 20 000 символов спокойно уезжает в SQLite — любой авторизованный
    пользователь может раздувать базу и ломать вёрстку фронта.
    """
    long_value = "я" * 20000

    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"location": long_value})

    assert resp.status_code == 200, "бэкенд принимает строку любой длины"
    assert db.get_contact(user.user_id).location == long_value, (
        "и честно кладёт её в базу — ограничения длины отсутствуют"
    )


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n"], ids=["пусто", "пробелы", "таб", "перевод-строки"])
def test_patch_пустые_и_пробельные_строки_записываются_как_есть(client, user, blank):
    """Пустая строка — валидное значение: db.update_contact пропускает только None."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"location": blank})

    assert resp.status_code == 200, f"значение {blank!r} принимается"
    assert db.get_contact(user.user_id).location == blank, (
        "пустая/пробельная строка перетирает прежнее значение (None-семантика только у null)"
    )


def test_patch_null_не_перетирает_значение(client, user):
    """null означает «не трогать»: db.update_contact пропускает None."""
    client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"location": "ГЗ"})

    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"location": None})

    assert resp.status_code == 200, "null допустим"
    assert db.get_contact(user.user_id).location == "ГЗ", "null не должен ничего перетирать"


# ═════════════════════════════════════════════════════════════
#  PATCH — kkr_name, частичность, побочные эффекты
# ═════════════════════════════════════════════════════════════
def test_patch_kkr_name_пересчитывается_из_имени_и_фамилии(client, user):
    """При смене имени и фамилии kkr_name собирается как 'имя фамилия'."""
    resp = client.patch(
        f"{API}/{user.user_id}", headers=user.headers, json={"name": "Анна", "surname": "Смирнова"}
    )

    assert resp.status_code == 200, "смена ФИО разрешена"
    assert resp.json()["kkr_name"] == "Анна Смирнова", "kkr_name в ответе должен быть пересчитан"
    assert db.get_contact(user.user_id).kkr_name == "Анна Смирнова", "и записан в базу"


def test_patch_kkr_name_пересчитывается_при_частичной_смене_имени(client, make_user):
    """Передано только имя — фамилия берётся из текущего contact_info."""
    actor = make_user(name="Иван", surname="Петров", kkr_name="Иван Петров")

    resp = client.patch(f"{API}/{actor.user_id}", headers=actor.headers, json={"name": "Пётр"})

    assert resp.json()["kkr_name"] == "Пётр Петров", (
        "недостающая часть ФИО должна подтягиваться из базы"
    )


def test_patch_явный_kkr_name_побеждает_пересчёт(client, user):
    """Если kkr_name передан явно — он важнее вычисленного из ФИО."""
    resp = client.patch(
        f"{API}/{user.user_id}",
        headers=user.headers,
        json={"name": "Анна", "surname": "Смирнова", "kkr_name": "Аня Смирнова"},
    )

    assert resp.json()["kkr_name"] == "Аня Смирнова", "явный kkr_name должен иметь приоритет"
    assert db.get_contact(user.user_id).kkr_name == "Аня Смирнова", "и лечь в базу"


def test_patch_пробельные_имя_и_фамилия_обнуляют_kkr_name(client, user):
    """Части ФИО из одних пробелов выбрасываются — kkr_name становится пустым."""
    resp = client.patch(
        f"{API}/{user.user_id}", headers=user.headers, json={"name": "   ", "surname": "\t"}
    )

    assert resp.status_code == 200, "запрос принимается"
    assert resp.json()["kkr_name"] == "", "из пробельных частей собирается пустой kkr_name"
    assert db.get_contact(user.user_id).kkr_name == "", (
        "пустой kkr_name записывается в NOT NULL-колонку — пользователь теряет ключ прав"
    )


def test_patch_имя_и_фамилия_обрезаются_только_по_краям_итоговой_строки(client, user):
    """Внутренние пробелы частей ФИО сохраняются в contact_info, но не в kkr_name."""
    resp = client.patch(
        f"{API}/{user.user_id}", headers=user.headers, json={"name": "  Анна ", "surname": " Смирнова  "}
    )

    assert resp.json()["kkr_name"] == "Анна Смирнова", "kkr_name склеивается из strip'нутых частей"
    contact = db.get_contact(user.user_id)
    assert contact.name == "  Анна ", "в contact_info имя сохраняется как прислали, без strip"
    assert contact.surname == " Смирнова  ", "в contact_info фамилия сохраняется как прислали"


def test_patch_частичное_обновление_не_трогает_остальные_поля(client, make_user):
    """Патч одного поля не должен затирать соседние."""
    actor = make_user(
        email="keep@test.ru",
        name="Иван",
        surname="Петров",
        patronymic="Сергеевич",
        location="ГЗ",
        phone="+79990000000",
        vk="ivan",
        tg="@ivan",
        in_profcom=True,
        budget=True,
        group_number="101",
    )

    resp = client.patch(f"{API}/{actor.user_id}", headers=actor.headers, json={"vk": "ivan2"})

    assert resp.status_code == 200, "частичный патч должен проходить"
    contact = db.get_contact(actor.user_id)
    assert contact.vk == "ivan2", "изменённое поле обязано обновиться"
    assert contact.email == "keep@test.ru", "почта не должна пострадать"
    assert contact.name == "Иван", "имя не должно пострадать"
    assert contact.surname == "Петров", "фамилия не должна пострадать"
    assert contact.patronymic == "Сергеевич", "отчество не должно пострадать"
    assert contact.location == "ГЗ", "место проживания не должно пострадать"
    assert contact.phone == "+79990000000", "телефон не должен пострадать"
    assert contact.tg == "@ivan", "телеграм не должен пострадать"
    assert contact.in_profcom is True, "признак профкома не должен пострадать"
    assert contact.budget is True, "признак бюджета не должен пострадать"
    assert contact.group_number == "101", "группа не должна пострадать"


def test_patch_идемпотентен_при_повторе(client, user):
    """Два одинаковых патча подряд дают одинаковый результат."""
    payload = {"name": "Анна", "surname": "Смирнова", "location": "ДСВ"}

    first = client.patch(f"{API}/{user.user_id}", headers=user.headers, json=payload)
    second = client.patch(f"{API}/{user.user_id}", headers=user.headers, json=payload)

    assert first.status_code == second.status_code == 200, "оба запроса успешны"
    assert first.json() == second.json(), "повтор того же патча не должен менять ответ"
    assert db.get_contact(user.user_id).location == "ДСВ", "состояние базы стабильно"


def test_patch_photo_url_пишется_в_строку_users_а_не_в_contact_info(client, user):
    old=db.get_user(user.user_id).photo_url
    r=client.patch(f'{API}/{user.user_id}',headers=user.headers,json={'photo_url':'https://example.com/arbitrary.png'})
    assert r.status_code==422 and db.get_user(user.user_id).photo_url==old


def test_patch_photo_url_нельзя_сбросить_в_null(client, user):
    r=client.patch(f'{API}/{user.user_id}',headers=user.headers,json={'photo_url':None})
    assert r.status_code==422


def test_patch_group_number_дублируется_в_обе_таблицы(client, user):
    """group_number пишется и в contact_info, и в users."""
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"group_number": "317"})

    assert resp.status_code == 200, "смена группы разрешена"
    assert resp.json()["group_number"] == 317, "в UserOut группа приводится к int"
    assert db.get_contact(user.user_id).group_number == "317", "группа обязана лечь в contact_info"
    assert db.get_user(user.user_id).group_number == "317", "группа обязана лечь в users"


@pytest.mark.parametrize("group", ["99999", "99", "0", "701"])
def test_patch_group_number_вне_диапазона_регистрации_даёт_422(client, user, group):
    """Профиль проверяет группу тем же правилом 100–700, что регистрация и заявка (A-ROL-17)."""
    before = db.get_contact(user.user_id).group_number
    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"group_number": group})

    assert resp.status_code == 422, resp.text
    assert db.get_contact(user.user_id).group_number == before, "база не должна меняться"


def test_patch_нечисловая_группа_должна_отбиваться_422(client, user):
    """Правильное поведение: 'не-число' — это 422, и база не меняется."""
    try:
        status = client.patch(
            f"{API}/{user.user_id}", headers=user.headers, json={"group_number": "не-число"}
        ).status_code
    except Exception:  # noqa: BLE001 — handler падает ДО формирования ответа
        status = 500

    assert db.get_user(user.user_id).group_number == "101", (
        "невалидная группа не должна была попасть в строку users"
    )
    assert db.get_contact(user.user_id).group_number == "101", (
        "невалидная группа не должна была попасть в contact_info"
    )
    assert status == 422, "нечисловая группа обязана отбиваться валидацией запроса"


def test_patch_нечисловая_группа_ломает_чтение_профиля_навсегда(client, user):
    old=db.get_user(user.user_id).group_number
    assert client.patch(f'{API}/{user.user_id}',headers=user.headers,json={'group_number':'не-число'}).status_code==422
    assert db.get_user(user.user_id).group_number==old
    assert client.get(f'{API}/me',headers=user.headers).status_code==200


def test_patch_дублирующая_почта_роняет_обработчик(client, make_user):
    a=make_user();b=make_user()
    assert client.patch(f'{API}/{a.user_id}',headers=a.headers,json={'email':b.email}).status_code==409
    assert db.get_contact(a.user_id).email==a.email


def test_patch_дублирующая_почта_должна_давать_409(client, make_user):
    """Правильное поведение: попытка занять чужую почту — 409, а не падение."""
    make_user(email="taken2@test.ru")
    actor = make_user(email="free2@test.ru")

    resp = client.patch(f"{API}/{actor.user_id}", headers=actor.headers, json={"email": "taken2@test.ru"})

    assert resp.status_code == 409, "конфликт уникальности обязан оформляться как 409"


def test_patch_своя_же_почта_проходит(client, make_user):
    """Отправить собственную текущую почту — не конфликт."""
    actor = make_user(email="same@test.ru")

    resp = client.patch(f"{API}/{actor.user_id}", headers=actor.headers, json={"email": "same@test.ru"})

    assert resp.status_code == 200, "своя же почта не должна считаться занятой"
    assert db.get_contact(actor.user_id).email == "same@test.ru", "почта осталась прежней"


def test_patch_без_contact_info_роняет_обработчик(client, user):
    _drop_contact(user.user_id)
    r=client.patch(f'{API}/{user.user_id}',headers=user.headers,json={'phone':'1'})
    assert r.status_code==500 and r.json()['detail']=='Contact info missing for user'


def test_patch_без_contact_info_должен_давать_понятную_500(client, user):
    """Правильное поведение: тот же явный detail, что и в GET-ручках."""
    _drop_contact(user.user_id)

    resp = client.patch(f"{API}/{user.user_id}", headers=user.headers, json={"phone": "+7"})

    assert resp.status_code == 500, "ожидаем управляемую 500"
    assert resp.json()["detail"] == "Contact info missing for user", "неожиданный detail"


# ═════════════════════════════════════════════════════════════
#  PATCH — эскалация прав через kkr_name и blocks
# ═════════════════════════════════════════════════════════════
def test_patch_kkr_name_не_даёт_мастерство_чужого_блока(
    client, make_user, make_block
):
    from models import Block
    actor=make_user();db.create_block(Block(name='Медиа',master='Мастер Блока'))
    r=client.patch(f'{API}/{actor.user_id}',headers=actor.headers,json={'kkr_name':'Мастер Блока'})
    assert r.status_code==200
    assert not db.is_block_master(actor.user_id,'Медиа') and not db.get_user(actor.user_id).admin


def test_patch_запрещает_прямую_запись_членства(client, make_user, make_block):
    make_block(name='Медиа');actor=make_user()
    r=client.patch(f'{API}/{actor.user_id}',headers=actor.headers,json={'blocks':'Медиа'})
    assert r.status_code==422 and not db.is_block_member(actor.user_id,'Медиа')


def test_patch_несуществующий_блок_игнорируется(client, user, make_block):
    r=client.patch(f'{API}/{user.user_id}',headers=user.headers,json={'blocks':'Unknown'})
    assert r.status_code==422 and db.get_user(user.user_id).blocks==''


def test_patch_неродственного_поля_молча_переписывает_kkr_name(client, make_user, make_block):
    a=make_user(kkr_name='Отдельное имя')
    assert client.patch(f'{API}/{a.user_id}',headers=a.headers,json={'phone':'123'}).status_code==200
    assert db.get_contact(a.user_id).kkr_name=='Отдельное имя'


def test_patch_не_должен_менять_kkr_name_если_его_не_просили(client, make_user):
    """Правильное поведение: патч телефона не трогает kkr_name."""
    actor = make_user(name="Иван", surname="Иванов", kkr_name="Ванёк Мастеров")

    client.patch(f"{API}/{actor.user_id}", headers=actor.headers, json={"phone": "+79990000000"})

    assert db.get_contact(actor.user_id).kkr_name == "Ванёк Мастеров", (
        "kkr_name должен остаться прежним"
    )


def test_patch_kkr_name_сохраняет_явное_назначение_мастера(client, make_master):
    master,b=make_master()
    r=client.patch(f'{API}/{master.user_id}',headers=master.headers,json={'kkr_name':'Другое имя'})
    assert r.status_code==200 and db.is_block_master(master.user_id,b.name)
    assert not db.get_user(master.user_id).admin


# ═════════════════════════════════════════════════════════════
#  DELETE /api/profile/{user_id}
# ═════════════════════════════════════════════════════════════
def test_delete_суперюзером_счастливый_путь(client, superuser, make_user):
    victim=make_user()
    r=client.delete(f'{API}/{victim.user_id}',headers=superuser.headers)
    assert r.status_code==200 and r.json()['account_state']=='archived'


def test_legacy_delete_архивирует_и_отзывает_токены_с_сохранением_контакта(client, superuser, make_user):
    victim=make_user()
    r=client.delete(f'{API}/{victim.user_id}',headers=superuser.headers)
    assert r.status_code==200
    assert db.get_user(victim.user_id).account_state=='archived'
    assert _contact_row_exists(victim.user_id) and _refresh_token_count(victim.user_id)==0


def test_delete_отзывает_все_сессии_а_не_одну(client, superuser, make_user):
    """У пользователя несколько устройств — гасим все refresh-токены."""
    import auth as auth_module

    victim = make_user()
    auth_module.create_token_pair(victim.user_id)
    auth_module.create_token_pair(victim.user_id)
    assert _refresh_token_count(victim.user_id) == 3, "подготовили три активные сессии"

    client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    assert _refresh_token_count(victim.user_id) == 0, "должны быть удалены все сессии"


def test_delete_access_токен_жертвы_перестаёт_работать(client, superuser, make_user):
    """После удаления выданный ранее access-токен отбивается 401 User not found."""
    victim = make_user()

    client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    resp = client.get(f"{API}/me", headers=victim.headers)
    assert resp.status_code == 401, "access-токен удалённого пользователя не должен работать"
    assert resp.json()["detail"] == "Session revoked", "неожиданный detail"


def test_delete_анонимно_401(client, make_user, anon):
    """Без токена — 401, пользователь на месте."""
    victim = make_user()

    resp = client.delete(f"{API}/{victim.user_id}", headers=anon)

    assert resp.status_code == 401, "удаление без токена обязано отбиваться"
    assert resp.json()["detail"] == "Not authenticated", "неожиданный detail"
    assert db.get_user(victim.user_id) is not None, "пользователь не должен быть удалён"


@pytest.mark.parametrize(
    ("role", "detail"),
    [("user", "SuperUser rights required"), ("admin", "SuperUser rights required")],
    ids=["обычный", "админ"],
)
def test_delete_недостаточно_прав_403(client, request, make_user, role, detail):
    """Ни обычный пользователь, ни админ удалять не могут."""
    actor = request.getfixturevalue(role)
    victim = make_user()

    resp = client.delete(f"{API}/{victim.user_id}", headers=actor.headers)

    assert resp.status_code == 403, f"{role} не должен иметь права на удаление"
    assert resp.json()["detail"] == detail, "неожиданный detail"
    assert db.get_user(victim.user_id) is not None, "пользователь не должен быть удалён"


def test_delete_себя_обычным_пользователем_403(client, user):
    """Даже собственный аккаунт обычный пользователь удалить не может."""
    resp = client.delete(f"{API}/{user.user_id}", headers=user.headers)

    assert resp.status_code == 403, "самоудаление требует прав суперюзера"
    assert resp.json()["detail"] == "SuperUser rights required", "неожиданный detail"
    assert db.get_user(user.user_id) is not None, "аккаунт должен остаться"


def test_delete_забаненным_суперюзером_403(client, make_user):
    """Бан сильнее роли: забаненный суперюзер получает 403 User is banned."""
    actor = make_user(super_user=True, banned=True)
    victim = make_user()

    resp = client.delete(f"{API}/{victim.user_id}", headers=actor.headers)

    assert resp.status_code == 403, "забаненный не должен ничего удалять"
    assert resp.json()["detail"] == "User is banned", "проверка бана идёт раньше проверки роли"
    assert db.get_user(victim.user_id) is not None, "жертва должна остаться"


@pytest.mark.parametrize(
    ("token_fixture", "detail"),
    [
        ("expired_access_token", "Access token invalid or expired"),
        ("refresh_typed_token", "Not an access token"),
        ("foreign_signed_token", "Access token invalid or expired"),
    ],
    ids=["протухший", "refresh-типа", "чужая-подпись"],
)
def test_delete_негодный_токен_401(client, superuser, make_user, request, token_fixture, detail):
    """Негодный токен суперюзера не даёт удалить пользователя."""
    victim = make_user()
    token = request.getfixturevalue(token_fixture)(superuser.user_id)

    resp = client.delete(f"{API}/{victim.user_id}", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 401, f"токен {token_fixture} не должен приниматься"
    assert resp.json()["detail"] == detail, "неожиданный detail"
    assert db.get_user(victim.user_id) is not None, "жертва должна остаться"


def test_delete_несуществующего_404(client, superuser):
    """Отсутствующий id — 404 User not found."""
    resp = client.delete(f"{API}/{MISSING_ID}", headers=superuser.headers)

    assert resp.status_code == 404, "ожидаем 404"
    assert resp.json()["detail"] == "Account not found", "неожиданный detail"


def test_legacy_delete_повторяется_без_изменения_архива(client, superuser, make_user):
    """Второй DELETE того же id — 404, а не 200."""
    victim = make_user()

    first = client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)
    second = client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    assert first.status_code == 200, "первое удаление успешно"
    assert second.status_code == 200, "повтор должен давать 404"
    assert second.json()["account_state"] == "archived", "неожиданный detail"


@pytest.mark.parametrize("raw_id", ["abc", "1.5", "me"], ids=["буквы", "дробное", "me"])
def test_delete_нечисловой_идентификатор_422(client, superuser, raw_id):
    """Нечисловой path-параметр — 422 (для 'me' отдельного DELETE-маршрута нет)."""
    resp = client.delete(f"{API}/{raw_id}", headers=superuser.headers)

    assert resp.status_code == 422, f"id={raw_id!r} должен давать 422, а пришло {resp.status_code}"
    assert resp.json()["detail"][0]["loc"] == ["path", "user_id"], (
        "ошибка должна указывать на path-параметр user_id"
    )


def test_legacy_delete_не_архивирует_нынешнего_председателя(client, superuser):
    r=client.delete(f'{API}/{superuser.user_id}',headers=superuser.headers)
    assert r.status_code==409 and db.is_chair(superuser.user_id)


def test_legacy_delete_сохраняет_единственного_председателя(client, superuser):
    r=client.delete(f'{API}/{superuser.user_id}',headers=superuser.headers)
    assert r.status_code==409 and db.is_chair(superuser.user_id)


def test_delete_мастера_блока_оставляет_блок_с_битой_ссылкой(client, superuser, make_master):
    master,b=make_master()
    assert client.delete(f'{API}/{master.user_id}',headers=superuser.headers).status_code==200
    assert db.get_block(b.name).master_user_id is None and not db.is_block_master(master.user_id,b.name)


def test_delete_мастера_должно_очищать_ссылку_в_блоке(client, superuser, make_master):
    """Правильное поведение: после удаления мастера block.master пуст."""
    master, _block = make_master(block_name="Медиа", kkr_name="Мастер Блока")

    client.delete(f"{API}/{master.user_id}", headers=superuser.headers)

    assert db.get_block("Медиа").master == "", "ссылка на удалённого мастера должна быть снята"


def test_delete_мастера_наследуется_новым_однофамильцем(client, superuser, make_master, make_user):
    master,b=make_master(kkr_name='Одинаковое имя')
    client.delete(f'{API}/{master.user_id}',headers=superuser.headers)
    same=make_user(kkr_name='Одинаковое имя')
    assert not db.is_block_master(same.user_id,b.name)


def test_delete_чистит_только_свои_refresh_токены(client, superuser, make_user):
    """Удаление одного пользователя не должно трогать сессии остальных."""
    victim = make_user()
    bystander = make_user()

    client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    assert _refresh_token_count(bystander.user_id) == 1, "чужие сессии не должны пострадать"
    assert db.get_user(bystander.user_id) is not None, "посторонний пользователь на месте"


def test_delete_пользователя_без_contact_info_проходит(client, superuser, make_user):
    """Рассинхрон базы не мешает удалению: delete_user проверяет наличие строк."""
    victim = make_user()
    _drop_contact(victim.user_id)

    resp = client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    assert resp.status_code == 200, "удаление пользователя без contact_info должно проходить"
    assert db.get_user(victim.user_id).account_state == "archived"


def test_delete_не_ходит_в_s3(client, superuser, make_user, mock_s3):
    """Удаление пользователя с аватаром не трогает S3 — файл остаётся сиротой."""
    victim = make_user(photo_url="https://global.s3.cloud.ru/test-bucket/avatars/orphan.jpg")

    client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    assert mock_s3["presigned"] == [], "presigned-ссылки при удалении не запрашиваются"
    assert mock_s3["upload"] == [], "загрузок в S3 при удалении нет"


def test_delete_профиль_становится_недоступен_для_чтения(client, superuser, make_user):
    """После удаления GET /profile/{id} отдаёт 404."""
    victim = make_user()
    assert client.get(f"{API}/{victim.user_id}", headers=superuser.headers).status_code == 200, "до удаления профиль читается"

    client.delete(f"{API}/{victim.user_id}", headers=superuser.headers)

    resp = client.get(f"{API}/{victim.user_id}", headers=superuser.headers)
    assert resp.status_code == 404, "после удаления профиль читаться не должен"
    assert resp.json()["detail"] == "User not found", "неожиданный detail"


def test_legacy_delete_сохраняет_почту_восстановимого_аккаунта(client, superuser, make_user):
    victim=make_user(email='preserved@test.ru')
    client.delete(f'{API}/{victim.user_id}',headers=superuser.headers)
    assert db.get_user_by_email('preserved@test.ru').user_id==victim.user_id


def test_legacy_delete_сохраняет_id_и_отзывает_старый_токен(
    client, superuser, make_user
):
    victim=make_user();client.delete(f'{API}/{victim.user_id}',headers=superuser.headers)
    new=make_user()
    assert new.user_id!=victim.user_id
    assert client.get(f'{API}/me',headers=victim.headers).status_code==401
