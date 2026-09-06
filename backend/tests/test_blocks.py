"""
Тесты блоков: GET/POST /api/blocks, PATCH/DELETE /api/blocks/{name},
POST /api/blocks/{name}/enter, POST /api/blocks/{name}/exit.

Эндпоинты: main.py:792-859.
Слой данных: database.py:718-855 (create_block/update_block/delete_block/
enter_user_to_block/exit_user_from_block) и синхронизаторы
_sync_users_for_block / _sync_blocks_for_user / _sync_admin_rights.

Договорённость: тесты, помеченные xfail(strict=True), проверяют КОРРЕКТНОЕ
поведение и падают из-за бага в бэкенде. Как только баг починят — маркер
станет XPASS и уронит прогон, чтобы его не забыли снять.
"""
from __future__ import annotations

import json
from urllib.parse import quote

import pytest

from database import db

BLOCK_FIELDS = {"name", "master", "hr", "cnt_of_human", "arr_of_human"}

BLOCKS_URL = "/api/blocks"


# ─────────────────────────────────────────────────────────────
#  Вспомогательные утилиты
# ─────────────────────────────────────────────────────────────
def assert_block_body(body, *, name, master, hr, cnt_of_human, arr_of_human):
    """Полная проверка тела ответа BlockOut: состав полей, типы и значения."""
    assert isinstance(body, dict), f"Ожидался объект блока, получено {type(body)}"
    assert set(body) == BLOCK_FIELDS, (
        f"Состав полей BlockOut изменился: лишние {set(body) - BLOCK_FIELDS}, "
        f"отсутствуют {BLOCK_FIELDS - set(body)}"
    )
    assert isinstance(body["name"], str), "name обязан быть строкой"
    assert isinstance(body["master"], str), "master обязан быть строкой"
    assert isinstance(body["hr"], str), "hr обязан быть строкой"
    assert isinstance(body["cnt_of_human"], int) and not isinstance(body["cnt_of_human"], bool), (
        "cnt_of_human обязан быть целым числом"
    )
    assert isinstance(body["arr_of_human"], list), "arr_of_human обязан быть списком, а не строкой JSON"
    assert all(isinstance(i, int) and not isinstance(i, bool) for i in body["arr_of_human"]), (
        f"arr_of_human обязан содержать только int, получено {body['arr_of_human']}"
    )

    assert body["name"] == name, "неверное имя блока"
    assert body["master"] == master, "неверный master"
    assert body["hr"] == hr, "неверный hr"
    assert body["cnt_of_human"] == cnt_of_human, "неверный cnt_of_human"
    assert sorted(body["arr_of_human"]) == sorted(arr_of_human), "неверный состав arr_of_human"


def raw_arr_of_human(block_name: str) -> str:
    """Сырое значение колонки block.arr_of_human — она хранит JSON-строку."""
    from sqlalchemy import text

    import database as database_module

    with database_module.engine.begin() as conn:
        row = conn.execute(
            text("SELECT arr_of_human FROM block WHERE name = :n"), {"n": block_name}
        ).first()
    return row[0] if row else ""


def user_blocks(user_id: int) -> list[str]:
    u = db.get_user(user_id)
    return [p.strip() for p in (u.blocks or "").split(",") if p.strip()]


def contact_blocks(user_id: int) -> list[str]:
    c = db.get_contact(user_id)
    return [p.strip() for p in (c.blocks or "").split(",") if p.strip()]


# ─────────────────────────────────────────────────────────────
#  Фабрика «плохих» авторизаций (одна таблица на все эндпоинты)
# ─────────────────────────────────────────────────────────────
BAD_AUTH_KINDS = [
    "без_токена",
    "мусор_вместо_схемы",
    "мусор_после_bearer",
    "просроченный_access",
    "refresh_вместо_access",
    "чужая_подпись",
    "токен_удалённого_пользователя",
]


@pytest.fixture
def bad_auth(make_user, expired_access_token, refresh_typed_token, foreign_signed_token):
    """
    Возвращает (headers, ожидаемый_код, ожидаемый_detail) для каждого вида
    некорректной авторизации. Пользователь создаётся с максимальными правами,
    чтобы отказ был именно из-за токена, а не из-за роли.
    """

    def _make(kind: str):
        actor = make_user(super_user=True)
        if kind == "без_токена":
            return {}, 401, "Not authenticated"
        if kind == "мусор_вместо_схемы":
            return {"Authorization": "NotBearer garbage"}, 401, "Not authenticated"
        if kind == "мусор_после_bearer":
            return {"Authorization": "Bearer not.a.jwt"}, 401, "Access token invalid or expired"
        if kind == "просроченный_access":
            token = expired_access_token(actor.user_id)
            return {"Authorization": f"Bearer {token}"}, 401, "Access token invalid or expired"
        if kind == "refresh_вместо_access":
            token = refresh_typed_token(actor.user_id)
            return {"Authorization": f"Bearer {token}"}, 401, "Not an access token"
        if kind == "чужая_подпись":
            token = foreign_signed_token(actor.user_id)
            return {"Authorization": f"Bearer {token}"}, 401, "Access token invalid or expired"
        if kind == "токен_удалённого_пользователя":
            headers = actor.headers
            db.delete_user(actor.user_id)
            return headers, 401, "User not found"
        raise AssertionError(f"неизвестный вид авторизации: {kind}")

    return _make


# ═════════════════════════════════════════════════════════════
#  GET /api/blocks
# ═════════════════════════════════════════════════════════════
def test_список_блоков_пуст_когда_блоков_нет(client, anon):
    """Пустая база → 200 и пустой список, а не 404."""
    r = client.get(BLOCKS_URL, headers=anon)
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert r.json() == [], "при отсутствии блоков список обязан быть пустым"


def test_список_блоков_отдаётся_анониму_целиком(client, anon, make_user, make_block):
    """
    БЕЗ авторизации отдаются имена мастера и HR и список user_id участников.
    Это осознанно зафиксировано тестом: см. отчёт — публичный эндпоинт
    раскрывает персональные данные и внутренние идентификаторы.
    """
    u1 = make_user(name="Иван", surname="Первый")
    u2 = make_user(name="Пётр", surname="Второй")
    make_block(name="Медиа", master="Мастер Мастеров", hr="Эйч Ар", arr_of_human=[u1.user_id, u2.user_id])

    r = client.get(BLOCKS_URL, headers=anon)
    assert r.status_code == 200, f"аноним обязан получать 200, получено {r.status_code}"
    data = r.json()
    assert isinstance(data, list) and len(data) == 1, "ожидался ровно один блок"
    assert_block_body(
        data[0],
        name="Медиа",
        master="Мастер Мастеров",
        hr="Эйч Ар",
        cnt_of_human=2,
        arr_of_human=[u1.user_id, u2.user_id],
    )


def test_список_блоков_возвращает_все_блоки(client, anon, make_block):
    """Каждый созданный блок присутствует в выдаче ровно один раз."""
    for name in ("Медиа", "Спорт", "Наука"):
        make_block(name=name, master="")

    r = client.get(BLOCKS_URL, headers=anon)
    assert r.status_code == 200
    names = sorted(b["name"] for b in r.json())
    assert names == ["Медиа", "Наука", "Спорт"], f"неполная выдача блоков: {names}"


def test_arr_of_human_приходит_списком_чисел_а_не_json_строкой(client, anon, make_user, make_block):
    """В таблице block поле хранится строкой JSON — наружу обязан идти список int."""
    u = make_user()
    make_block(name="Медиа", master="", arr_of_human=[u.user_id])

    assert raw_arr_of_human("Медиа") == json.dumps([u.user_id]), (
        "предусловие теста: в базе значение хранится JSON-строкой"
    )

    body = client.get(BLOCKS_URL, headers=anon).json()[0]
    assert body["arr_of_human"] == [u.user_id], "список участников распакован неверно"
    assert isinstance(body["arr_of_human"][0], int), "элементы обязаны быть int, а не str"


def test_список_блоков_не_ломается_на_невалидном_токене(client, make_block):
    """У GET /blocks нет зависимости авторизации: мусорный токен игнорируется."""
    make_block(name="Медиа", master="")
    r = client.get(BLOCKS_URL, headers={"Authorization": "Bearer total.garbage"})
    assert r.status_code == 200, "эндпоинт без авторизации не должен реагировать на битый токен"
    assert len(r.json()) == 1


# ═════════════════════════════════════════════════════════════
#  POST /api/blocks — happy path и побочные эффекты
# ═════════════════════════════════════════════════════════════
def test_создание_блока_суперюзером(client, superuser):
    """Суперюзер создаёт блок: 200 и полное тело BlockOut."""
    r = client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "Мастер Мастеров", "hr": "Эйч Ар"},
        headers=superuser.headers,
    )
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert_block_body(
        r.json(), name="Медиа", master="Мастер Мастеров", hr="Эйч Ар", cnt_of_human=0, arr_of_human=[]
    )

    stored = db.get_block("Медиа")
    assert stored is not None, "блок обязан появиться в базе"
    assert stored.master == "Мастер Мастеров" and stored.hr == "Эйч Ар"
    assert stored.arr_of_human == [], "участников быть не должно"


def test_создание_блока_с_пустым_hr_по_умолчанию(client, superuser):
    """hr необязателен и по умолчанию — пустая строка."""
    r = client.post(BLOCKS_URL, json={"name": "Медиа", "master": "М"}, headers=superuser.headers)
    assert r.status_code == 200
    assert r.json()["hr"] == "", "hr по умолчанию обязан быть пустой строкой"
    assert db.get_block("Медиа").hr == ""


def test_создание_блока_с_существующим_мастером_переносит_права(client, superuser, make_user):
    """
    Если master совпал с kkr_name реального пользователя, он обязан
    попасть в arr_of_human, получить блок в поле blocks (и в user, и в contact)
    и получить admin=True.
    """
    victim = make_user(name="Мастер", surname="Мастеров")
    assert db.get_user(victim.user_id).admin is False, "предусловие: прав ещё нет"

    r = client.post(
        BLOCKS_URL, json={"name": "Медиа", "master": victim.kkr_name}, headers=superuser.headers
    )
    assert r.status_code == 200, r.text
    assert_block_body(
        r.json(),
        name="Медиа",
        master=victim.kkr_name,
        hr="",
        cnt_of_human=1,
        arr_of_human=[victim.user_id],
    )

    stored = db.get_block("Медиа")
    assert stored.arr_of_human == [victim.user_id], "мастер обязан быть добавлен в состав блока"
    assert stored.cnt_of_human == 1, "счётчик обязан учесть мастера"
    assert user_blocks(victim.user_id) == ["Медиа"], "блок обязан появиться в users.blocks"
    assert contact_blocks(victim.user_id) == ["Медиа"], "блок обязан появиться в contact_info.blocks"
    assert db.get_user(victim.user_id).admin is True, "мастер обязан получить admin"


def test_создание_блока_с_hr_выдаёт_права_админа(client, superuser, make_user):
    """HR блока тоже автоматически становится админом."""
    hr_user = make_user(name="Эйч", surname="Аров")
    r = client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "Никого Нет", "hr": hr_user.kkr_name},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    assert db.get_user(hr_user.user_id).admin is True, "HR обязан получить admin"
    assert db.get_block("Медиа").arr_of_human == [], (
        "HR, в отличие от мастера, в состав блока автоматически не попадает"
    )


def test_создание_блока_с_мастером_которого_нет(client, superuser):
    """master, не совпавший ни с кем, просто сохраняется строкой — блок пустой."""
    r = client.post(
        BLOCKS_URL, json={"name": "Медиа", "master": "Несуществующий Человек"}, headers=superuser.headers
    )
    assert r.status_code == 200, r.text
    assert_block_body(
        r.json(),
        name="Медиа",
        master="Несуществующий Человек",
        hr="",
        cnt_of_human=0,
        arr_of_human=[],
    )


def test_создание_блока_с_участниками_синхронизирует_их_поле_blocks(client, superuser, make_user):
    """arr_of_human из запроса обязан прописаться пользователям в поле blocks."""
    u1 = make_user()
    u2 = make_user()
    r = client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "", "arr_of_human": [u1.user_id, u2.user_id]},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["cnt_of_human"] == 2

    for u in (u1, u2):
        assert user_blocks(u.user_id) == ["Медиа"], f"пользователь {u.user_id} не получил блок"
        assert contact_blocks(u.user_id) == ["Медиа"], f"контакт {u.user_id} не получил блок"
        assert db.get_user(u.user_id).admin is False, "рядовой участник не должен получать admin"


def test_создание_блока_схлопывает_дубликаты_в_arr_of_human(client, superuser, make_user):
    """Повтор одного и того же user_id при создании не должен раздувать счётчик."""
    u = make_user()
    r = client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "", "arr_of_human": [u.user_id, u.user_id, u.user_id]},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["arr_of_human"] == [u.user_id], "дубликаты обязаны схлопнуться"
    assert body["cnt_of_human"] == len(body["arr_of_human"]), "счётчик обязан совпадать с составом"


def test_cnt_of_human_из_запроса_игнорируется_при_создании(client, superuser):
    """Клиент не может задать заведомо ложный счётчик — он считается из состава."""
    r = client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "", "cnt_of_human": 9999},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["cnt_of_human"] == 0, "счётчик обязан быть пересчитан по arr_of_human"
    assert db.get_block("Медиа").cnt_of_human == 0


def test_повторное_создание_блока_даёт_409(client, superuser):
    """Имя блока — первичный ключ: второй раз → 409 Block already exists."""
    first = client.post(
        BLOCKS_URL, json={"name": "Медиа", "master": "Первый Мастер"}, headers=superuser.headers
    )
    assert first.status_code == 200, first.text

    second = client.post(
        BLOCKS_URL, json={"name": "Медиа", "master": "Второй Мастер"}, headers=superuser.headers
    )
    assert second.status_code == 409, f"ожидался 409, получен {second.status_code}"
    assert second.json()["detail"] == "Block already exists", "неожиданный текст ошибки"

    assert len(db.list_blocks()) == 1, "второй блок не должен был создаться"
    assert db.get_block("Медиа").master == "Первый Мастер", "существующий блок не должен меняться"


# ── POST /api/blocks — авторизация и роли ────────────────────
@pytest.mark.parametrize("kind", BAD_AUTH_KINDS)
def test_создание_блока_без_валидного_токена(client, bad_auth, kind):
    """Любой невалидный токен → 401 с конкретным detail, блок не создаётся."""
    headers, code, detail = bad_auth(kind)
    r = client.post(BLOCKS_URL, json={"name": "Медиа", "master": ""}, headers=headers)
    assert r.status_code == code, f"[{kind}] ожидался {code}, получен {r.status_code}: {r.text}"
    assert r.json()["detail"] == detail, f"[{kind}] неожиданный detail"
    assert db.get_block("Медиа") is None, f"[{kind}] блок не должен был создаться"


def test_создание_блока_забаненным_суперюзером(client, make_user):
    """Бан проверяется раньше роли: 403 User is banned."""
    actor = make_user(super_user=True, banned=True)
    r = client.post(BLOCKS_URL, json={"name": "Медиа", "master": ""}, headers=actor.headers)
    assert r.status_code == 403, f"ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "User is banned"
    assert db.get_block("Медиа") is None, "блок не должен был создаться"


@pytest.mark.parametrize("role", ["обычный", "админ"])
def test_создание_блока_запрещено_не_суперюзеру(client, make_user, role):
    """Ни обычный пользователь, ни админ блок создать не могут."""
    actor = make_user(admin=(role == "админ"))
    r = client.post(BLOCKS_URL, json={"name": "Медиа", "master": ""}, headers=actor.headers)
    assert r.status_code == 403, f"[{role}] ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "SuperUser rights required", f"[{role}] неожиданный detail"
    assert db.get_block("Медиа") is None, f"[{role}] блок не должен был создаться"


def test_мастер_блока_не_может_создать_новый_блок(client, make_master):
    """Мастер получает admin, но не super_user — создание блоков ему закрыто."""
    actor, _ = make_master("Медиа")
    assert db.get_user(actor.user_id).admin is True, "предусловие: мастер — админ"
    r = client.post(BLOCKS_URL, json={"name": "Спорт", "master": ""}, headers=actor.headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "SuperUser rights required"
    assert db.get_block("Спорт") is None


# ── POST /api/blocks — валидация ─────────────────────────────
@pytest.mark.parametrize(
    ("body", "bad_field"),
    [
        ({"master": "М"}, "name"),
        ({"name": "Медиа"}, "master"),
        ({}, "name"),
    ],
    ids=["нет_name", "нет_master", "пустое_тело"],
)
def test_создание_блока_без_обязательных_полей(client, superuser, body, bad_field):
    """Отсутствие name/master → 422 от pydantic с указанием поля."""
    r = client.post(BLOCKS_URL, json=body, headers=superuser.headers)
    assert r.status_code == 422, f"ожидался 422, получен {r.status_code}: {r.text}"
    locs = [d["loc"] for d in r.json()["detail"]]
    assert ["body", bad_field] in locs, f"в ошибке нет поля {bad_field}: {locs}"
    assert db.list_blocks() == [], "при 422 в базу ничего не пишется"


@pytest.mark.parametrize(
    ("body", "loc"),
    [
        ({"name": 5, "master": "М"}, ["body", "name"]),
        ({"name": "Медиа", "master": None}, ["body", "master"]),
        ({"name": "Медиа", "master": "М", "hr": 1}, ["body", "hr"]),
        ({"name": "Медиа", "master": "М", "cnt_of_human": "много"}, ["body", "cnt_of_human"]),
        ({"name": "Медиа", "master": "М", "arr_of_human": "не список"}, ["body", "arr_of_human"]),
        ({"name": "Медиа", "master": "М", "arr_of_human": ["abc"]}, ["body", "arr_of_human", 0]),
        ({"name": "Медиа", "master": "М", "arr_of_human": [1.5]}, ["body", "arr_of_human", 0]),
        ({"name": "Медиа", "master": "М", "arr_of_human": [None]}, ["body", "arr_of_human", 0]),
    ],
    ids=[
        "name_число",
        "master_null",
        "hr_число",
        "cnt_строка",
        "arr_строка",
        "arr_из_строк",
        "arr_дробное",
        "arr_null",
    ],
)
def test_создание_блока_с_неверными_типами(client, superuser, body, loc):
    """Неверные типы полей → 422 ровно в том поле, где ошибка."""
    r = client.post(BLOCKS_URL, json=body, headers=superuser.headers)
    assert r.status_code == 422, f"ожидался 422, получен {r.status_code}: {r.text}"
    locs = [d["loc"] for d in r.json()["detail"]]
    assert loc in locs, f"ожидалась ошибка в {loc}, получено {locs}"
    assert db.list_blocks() == [], "при 422 в базу ничего не пишется"


def test_создание_блока_с_очень_длинным_именем(client, superuser):
    """Длинное имя не обрезается и остаётся адресуемым."""
    long_name = "Б" * 3000
    r = client.post(BLOCKS_URL, json={"name": long_name, "master": "М" * 2000}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == long_name, "имя не должно обрезаться"
    assert db.get_block(long_name) is not None

    patched = client.patch(f"{BLOCKS_URL}/{long_name}", json={"hr": "Х"}, headers=superuser.headers)
    assert patched.status_code == 200, "длинное имя обязано оставаться адресуемым"


@pytest.mark.parametrize(
    "name",
    ["Мой блок", "Блок 🎓 №1", "Média-Ünicode", "блок.с.точками", "блок?вопрос", "блок&амперсанд"],
    ids=["пробел", "эмодзи", "диакритика", "точки", "вопрос", "амперсанд"],
)
def test_блок_со_спецсимволами_в_имени_остаётся_адресуемым(client, superuser, name):
    """Имя блока попадает в путь URL — созданный блок обязан открываться на PATCH/DELETE."""
    created = client.post(BLOCKS_URL, json={"name": name, "master": ""}, headers=superuser.headers)
    assert created.status_code == 200, created.text

    path = f"{BLOCKS_URL}/{quote(name, safe='')}"
    patched = client.patch(path, json={"hr": "Эйч"}, headers=superuser.headers)
    assert patched.status_code == 200, f"PATCH по имени {name!r} не сработал: {patched.text}"
    assert patched.json()["hr"] == "Эйч"

    deleted = client.delete(path, headers=superuser.headers)
    assert deleted.status_code == 200, f"DELETE по имени {name!r} не сработал: {deleted.text}"
    assert db.get_block(name) is None


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: имя блока с '/' принимается (main.py:797), но блок становится "
           "неудаляемым и неизменяемым — путь /api/blocks/{block_name} не матчит слэш (main.py:813, 838)",
)
def test_блок_с_косой_чертой_в_имени_должен_оставаться_адресуемым(client, superuser):
    """Либо имя со слэшем отвергается на входе, либо блок обязан быть адресуем."""
    name = "Медиа/Дизайн"
    created = client.post(BLOCKS_URL, json={"name": name, "master": ""}, headers=superuser.headers)
    if created.status_code != 200:
        assert created.status_code in (400, 422), "имя со слэшем должно отвергаться осмысленно"
        return
    deleted = client.delete(f"{BLOCKS_URL}/{name}", headers=superuser.headers)
    assert deleted.status_code == 200, "созданный блок обязан удаляться"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: пустое имя блока принимается (main.py:797) и создаёт запись с PK='', "
           "которую невозможно ни изменить, ни удалить (PATCH /api/blocks/ → 405)",
)
def test_блок_с_пустым_именем_должен_отвергаться(client, superuser):
    """Пустое имя — невалидные данные: ожидается 400/422."""
    r = client.post(BLOCKS_URL, json={"name": "", "master": ""}, headers=superuser.headers)
    assert r.status_code in (400, 422), f"пустое имя обязано отвергаться, получено {r.status_code}"


def test_блок_из_одних_пробелов_создаётся_как_есть(client, superuser):
    """Имя из пробелов не триммится — фиксируем фактическое поведение (см. отчёт)."""
    r = client.post(BLOCKS_URL, json={"name": "   ", "master": "  "}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "   ", "имя не нормализуется"
    assert db.get_block("   ") is not None


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: arr_of_human принимает несуществующие user_id (database.py:743 → "
           "_sync_users_for_block, database.py:446) — в блок попадают фантомные участники",
)
def test_создание_блока_не_должно_принимать_несуществующих_участников(client, superuser):
    """Ссылка на несуществующего пользователя обязана отвергаться или отфильтровываться."""
    r = client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "", "arr_of_human": [999999]},
        headers=superuser.headers,
    )
    if r.status_code != 200:
        assert r.status_code in (400, 404, 422), "ожидался осмысленный отказ"
        return
    assert db.get_block("Медиа").arr_of_human == [], "фантомный участник не должен попадать в блок"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: регистрация выдаёт admin=True любому, чьё имя+фамилия совпали с master "
           "существующего блока (database.py:511 _sync_admin_rights в create_user_with_contact) — "
           "эскалация привилегий через публичный /api/auth/register",
)
def test_регистрация_с_именем_мастера_не_должна_давать_админку(client, superuser):
    """
    Мастер блока задаётся строкой-ФИО. Любой аноним может зарегистрироваться
    с таким же именем и фамилией и мгновенно получить права админа.
    """
    client.post(
        BLOCKS_URL, json={"name": "Медиа", "master": "Иван Иванов"}, headers=superuser.headers
    )
    r = client.post(
        "/api/auth/register",
        json={
            "email": "attacker@test.ru",
            "name": "Иван",
            "surname": "Иванов",
            "password": "Passw0rd!",
            "group_number": 101,
            "tg": "@attacker1",
        },
    )
    assert r.status_code == 201, r.text
    attacker = db.get_user_by_email("attacker@test.ru")
    assert attacker.admin is False, "самозванец не должен получать admin по совпадению ФИО"


def test_права_мастера_достаются_первому_пользователю_с_таким_kkr_name(client, superuser, make_user):
    """
    При совпадении kkr_name у двух людей права получает только первый по
    выборке (.first(), database.py:456). Фиксируем фактическое поведение — см. отчёт.
    """
    first = make_user(kkr_name="Иван Иванов", name="Иван", surname="Иванов")
    second = make_user(kkr_name="Иван Иванов", name="Иван", surname="Иванов-второй")

    r = client.post(BLOCKS_URL, json={"name": "Медиа", "master": "Иван Иванов"}, headers=superuser.headers)
    assert r.status_code == 200, r.text

    assert db.get_user(first.user_id).admin is True, "первый однофамилец получил права"
    assert db.get_user(second.user_id).admin is False, "второму права не достались"
    assert db.get_block("Медиа").arr_of_human == [first.user_id], "в состав попал только первый"


# ═════════════════════════════════════════════════════════════
#  PATCH /api/blocks/{block_name}
# ═════════════════════════════════════════════════════════════
def test_изменение_блока_суперюзером(client, superuser, make_block):
    """Суперюзер меняет hr любого блока: 200 и полное тело BlockOut."""
    make_block(name="Медиа", master="Мастер Мастеров", hr="Старый Эйчар")

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": "Новый Эйчар"}, headers=superuser.headers)
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert_block_body(
        r.json(),
        name="Медиа",
        master="Мастер Мастеров",
        hr="Новый Эйчар",
        cnt_of_human=0,
        arr_of_human=[],
    )
    assert db.get_block("Медиа").hr == "Новый Эйчар", "изменение обязано сохраниться в базе"


def test_пустое_тело_patch_ничего_не_меняет(client, superuser, make_user, make_block):
    """PATCH {} — валидный no-op, состояние блока не меняется."""
    u = make_user()
    make_block(name="Медиа", master="Мастер Мастеров", hr="Эйч", arr_of_human=[u.user_id])
    before = db.get_block("Медиа")

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert db.get_block("Медиа") == before, "пустой PATCH не должен ничего менять"


def test_мастер_блока_может_его_редактировать(client, make_master):
    """Мастер (admin, но не суперюзер) правит свой блок."""
    actor, _ = make_master("Медиа")
    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": "Назначенный Эйчар"}, headers=actor.headers)
    assert r.status_code == 200, f"мастеру обязано быть разрешено: {r.text}"
    assert db.get_block("Медиа").hr == "Назначенный Эйчар"


def test_hr_блока_может_его_редактировать(client, make_hr):
    """HR блока тоже допущен к редактированию."""
    actor, _ = make_hr("Медиа", master_name="Мастер Мастеров")
    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": actor.kkr_name}, headers=actor.headers)
    assert r.status_code == 200, f"HR обязано быть разрешено: {r.text}"


def test_чужой_админ_не_может_редактировать_блок(client, make_master, make_block):
    """Админ, не связанный с блоком, получает 403 с конкретным текстом."""
    actor, _ = make_master("Спорт")  # админ, но мастер другого блока
    make_block(name="Медиа", master="Мастер Мастеров", hr="Эйч Ар")

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": "Я Тут Главный"}, headers=actor.headers)
    assert r.status_code == 403, f"ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "You can only edit a block if you are its Master or HR"
    assert db.get_block("Медиа").hr == "Эйч Ар", "блок не должен был измениться"


def test_обычный_пользователь_не_может_редактировать_блок(client, user, make_block):
    """Без admin — 403 Admin rights required."""
    make_block(name="Медиа", master="Мастер Мастеров")
    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": "Х"}, headers=user.headers)
    assert r.status_code == 403, f"ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "Admin rights required"
    assert db.get_block("Медиа").hr == "", "блок не должен был измениться"


def test_участник_блока_без_прав_не_может_его_редактировать(client, user, make_block):
    """Вход в блок не делает участника его редактором."""
    make_block(name="Медиа", master="Мастер Мастеров")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"master": user.kkr_name}, headers=user.headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "Admin rights required"
    assert db.get_block("Медиа").master == "Мастер Мастеров", "мастер не должен был смениться"


@pytest.mark.parametrize("kind", BAD_AUTH_KINDS)
def test_изменение_блока_без_валидного_токена(client, bad_auth, make_block, kind):
    """Любой невалидный токен → 401, блок не меняется."""
    make_block(name="Медиа", master="Мастер Мастеров")
    headers, code, detail = bad_auth(kind)

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": "Взлом"}, headers=headers)
    assert r.status_code == code, f"[{kind}] ожидался {code}, получен {r.status_code}"
    assert r.json()["detail"] == detail, f"[{kind}] неожиданный detail"
    assert db.get_block("Медиа").hr == "", f"[{kind}] блок не должен был измениться"


def test_изменение_блока_забаненным_админом(client, make_user, make_block):
    """Забаненный админ отсекается на get_current_user: 403 User is banned."""
    actor = make_user(admin=True, banned=True)
    make_block(name="Медиа", master="Мастер Мастеров")
    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": "Х"}, headers=actor.headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "User is banned"
    assert db.get_block("Медиа").hr == ""


def test_изменение_несуществующего_блока_суперюзером(client, superuser):
    """Суперюзер получает 404 Block not found из update_block."""
    r = client.patch(f"{BLOCKS_URL}/НетТакого", json={"hr": "Х"}, headers=superuser.headers)
    assert r.status_code == 404, f"ожидался 404, получен {r.status_code}"
    assert r.json()["detail"] == "Block not found"


def test_изменение_несуществующего_блока_админом_даёт_404_а_не_403(client, make_user):
    """
    Для не-суперюзера проверка существования блока идёт РАНЬШЕ проверки прав
    (main.py:820-825): чужой админ узнаёт, что блока нет, ещё до отказа по правам.
    """
    actor = make_user(admin=True)
    r = client.patch(f"{BLOCKS_URL}/НетТакого", json={"hr": "Х"}, headers=actor.headers)
    assert r.status_code == 404, f"ожидался 404, получен {r.status_code}"
    assert r.json()["detail"] == "Block not found"


def test_изменение_несуществующего_блока_обычным_пользователем(client, user):
    """Без прав админа отказ наступает раньше проверки существования блока."""
    r = client.patch(f"{BLOCKS_URL}/НетТакого", json={"hr": "Х"}, headers=user.headers)
    assert r.status_code == 403, f"ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "Admin rights required"


def test_смена_мастера_переносит_права_админа(client, superuser, make_master, make_user):
    """Старый мастер теряет admin, новый получает; оба остаются в составе блока."""
    old, _ = make_master("Медиа", name="Старый", surname="Мастер")
    new = make_user(name="Новый", surname="Мастер")
    assert db.get_user(old.user_id).admin is True and db.get_user(new.user_id).admin is False

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"master": new.kkr_name}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json()["master"] == new.kkr_name

    assert db.get_user(old.user_id).admin is False, "старый мастер обязан потерять admin"
    assert db.get_user(new.user_id).admin is True, "новый мастер обязан получить admin"

    stored = db.get_block("Медиа")
    assert sorted(stored.arr_of_human) == sorted([old.user_id, new.user_id]), (
        "новый мастер добавляется в состав, старый из него не выкидывается"
    )
    assert stored.cnt_of_human == 2
    assert user_blocks(new.user_id) == ["Медиа"], "новому мастеру блок обязан прописаться"


def test_старый_мастер_сохраняет_админку_если_ведёт_другой_блок(client, superuser, make_user, make_block):
    """Права снимаются только если человек больше нигде не мастер и не HR."""
    person = make_user(name="Много", surname="Блоков")
    make_block(name="Медиа", master=person.kkr_name)
    make_block(name="Спорт", master=person.kkr_name)
    assert db.get_user(person.user_id).admin is True

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"master": "Кто-то Другой"}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert db.get_user(person.user_id).admin is True, (
        "человек всё ещё мастер блока Спорт — admin обязан сохраниться"
    )


def test_смена_hr_снимает_ручную_админку(client, superuser, make_user):
    """
    Права админа пересчитываются исключительно по блокам: снятие с должности HR
    отбирает admin даже у того, кому его выставили вручную (см. отчёт).
    """
    person = make_user(admin=True, name="Ручной", surname="Админ")
    client.post(
        BLOCKS_URL,
        json={"name": "Медиа", "master": "Мастер Мастеров", "hr": person.kkr_name},
        headers=superuser.headers,
    )
    assert db.get_user(person.user_id).admin is True

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": ""}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert db.get_user(person.user_id).admin is False, "admin снят вместе с должностью HR"


def test_замена_состава_блока_синхронизирует_поле_blocks(client, superuser, make_user, make_block):
    """arr_of_human заменяется целиком: выбывшим блок убирается, новым — добавляется."""
    stays = make_user()
    leaves = make_user()
    joins = make_user()
    make_block(name="Медиа", master="", arr_of_human=[stays.user_id, leaves.user_id])
    assert user_blocks(leaves.user_id) == ["Медиа"], "предусловие"

    r = client.patch(
        f"{BLOCKS_URL}/Медиа",
        json={"arr_of_human": [stays.user_id, joins.user_id]},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    assert sorted(r.json()["arr_of_human"]) == sorted([stays.user_id, joins.user_id])

    assert user_blocks(stays.user_id) == ["Медиа"], "оставшийся сохраняет блок"
    assert user_blocks(joins.user_id) == ["Медиа"], "добавленному блок обязан прописаться"
    assert contact_blocks(joins.user_id) == ["Медиа"], "и в contact_info тоже"
    assert user_blocks(leaves.user_id) == [], "выбывшему блок обязан быть убран"
    assert contact_blocks(leaves.user_id) == [], "и из contact_info тоже"


def test_cnt_of_human_из_запроса_игнорируется_при_изменении(client, superuser, make_user, make_block):
    """Клиент не может подменить счётчик — поле cnt_of_human в PATCH бесполезно."""
    u = make_user()
    make_block(name="Медиа", master="", arr_of_human=[u.user_id])

    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"cnt_of_human": 500}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json()["cnt_of_human"] == 1, "счётчик обязан отражать реальный состав"
    assert db.get_block("Медиа").cnt_of_human == 1


def test_cnt_of_human_пересчитывается_по_новому_составу(client, superuser, make_user, make_block):
    """После замены состава счётчик равен длине списка участников."""
    u1, u2, u3 = make_user(), make_user(), make_user()
    make_block(name="Медиа", master="", arr_of_human=[u1.user_id])

    r = client.patch(
        f"{BLOCKS_URL}/Медиа",
        json={"arr_of_human": [u1.user_id, u2.user_id, u3.user_id], "cnt_of_human": 0},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cnt_of_human"] == 3
    assert body["cnt_of_human"] == len(body["arr_of_human"]), "счётчик обязан совпадать с составом"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: update_block ставит cnt_of_human = len(arr) с дубликатами (database.py:791), "
           "затирая корректное len(set) из _sync_users_for_block (database.py:447) — "
           "счётчик участников начинает врать",
)
def test_дубликаты_в_arr_of_human_не_должны_раздувать_счётчик(client, superuser, make_user, make_block):
    """cnt_of_human обязан всегда совпадать с длиной arr_of_human."""
    u = make_user()
    make_block(name="Медиа", master="")

    r = client.patch(
        f"{BLOCKS_URL}/Медиа",
        json={"arr_of_human": [u.user_id, u.user_id, u.user_id]},
        headers=superuser.headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cnt_of_human"] == len(body["arr_of_human"]), (
        f"счётчик {body['cnt_of_human']} не совпадает с составом {body['arr_of_human']}"
    )


def test_мастер_не_удаляется_из_состава_через_пустой_arr_of_human(client, superuser, make_master):
    """Мастер переприсоединяется к блоку автоматически (database.py:784-787)."""
    actor, _ = make_master("Медиа")
    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"arr_of_human": []}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json()["arr_of_human"] == [actor.user_id], "мастер обязан остаться в составе"


@pytest.mark.parametrize(
    ("body", "loc"),
    [
        ({"master": 5}, ["body", "master"]),
        ({"hr": []}, ["body", "hr"]),
        ({"cnt_of_human": "много"}, ["body", "cnt_of_human"]),
        ({"arr_of_human": "не список"}, ["body", "arr_of_human"]),
        ({"arr_of_human": ["abc"]}, ["body", "arr_of_human", 0]),
    ],
    ids=["master_число", "hr_список", "cnt_строка", "arr_строка", "arr_из_строк"],
)
def test_изменение_блока_с_неверными_типами(client, superuser, make_block, body, loc):
    """Неверные типы → 422, блок не меняется."""
    make_block(name="Медиа", master="Мастер Мастеров", hr="Эйч")
    before = db.get_block("Медиа")

    r = client.patch(f"{BLOCKS_URL}/Медиа", json=body, headers=superuser.headers)
    assert r.status_code == 422, f"ожидался 422, получен {r.status_code}: {r.text}"
    locs = [d["loc"] for d in r.json()["detail"]]
    assert loc in locs, f"ожидалась ошибка в {loc}, получено {locs}"
    assert db.get_block("Медиа") == before, "при 422 блок не должен меняться"


def test_изменение_блока_очень_длинными_строками(client, superuser, make_block):
    """Длинные master/hr сохраняются без обрезки."""
    make_block(name="Медиа", master="Мастер Мастеров")
    long_value = "Х" * 5000
    r = client.patch(f"{BLOCKS_URL}/Медиа", json={"hr": long_value}, headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json()["hr"] == long_value
    assert db.get_block("Медиа").hr == long_value


# ═════════════════════════════════════════════════════════════
#  DELETE /api/blocks/{block_name}
# ═════════════════════════════════════════════════════════════
def test_удаление_блока_суперюзером(client, superuser, make_block):
    """200 {"status": "deleted"} и запись исчезает из базы."""
    make_block(name="Медиа", master="Мастер Мастеров")

    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers)
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert r.json() == {"status": "deleted"}, "неожиданное тело ответа"
    assert db.get_block("Медиа") is None, "блок обязан исчезнуть из базы"
    assert db.list_blocks() == []


def test_повторное_удаление_блока_даёт_404(client, superuser, make_block):
    """Второй DELETE того же блока → 404 Block not found."""
    make_block(name="Медиа", master="")
    assert client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers).status_code == 200

    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers)
    assert r.status_code == 404, f"ожидался 404, получен {r.status_code}"
    assert r.json()["detail"] == "Block not found"


def test_удаление_несуществующего_блока(client, superuser):
    """404 Block not found."""
    r = client.delete(f"{BLOCKS_URL}/НетТакого", headers=superuser.headers)
    assert r.status_code == 404
    assert r.json()["detail"] == "Block not found"


@pytest.mark.parametrize("role", ["обычный", "админ"])
def test_удаление_блока_запрещено_не_суперюзеру(client, make_user, make_block, role):
    """Ни пользователь, ни админ удалить блок не могут."""
    make_block(name="Медиа", master="Мастер Мастеров")
    actor = make_user(admin=(role == "админ"))

    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=actor.headers)
    assert r.status_code == 403, f"[{role}] ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "SuperUser rights required"
    assert db.get_block("Медиа") is not None, f"[{role}] блок обязан остаться"


def test_мастер_не_может_удалить_свой_блок(client, make_master):
    """Мастер — админ, но не суперюзер: 403."""
    actor, _ = make_master("Медиа")
    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=actor.headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "SuperUser rights required"
    assert db.get_block("Медиа") is not None


@pytest.mark.parametrize("kind", BAD_AUTH_KINDS)
def test_удаление_блока_без_валидного_токена(client, bad_auth, make_block, kind):
    """Любой невалидный токен → 401, блок остаётся на месте."""
    make_block(name="Медиа", master="")
    headers, code, detail = bad_auth(kind)

    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=headers)
    assert r.status_code == code, f"[{kind}] ожидался {code}, получен {r.status_code}"
    assert r.json()["detail"] == detail, f"[{kind}] неожиданный detail"
    assert db.get_block("Медиа") is not None, f"[{kind}] блок обязан остаться"


def test_удаление_блока_забаненным_суперюзером(client, make_user, make_block):
    """403 User is banned, блок цел."""
    actor = make_user(super_user=True, banned=True)
    make_block(name="Медиа", master="")
    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=actor.headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "User is banned"
    assert db.get_block("Медиа") is not None


def test_удаление_блока_чистит_участников_и_права(client, superuser, make_master, make_user):
    """После удаления у участников исчезает блок, у мастера — admin."""
    master, _ = make_master("Медиа", name="Мастер", surname="Мастеров")
    member = make_user()
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=member.headers)
    assert user_blocks(member.user_id) == ["Медиа"], "предусловие"
    assert db.get_user(master.user_id).admin is True, "предусловие"

    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers)
    assert r.status_code == 200, r.text

    assert user_blocks(member.user_id) == [], "у участника блок обязан быть убран"
    assert contact_blocks(member.user_id) == [], "и в contact_info тоже"
    assert user_blocks(master.user_id) == [], "у мастера блок обязан быть убран"
    assert db.get_user(master.user_id).admin is False, "мастер обязан потерять admin"


def test_удаление_блока_не_трогает_соседний(client, superuser, make_user, make_block):
    """Удаление одного блока не ломает членство в другом."""
    u = make_user()
    make_block(name="Медиа", master="", arr_of_human=[u.user_id])
    make_block(name="Спорт", master="", arr_of_human=[u.user_id])
    assert user_blocks(u.user_id) == ["Медиа", "Спорт"], "предусловие"

    r = client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers)
    assert r.status_code == 200, r.text
    assert user_blocks(u.user_id) == ["Спорт"], "членство в оставшемся блоке обязано сохраниться"
    assert db.get_block("Спорт").arr_of_human == [u.user_id]


def test_удаление_блока_у_мастера_с_двумя_блоками_сохраняет_админку(client, superuser, make_user, make_block):
    """Пока человек мастер хоть одного блока, admin остаётся."""
    person = make_user(name="Много", surname="Блоков")
    make_block(name="Медиа", master=person.kkr_name)
    make_block(name="Спорт", master=person.kkr_name)

    assert client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers).status_code == 200
    assert db.get_user(person.user_id).admin is True, "мастер блока Спорт обязан остаться админом"


# ═════════════════════════════════════════════════════════════
#  POST /api/blocks/{block_name}/enter
# ═════════════════════════════════════════════════════════════
def test_вход_в_блок_обычным_пользователем(client, user, make_block):
    """200, полное тело BlockOut и все побочные эффекты в базе."""
    make_block(name="Медиа", master="Мастер Мастеров", hr="Эйч Ар")

    r = client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert_block_body(
        r.json(),
        name="Медиа",
        master="Мастер Мастеров",
        hr="Эйч Ар",
        cnt_of_human=1,
        arr_of_human=[user.user_id],
    )

    stored = db.get_block("Медиа")
    assert stored.arr_of_human == [user.user_id], "участник обязан появиться в составе блока"
    assert stored.cnt_of_human == 1, "счётчик обязан вырасти"
    assert user_blocks(user.user_id) == ["Медиа"], "блок обязан появиться в users.blocks"
    assert contact_blocks(user.user_id) == ["Медиа"], "блок обязан появиться в contact_info.blocks"


def test_вход_в_блок_не_выдаёт_прав_админа(client, user, make_block):
    """Обычное членство не влияет на роли."""
    make_block(name="Медиа", master="Мастер Мастеров")
    assert client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers).status_code == 200
    u = db.get_user(user.user_id)
    assert u.admin is False and u.super_user is False, "вход в блок не должен менять права"


def test_повторный_вход_в_блок_идемпотентен(client, user, make_block):
    """Второй enter не дублирует участника и не двигает счётчик."""
    make_block(name="Медиа", master="")
    first = client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)
    second = client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)

    assert first.status_code == 200 and second.status_code == 200, "оба вызова обязаны быть успешны"
    assert first.json() == second.json(), "повторный вход обязан вернуть то же состояние"
    stored = db.get_block("Медиа")
    assert stored.arr_of_human == [user.user_id], "дубликата участника быть не должно"
    assert stored.cnt_of_human == 1, "счётчик не должен расти при повторном входе"


def test_вход_в_несколько_блоков(client, user, make_block):
    """Пользователь может состоять сразу в нескольких блоках."""
    make_block(name="Медиа", master="")
    make_block(name="Спорт", master="")
    assert client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers).status_code == 200
    assert client.post(f"{BLOCKS_URL}/Спорт/enter", headers=user.headers).status_code == 200

    assert user_blocks(user.user_id) == ["Медиа", "Спорт"], "оба блока обязаны быть в blocks"
    assert db.get_block("Медиа").arr_of_human == [user.user_id]
    assert db.get_block("Спорт").arr_of_human == [user.user_id]


def test_счётчик_блока_отражает_реальное_число_участников(client, make_user, make_block):
    """cnt_of_human == len(arr_of_human) после серии входов и выходов."""
    make_block(name="Медиа", master="")
    users = [make_user() for _ in range(3)]
    for u in users:
        assert client.post(f"{BLOCKS_URL}/Медиа/enter", headers=u.headers).status_code == 200

    stored = db.get_block("Медиа")
    assert stored.cnt_of_human == 3 == len(stored.arr_of_human), "счётчик обязан совпадать с составом"

    client.post(f"{BLOCKS_URL}/Медиа/exit", headers=users[0].headers)
    stored = db.get_block("Медиа")
    assert stored.cnt_of_human == 2 == len(stored.arr_of_human), "после выхода счётчик обязан упасть"
    assert users[0].user_id not in stored.arr_of_human


def test_вход_в_несуществующий_блок(client, user, make_block):
    """404 User or block not found, состав пользователя не меняется."""
    make_block(name="Медиа", master="")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)

    r = client.post(f"{BLOCKS_URL}/НетТакого/enter", headers=user.headers)
    assert r.status_code == 404, f"ожидался 404, получен {r.status_code}"
    assert r.json()["detail"] == "User or block not found"
    assert user_blocks(user.user_id) == ["Медиа"], "существующее членство не должно пострадать"


def test_вход_в_блок_чувствителен_к_регистру(client, user, make_block):
    """Имя блока сравнивается точно: другой регистр — это другой блок."""
    make_block(name="Медиа", master="")
    r = client.post(f"{BLOCKS_URL}/медиа/enter", headers=user.headers)
    assert r.status_code == 404, "регистр имени обязан учитываться"
    assert r.json()["detail"] == "User or block not found"
    assert user_blocks(user.user_id) == []


@pytest.mark.parametrize("kind", BAD_AUTH_KINDS)
def test_вход_в_блок_без_валидного_токена(client, bad_auth, make_block, kind):
    """Любой невалидный токен → 401, состав блока не меняется."""
    make_block(name="Медиа", master="")
    headers, code, detail = bad_auth(kind)

    r = client.post(f"{BLOCKS_URL}/Медиа/enter", headers=headers)
    assert r.status_code == code, f"[{kind}] ожидался {code}, получен {r.status_code}"
    assert r.json()["detail"] == detail, f"[{kind}] неожиданный detail"
    assert db.get_block("Медиа").arr_of_human == [], f"[{kind}] в блок никто не должен попасть"


def test_вход_в_блок_забаненным_пользователем(client, banned_user, make_block):
    """403 User is banned, в блок он не попадает."""
    make_block(name="Медиа", master="")
    r = client.post(f"{BLOCKS_URL}/Медиа/enter", headers=banned_user.headers)
    assert r.status_code == 403, f"ожидался 403, получен {r.status_code}"
    assert r.json()["detail"] == "User is banned"
    assert db.get_block("Медиа").arr_of_human == [], "забаненный не должен попасть в блок"


# ═════════════════════════════════════════════════════════════
#  POST /api/blocks/{block_name}/exit
# ═════════════════════════════════════════════════════════════
def test_выход_из_блока(client, user, make_block):
    """200, участник убран из состава блока и из своего поля blocks."""
    make_block(name="Медиа", master="Мастер Мастеров")
    assert client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers).status_code == 200

    r = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=user.headers)
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert_block_body(
        r.json(), name="Медиа", master="Мастер Мастеров", hr="", cnt_of_human=0, arr_of_human=[]
    )

    stored = db.get_block("Медиа")
    assert stored.arr_of_human == [], "участник обязан покинуть состав"
    assert stored.cnt_of_human == 0, "счётчик обязан обнулиться"
    assert user_blocks(user.user_id) == [], "блок обязан исчезнуть из users.blocks"
    assert contact_blocks(user.user_id) == [], "блок обязан исчезнуть из contact_info.blocks"


def test_выход_из_блока_в_котором_не_состоишь(client, user, make_user, make_block):
    """Не-участник получает 200 и никого не выкидывает."""
    member = make_user()
    make_block(name="Медиа", master="", arr_of_human=[member.user_id])

    r = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=user.headers)
    assert r.status_code == 200, f"ожидался 200, получен {r.status_code}: {r.text}"
    assert r.json()["arr_of_human"] == [member.user_id], "чужое членство не должно пострадать"
    assert db.get_block("Медиа").cnt_of_human == 1


def test_повторный_выход_из_блока_идемпотентен(client, user, make_block):
    """Второй exit ничего не ломает и возвращает то же состояние."""
    make_block(name="Медиа", master="")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)

    first = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=user.headers)
    second = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=user.headers)
    assert first.status_code == 200 and second.status_code == 200
    assert first.json() == second.json(), "повторный выход обязан вернуть то же состояние"
    assert db.get_block("Медиа").arr_of_human == []


def test_выход_из_несуществующего_блока(client, user, make_block):
    """404 User or block not found, остальные членства целы."""
    make_block(name="Медиа", master="")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)

    r = client.post(f"{BLOCKS_URL}/НетТакого/exit", headers=user.headers)
    assert r.status_code == 404, f"ожидался 404, получен {r.status_code}"
    assert r.json()["detail"] == "User or block not found"
    assert user_blocks(user.user_id) == ["Медиа"], "существующее членство не должно пострадать"


def test_выход_не_затрагивает_другие_блоки(client, user, make_block):
    """Выход из одного блока сохраняет членство в другом."""
    make_block(name="Медиа", master="")
    make_block(name="Спорт", master="")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)
    client.post(f"{BLOCKS_URL}/Спорт/enter", headers=user.headers)

    r = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=user.headers)
    assert r.status_code == 200, r.text
    assert user_blocks(user.user_id) == ["Спорт"], "второй блок обязан остаться"
    assert db.get_block("Спорт").arr_of_human == [user.user_id]


@pytest.mark.parametrize("kind", BAD_AUTH_KINDS)
def test_выход_из_блока_без_валидного_токена(client, bad_auth, make_user, make_block, kind):
    """Любой невалидный токен → 401, состав блока не меняется."""
    member = make_user()
    make_block(name="Медиа", master="", arr_of_human=[member.user_id])
    headers, code, detail = bad_auth(kind)

    r = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=headers)
    assert r.status_code == code, f"[{kind}] ожидался {code}, получен {r.status_code}"
    assert r.json()["detail"] == detail, f"[{kind}] неожиданный detail"
    assert db.get_block("Медиа").arr_of_human == [member.user_id], f"[{kind}] состав обязан уцелеть"


def test_выход_из_блока_забаненным_пользователем(client, banned_user, make_block):
    """403 User is banned."""
    make_block(name="Медиа", master="", arr_of_human=[banned_user.user_id])
    r = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=banned_user.headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "User is banned"
    assert db.get_block("Медиа").arr_of_human == [banned_user.user_id], "состав обязан уцелеть"


def test_мастер_может_выйти_из_своего_блока_но_остаётся_мастером(client, make_master):
    """
    Фактическое поведение: мастер выходит из состава, счётчик падает до нуля,
    но он остаётся master, сохраняет admin и продолжает видеть гайды блока.
    Блок с мастером показывает cnt_of_human=0 — расхождение зафиксировано в отчёте.
    """
    actor, _ = make_master("Медиа")
    assert db.get_block("Медиа").cnt_of_human == 1, "предусловие: мастер в составе"

    r = client.post(f"{BLOCKS_URL}/Медиа/exit", headers=actor.headers)
    assert r.status_code == 200, r.text
    assert r.json()["arr_of_human"] == [], "мастер вышел из состава"
    assert r.json()["cnt_of_human"] == 0, "счётчик обнулился, хотя мастер у блока есть"

    assert db.get_block("Медиа").master == actor.kkr_name, "мастером он быть не перестал"
    assert db.get_user(actor.user_id).admin is True, "права админа сохраняются"
    assert "Медиа" in db.get_user_block_names(actor.user_id), "блок остаётся видимым мастеру"


# ═════════════════════════════════════════════════════════════
#  Связка с видимостью гайдов (GET /api/guides)
# ═════════════════════════════════════════════════════════════
def test_гайд_блока_не_виден_до_входа_в_блок(client, user, make_block, make_guide):
    """Гайд с owner_block виден только участникам этого блока."""
    make_block(name="Медиа", master="")
    make_guide(title="Секрет Медиа", owner_block="Медиа")

    titles = [g["title"] for g in client.get("/api/guides", headers=user.headers).json()]
    assert "Секрет Медиа" not in titles, "посторонний не должен видеть гайд блока"


def test_гайд_блока_становится_виден_после_входа(client, user, make_block, make_guide):
    """enter → гайд появляется в /api/guides."""
    make_block(name="Медиа", master="")
    make_guide(title="Секрет Медиа", owner_block="Медиа")
    assert client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers).status_code == 200

    r = client.get("/api/guides", headers=user.headers)
    assert r.status_code == 200, r.text
    titles = [g["title"] for g in r.json()]
    assert "Секрет Медиа" in titles, "после входа гайд блока обязан быть виден"


def test_гайд_блока_снова_скрывается_после_выхода(client, user, make_block, make_guide):
    """exit → доступ к гайдам блока отзывается."""
    make_block(name="Медиа", master="")
    make_guide(title="Секрет Медиа", owner_block="Медиа")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)
    client.post(f"{BLOCKS_URL}/Медиа/exit", headers=user.headers)

    titles = [g["title"] for g in client.get("/api/guides", headers=user.headers).json()]
    assert "Секрет Медиа" not in titles, "после выхода гайд блока обязан скрыться"


def test_вход_в_один_блок_не_открывает_гайды_другого(client, user, make_block, make_guide):
    """Членство в Медиа не даёт доступа к гайдам Спорта."""
    make_block(name="Медиа", master="")
    make_block(name="Спорт", master="")
    make_guide(title="Секрет Медиа", owner_block="Медиа")
    make_guide(title="Секрет Спорта", owner_block="Спорт")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)

    titles = [g["title"] for g in client.get("/api/guides", headers=user.headers).json()]
    assert "Секрет Медиа" in titles, "гайд своего блока обязан быть виден"
    assert "Секрет Спорта" not in titles, "гайд чужого блока виден быть не должен"


def test_общий_гайд_виден_и_без_входа_в_блок(client, user, anon, make_block, make_guide):
    """owner_block='none' — публичный гайд, его видно всем, включая анонима."""
    make_block(name="Медиа", master="")
    make_guide(title="Общий гайд", owner_block="none")

    for who, headers in (("аноним", anon), ("пользователь", user.headers)):
        titles = [g["title"] for g in client.get("/api/guides", headers=headers).json()]
        assert "Общий гайд" in titles, f"{who} обязан видеть общий гайд"


def test_удаление_блока_отзывает_доступ_к_его_гайдам(client, superuser, user, make_block, make_guide):
    """После DELETE блока его участники теряют доступ к гайдам этого блока."""
    make_block(name="Медиа", master="")
    make_guide(title="Секрет Медиа", owner_block="Медиа")
    client.post(f"{BLOCKS_URL}/Медиа/enter", headers=user.headers)
    assert "Секрет Медиа" in [
        g["title"] for g in client.get("/api/guides", headers=user.headers).json()
    ], "предусловие: доступ есть"

    assert client.delete(f"{BLOCKS_URL}/Медиа", headers=superuser.headers).status_code == 200

    titles = [g["title"] for g in client.get("/api/guides", headers=user.headers).json()]
    assert "Секрет Медиа" not in titles, "после удаления блока доступ к его гайдам обязан пропасть"
