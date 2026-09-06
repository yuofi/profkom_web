"""
Тесты справочника контактов:

* ``GET  /api/contacts``        — main.py:866, БЕЗ какой-либо авторизации
* ``POST /api/contacts/filter`` — main.py:871, требует ``require_admin``

Главная находка вынесена в отдельный блок тестов в начале файла:
``GET /api/contacts`` отдаёт ПОЛНЫЙ справочник персональных данных
(email, телефон, ВК, телеграм, место проживания) любому анониму из интернета.
"""
from __future__ import annotations

import pytest

from database import db

CONTACTS_URL = "/api/contacts"
FILTER_URL = "/api/contacts/filter"

# Полный набор полей модели ContactInfoOut (main.py:111-113).
CONTACT_OUT_FIELDS = {
    "user_id",
    "email",
    "surname",
    "name",
    "patronymic",
    "kkr_name",
    "group_number",
    "location",
    "blocks",
    "phone",
    "vk",
    "tg",
    "budget",
    "in_profcom",
    "photo_url",
}


def _assert_contact_shape(item: dict) -> None:
    """Проверяет, что объект — ровно ContactInfoOut, с правильными типами полей."""
    assert isinstance(item, dict), f"Элемент ответа должен быть объектом, получен {type(item)}"
    assert set(item) == CONTACT_OUT_FIELDS, (
        f"Набор полей ContactInfoOut отличается от ожидаемого: "
        f"лишние={set(item) - CONTACT_OUT_FIELDS}, отсутствуют={CONTACT_OUT_FIELDS - set(item)}"
    )
    assert isinstance(item["user_id"], int), "user_id обязан быть целым числом"
    assert isinstance(item["budget"], bool), "budget обязан быть булевым"
    assert isinstance(item["in_profcom"], bool), "in_profcom обязан быть булевым"
    assert item["photo_url"] is None or isinstance(item["photo_url"], str), (
        "photo_url обязан быть строкой либо null"
    )
    for field in (
        "email",
        "surname",
        "name",
        "patronymic",
        "kkr_name",
        "group_number",
        "location",
        "blocks",
        "phone",
        "vk",
        "tg",
    ):
        assert isinstance(item[field], str), f"Поле {field} обязано быть строкой"


def _skip_if_endpoint_secured(response) -> None:
    """
    Страховка на будущее: тесты, документирующие ТЕКУЩУЮ дыру в GET /api/contacts,
    не должны краснеть, когда дыру наконец закроют, — за это отвечает
    xfail(strict)-тест `test_анониму_должны_отказывать_в_справочнике_контактов`.
    """
    if response.status_code in (401, 403):
        pytest.skip(
            "GET /api/contacts закрыли авторизацией — см. "
            "test_анониму_должны_отказывать_в_справочнике_контактов"
        )


def _ids(payload: list[dict]) -> set[int]:
    return {item["user_id"] for item in payload}


def _join_blocks(make_user, block_names: list[str], **user_kwargs):
    """
    Создаёт пользователя и заводит его в блоки через db.enter_user_to_block.

    Напрямую через `make_user(blocks=...)` пользоваться нельзя: при создании
    пользователя contact_info.blocks остаётся пустым (см. xfail-тест
    `test_блоки_в_справочнике_должны_совпадать_с_блоками_пользователя`),
    а и GET /api/contacts, и фильтр читают именно contact_info.blocks.
    """
    actor = make_user(**user_kwargs)
    for name in block_names:
        db.enter_user_to_block(actor.user_id, name)
    return actor


# ═══════════════════════════════════════════════════════════════════
#  GET /api/contacts — УТЕЧКА ПЕРСОНАЛЬНЫХ ДАННЫХ
# ═══════════════════════════════════════════════════════════════════


def test_аноним_получает_полный_справочник_с_персональными_данными(client, anon, make_user):
    """
    ДОКУМЕНТИРУЕТ ДЕФЕКТ: GET /api/contacts не имеет ни одной зависимости
    авторизации, поэтому любой анонимный запрос выгружает email, телефон,
    ВК и телеграм всех пользователей сразу.
    """
    victim = make_user(
        email="victim@test.ru",
        phone="+79990001122",
        vk="https://vk.com/id1",
        tg="@victim",
        location="Москва, Ленинский 12-34",
    )

    response = client.get(CONTACTS_URL, headers=anon)
    _skip_if_endpoint_secured(response)

    assert response.status_code == 200, "Аноним получает 200 — эндпоинт полностью открыт"
    payload = response.json()
    assert len(payload) == 1, "Аноним видит всех пользователей базы"
    leaked = payload[0]
    assert leaked["email"] == "victim@test.ru", "Утекает email"
    assert leaked["phone"] == "+79990001122", "Утекает телефон"
    assert leaked["vk"] == "https://vk.com/id1", "Утекает ссылка на ВК"
    assert leaked["tg"] == "@victim", "Утекает телеграм"
    assert leaked["location"] == "Москва, Ленинский 12-34", "Утекает адрес проживания"
    assert leaked["user_id"] == victim.user_id


@pytest.mark.xfail(
    strict=True,
    reason=(
        "БАГ: GET /api/contacts объявлен без Depends(get_current_user) — весь справочник "
        "персональных данных (email, телефон, ВК, ТГ, адрес) доступен анониму (main.py:866-868)"
    ),
)
def test_анониму_должны_отказывать_в_справочнике_контактов(client, anon, make_user):
    """Справочник персональных данных обязан требовать авторизацию."""
    make_user()
    response = client.get(CONTACTS_URL, headers=anon)
    assert response.status_code == 401, (
        "Неавторизованный запрос к справочнику контактов обязан получать 401"
    )


@pytest.mark.parametrize(
    "header_name",
    ["мусорный_токен", "просроченный_токен", "чужая_подпись", "refresh_токен", "без_схемы"],
)
def test_любой_невалидный_токен_не_мешает_выгрузить_справочник(
    client,
    make_user,
    expired_access_token,
    foreign_signed_token,
    refresh_typed_token,
    header_name,
):
    """
    ДОКУМЕНТИРУЕТ ДЕФЕКТ: раз авторизации нет, качество токена не проверяется вообще —
    мусор в заголовке Authorization даёт тот же полный справочник.
    """
    actor = make_user()
    tokens = {
        "мусорный_токен": "Bearer not-a-jwt-at-all",
        "просроченный_токен": f"Bearer {expired_access_token(actor.user_id)}",
        "чужая_подпись": f"Bearer {foreign_signed_token(actor.user_id)}",
        "refresh_токен": f"Bearer {refresh_typed_token(actor.user_id)}",
        "без_схемы": "not-a-scheme-at-all",
    }

    response = client.get(CONTACTS_URL, headers={"Authorization": tokens[header_name]})
    _skip_if_endpoint_secured(response)

    assert response.status_code == 200, f"Токен вида {header_name} не влияет на выдачу"
    assert _ids(response.json()) == {actor.user_id}


def test_забаненный_пользователь_тоже_получает_справочник(client, banned_user):
    """ДОКУМЕНТИРУЕТ ДЕФЕКТ: бан не мешает выгрузить контакты — авторизации нет."""
    response = client.get(CONTACTS_URL, headers=banned_user.headers)
    _skip_if_endpoint_secured(response)

    assert response.status_code == 200
    assert _ids(response.json()) == {banned_user.user_id}


def test_токен_удалённого_пользователя_не_мешает_получить_справочник(client, make_user):
    """ДОКУМЕНТИРУЕТ ДЕФЕКТ: токен удалённого аккаунта тоже «работает»."""
    ghost = make_user()
    alive = make_user()
    db.delete_user(ghost.user_id)

    response = client.get(CONTACTS_URL, headers=ghost.headers)
    _skip_if_endpoint_secured(response)

    assert response.status_code == 200
    assert _ids(response.json()) == {alive.user_id}, "Удалённый пользователь исчез из справочника"


# ═══════════════════════════════════════════════════════════════════
#  GET /api/contacts — форма ответа и содержимое
# ═══════════════════════════════════════════════════════════════════


def test_справочник_возвращает_все_поля_contactinfoout(client, make_user, admin):
    """Счастливый путь: 200 и полный ContactInfoOut со всеми полями и типами."""
    target = make_user(
        email="full@test.ru",
        name="Иван",
        surname="Петров",
        patronymic="Сергеевич",
        kkr_name="Иван Петров",
        group_number="215",
        location="общежитие ДСВ",
        phone="+79161234567",
        vk="https://vk.com/ivan",
        tg="@ivan",
        budget=False,
        in_profcom=True,
        photo_url="https://global.s3.cloud.ru/test-bucket/avatars/x.jpg",
    )

    response = client.get(CONTACTS_URL, headers=admin.headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload, list), "Ответ обязан быть списком"

    item = next(c for c in payload if c["user_id"] == target.user_id)
    _assert_contact_shape(item)
    assert item == {
        "user_id": target.user_id,
        "email": "full@test.ru",
        "surname": "Петров",
        "name": "Иван",
        "patronymic": "Сергеевич",
        "kkr_name": "Иван Петров",
        "group_number": "215",
        "location": "общежитие ДСВ",
        "blocks": "",
        "phone": "+79161234567",
        "vk": "https://vk.com/ivan",
        "tg": "@ivan",
        "budget": False,
        "in_profcom": True,
        "photo_url": "https://global.s3.cloud.ru/test-bucket/avatars/x.jpg",
    }, "Тело ответа должно совпадать с данными, записанными в базу"


def test_пустая_база_даёт_пустой_список(client):
    """Если пользователей нет — 200 и пустой список, а не 404."""
    response = client.get(CONTACTS_URL)
    _skip_if_endpoint_secured(response)
    assert response.status_code == 200
    assert response.json() == [], "На пустой базе справочник обязан быть пустым списком"


def test_photo_url_берётся_из_таблицы_users(client, make_user, admin):
    """
    photo_url отсутствует в contact_info: _contact_orm_to_dc (database.py:310)
    подтягивает его из связанного users. Проверяем, что связь работает.
    """
    target = make_user(photo_url=None)
    db.update_user(target.user_id, photo_url="https://cdn.test/photo.png")

    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    item = next(c for c in payload if c["user_id"] == target.user_id)
    assert item["photo_url"] == "https://cdn.test/photo.png", (
        "photo_url обязан подтягиваться из users, а не быть null"
    )


def test_photo_url_null_если_фото_нет(client, make_user, admin):
    """Без фото поле обязано быть null, а не пустой строкой."""
    target = make_user(photo_url=None)
    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    item = next(c for c in payload if c["user_id"] == target.user_id)
    assert item["photo_url"] is None


def test_справочник_отдаёт_всех_пользователей_включая_забаненных_и_админов(
    client, make_user, admin, superuser, banned_user
):
    """Никакой фильтрации по роли или бану в списке нет."""
    plain = make_user()
    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    assert _ids(payload) == {plain.user_id, admin.user_id, superuser.user_id, banned_user.user_id}


def test_порядок_справочника_по_возрастанию_user_id(client, make_user, admin):
    """
    db.list_contacts не задаёт ORDER BY (database.py:625-632); SQLite отдаёт строки
    в порядке PK (он же rowid). Фиксируем фактический порядок — по возрастанию user_id.
    """
    first = make_user(name="Первый")
    second = make_user(name="Второй")
    third = make_user(name="Третий")

    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    ids = [c["user_id"] for c in payload if c["user_id"] != admin.user_id]
    assert ids == sorted(ids), "Порядок обязан быть по возрастанию user_id"
    assert ids == [first.user_id, second.user_id, third.user_id]


def test_поле_blocks_содержит_блоки_через_запятую(client, make_user, make_block, admin):
    """Блоки хранятся отсортированной строкой через запятую без пробелов."""
    make_block(name="Медиа", master="Мастер Мастеров")
    make_block(name="Спорт", master="Мастер Мастеров")
    target = _join_blocks(make_user, ["Спорт", "Медиа"])

    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    item = next(c for c in payload if c["user_id"] == target.user_id)
    assert item["blocks"] == "Медиа,Спорт", "Блоки сортируются и склеиваются запятой"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "БАГ: при создании пользователя _sync_blocks_for_user получает ещё не сброшенный в БД "
        "ContactInfoORM (session.get на pending-объекте при autoflush=False, database.py:360 "
        "и database.py:488-509), поэтому users.blocks заполняется, а contact_info.blocks "
        "остаётся пустым — справочник и фильтр показывают человека без блоков"
    ),
)
def test_блоки_в_справочнике_должны_совпадать_с_блоками_пользователя(
    client, make_user, make_block, admin
):
    """users.blocks и contact_info.blocks обязаны быть синхронны сразу после создания."""
    make_block(name="Медиа", master="Мастер Мастеров")
    target = make_user(blocks="Медиа")

    assert db.get_user(target.user_id).blocks == "Медиа", "В users блок записался"
    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    item = next(c for c in payload if c["user_id"] == target.user_id)
    assert item["blocks"] == "Медиа", (
        "В справочнике блок обязан быть тем же, что и в users"
    )


def test_несуществующий_блок_не_попадает_в_поле_blocks(client, make_user, admin):
    """
    _sync_blocks_for_user (database.py:369) молча выбрасывает блоки, которых нет
    в таблице block. Фиксируем: запрошенный несуществующий блок просто теряется.
    """
    target = make_user(blocks="Несуществующий")
    payload = client.get(CONTACTS_URL, headers=admin.headers).json()
    item = next(c for c in payload if c["user_id"] == target.user_id)
    assert item["blocks"] == "", "Несуществующий блок молча отбрасывается"


def test_запрос_справочника_не_меняет_базу(client, make_user, admin):
    """GET обязан быть безопасным: количество контактов и пользователей не меняется."""
    make_user()
    before = [(c.user_id, c.email, c.blocks) for c in db.list_contacts()]

    assert client.get(CONTACTS_URL, headers=admin.headers).status_code == 200

    after = [(c.user_id, c.email, c.blocks) for c in db.list_contacts()]
    assert after == before, "GET /api/contacts не должен ничего писать в базу"


# ═══════════════════════════════════════════════════════════════════
#  POST /api/contacts/filter — авторизация
# ═══════════════════════════════════════════════════════════════════


def test_фильтр_без_токена_отдаёт_401(client, anon, make_user):
    """Аноним не имеет доступа к фильтрации контактов."""
    make_user()
    response = client.post(FILTER_URL, json={}, headers=anon)
    assert response.status_code == 401, response.text
    assert response.json()["detail"] == "Not authenticated"


@pytest.mark.parametrize(
    ("header", "expected_detail"),
    [
        ("Bearer not-a-jwt", "Access token invalid or expired"),
        # Пустой токен проходит проверку схемы и падает уже на разборе JWT
        ("Bearer ", "Access token invalid or expired"),
        ("bearer", "Access token invalid or expired"),
        ("Basic YWRtaW46YWRtaW4=", "Not authenticated"),
        ("plain-token-without-scheme", "Not authenticated"),
        ("Bearer a.b.c", "Access token invalid or expired"),
    ],
)
def test_фильтр_с_некорректным_заголовком_авторизации_отдаёт_401(
    client, make_user, header, expected_detail
):
    """Любой сломанный заголовок Authorization — 401 с понятным detail."""
    make_user()
    response = client.post(FILTER_URL, json={}, headers={"Authorization": header})
    assert response.status_code == 401, response.text
    assert response.json()["detail"] == expected_detail


def test_фильтр_с_просроченным_токеном_отдаёт_401(client, admin, expired_access_token):
    """Просроченный access-токен не принимается."""
    token = expired_access_token(admin.user_id)
    response = client.post(FILTER_URL, json={}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Access token invalid or expired"


def test_фильтр_с_refresh_типом_токена_отдаёт_401(client, admin, refresh_typed_token):
    """JWT с type=refresh не должен пускать туда, где нужен access (auth.py:75-77)."""
    token = refresh_typed_token(admin.user_id)
    response = client.post(FILTER_URL, json={}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Not an access token"


def test_фильтр_с_чужой_подписью_отдаёт_401(client, admin, foreign_signed_token):
    """Токен, подписанный другим секретом, отвергается."""
    token = foreign_signed_token(admin.user_id)
    response = client.post(FILTER_URL, json={}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Access token invalid or expired"


def test_фильтр_с_токеном_удалённого_пользователя_отдаёт_401(client, make_user):
    """После удаления аккаунта его access-токен обязан перестать работать."""
    ghost = make_user(admin=True)
    db.delete_user(ghost.user_id)
    response = client.post(FILTER_URL, json={}, headers=ghost.headers)
    assert response.status_code == 401
    assert response.json()["detail"] == "User not found"


def test_забаненный_админ_получает_403_бан_раньше_проверки_прав(client, make_user):
    """Бан проверяется в get_current_user, то есть раньше require_admin."""
    banned_admin = make_user(admin=True, banned=True)
    response = client.post(FILTER_URL, json={}, headers=banned_admin.headers)
    assert response.status_code == 403
    assert response.json()["detail"] == "User is banned"


def test_обычный_пользователь_получает_403_admin_rights_required(client, user):
    """Пользователь без прав получает ровно 'Admin rights required' (auth.py:117)."""
    response = client.post(FILTER_URL, json={}, headers=user.headers)
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "Admin rights required"


def test_админ_получает_200(client, admin):
    """admin=True достаточно для фильтрации."""
    response = client.post(FILTER_URL, json={}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {admin.user_id}


def test_суперпользователь_получает_200(client, superuser):
    """super_user проходит require_admin даже без admin=True."""
    assert db.get_user(superuser.user_id).admin is False, "Фикстура не ставит admin вручную"
    response = client.post(FILTER_URL, json={}, headers=superuser.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {superuser.user_id}


def test_мастер_блока_получает_200(client, make_master):
    """Мастер блока автоматически получает admin=True и проходит фильтр."""
    master, _block = make_master(block_name="Медиа")
    assert db.get_user(master.user_id).admin is True
    response = client.post(FILTER_URL, json={}, headers=master.headers)
    assert response.status_code == 200, response.text


def test_hr_блока_получает_200(client, make_hr):
    """HR блока тоже получает admin=True (database.py:463-467)."""
    hr, _block = make_hr(block_name="Медиа")
    assert db.get_user(hr.user_id).admin is True
    response = client.post(FILTER_URL, json={}, headers=hr.headers)
    assert response.status_code == 200, response.text


def test_авторизация_проверяется_раньше_валидации_тела(client, anon):
    """Аноним с заведомо невалидным телом обязан получить 401, а не 422."""
    response = client.post(FILTER_URL, json={"group_number": 101}, headers=anon)
    assert response.status_code == 401, response.text
    assert response.json()["detail"] == "Not authenticated"


def test_обычному_пользователю_403_даже_при_невалидном_теле(client, user):
    """Проверка прав тоже идёт раньше валидации тела."""
    response = client.post(FILTER_URL, json={"in_profcom": "не-булево"}, headers=user.headers)
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "Admin rights required"


def test_get_на_фильтр_отдаёт_405(client, admin):
    """Маршрут объявлен только для POST."""
    response = client.get(FILTER_URL, headers=admin.headers)
    assert response.status_code == 405


# ═══════════════════════════════════════════════════════════════════
#  POST /api/contacts/filter — валидация тела
# ═══════════════════════════════════════════════════════════════════


def test_отсутствующее_тело_отдаёт_422(client, admin):
    """ContactFilter объявлен обязательным параметром — без тела 422."""
    response = client.post(FILTER_URL, headers=admin.headers)
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["type"] == "missing"


@pytest.mark.parametrize("body", [[], "строка", 42, True], ids=["список", "строка", "число", "bool"])
def test_тело_не_объект_отдаёт_422(client, admin, body):
    """Тело обязано быть JSON-объектом."""
    response = client.post(FILTER_URL, json=body, headers=admin.headers)
    assert response.status_code == 422, response.text


def test_group_number_числом_отдаёт_422(client, admin, make_user):
    """
    ФИКСИРУЕМ ПОВЕДЕНИЕ: ContactFilter.group_number — строка, а pydantic v2
    не приводит int к str. Фронт, отправивший номер группы числом, получит 422.
    """
    make_user(group_number="101")
    response = client.post(FILTER_URL, json={"group_number": 101}, headers=admin.headers)
    assert response.status_code == 422, response.text
    error = response.json()["detail"][0]
    assert error["type"] == "string_type"
    assert error["loc"][-1] == "group_number"


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"blocks": ["Медиа"]}, "blocks"),
        ({"blocks": 5}, "blocks"),
        ({"group_number": {"$ne": None}}, "group_number"),
        ({"in_profcom": "не-булево"}, "in_profcom"),
        ({"in_profcom": []}, "in_profcom"),
        ({"budget": "может быть"}, "budget"),
        ({"budget": 2}, "budget"),
    ],
)
def test_неверные_типы_полей_фильтра_отдают_422(client, admin, body, field):
    """Каждое поле фильтра валидируется pydantic отдельно."""
    response = client.post(FILTER_URL, json=body, headers=admin.headers)
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"][-1] == field


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("true", True), ("false", False), ("1", True), ("0", False), (1, True), (0, False),
     ("yes", True), ("no", False)],
)
def test_булевы_поля_принимают_строки_и_числа(client, make_user, admin, raw, expected):
    """pydantic v2 в lax-режиме приводит 'true'/'1'/'yes' к bool — фиксируем это."""
    yes = make_user(in_profcom=True)
    no = make_user(in_profcom=False)

    response = client.post(FILTER_URL, json={"in_profcom": raw}, headers=admin.headers)
    assert response.status_code == 200, response.text
    expected_id = yes.user_id if expected else no.user_id
    assert expected_id in _ids(response.json())
    assert (yes.user_id if not expected else no.user_id) not in _ids(response.json())


def test_явные_null_равносильны_отсутствию_фильтра(client, make_user, admin):
    """None по каждому полю означает «не фильтровать» (database.py:637-644)."""
    other = make_user()
    body = {"group_number": None, "blocks": None, "in_profcom": None, "budget": None}
    response = client.post(FILTER_URL, json=body, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {other.user_id, admin.user_id}


def test_неизвестные_ключи_фильтра_игнорируются(client, make_user, admin):
    """ContactFilter не запрещает лишние ключи — они просто отбрасываются."""
    other = make_user()
    body = {"kkr_name": "Кто-то", "email": "x@y.z", "banned": True, "limit": 1}
    response = client.post(FILTER_URL, json=body, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {other.user_id, admin.user_id}, (
        "Неизвестные ключи не сужают выборку"
    )


# ═══════════════════════════════════════════════════════════════════
#  POST /api/contacts/filter — семантика фильтрации
# ═══════════════════════════════════════════════════════════════════


def test_пустой_фильтр_возвращает_всех(client, make_user, admin):
    """{} — ни одного критерия, значит весь справочник."""
    a = make_user()
    b = make_user()
    response = client.post(FILTER_URL, json={}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {a.user_id, b.user_id, admin.user_id}


def test_форма_ответа_фильтра_совпадает_с_contactinfoout(client, make_user, admin):
    """Фильтр отдаёт те же ContactInfoOut, что и GET /api/contacts."""
    target = make_user(
        group_number="303",
        phone="+70000000000",
        vk="https://vk.com/t",
        tg="@t",
        in_profcom=True,
        budget=False,
    )
    response = client.post(FILTER_URL, json={"group_number": "303"}, headers=admin.headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload) == 1
    _assert_contact_shape(payload[0])
    assert payload[0]["user_id"] == target.user_id
    assert payload[0]["phone"] == "+70000000000"
    assert payload[0]["in_profcom"] is True
    assert payload[0]["budget"] is False


def test_фильтр_по_номеру_группы(client, make_user, admin):
    """group_number сравнивается строго по равенству строк."""
    g101 = make_user(group_number="101")
    make_user(group_number="102")
    response = client.post(FILTER_URL, json={"group_number": "101"}, headers=admin.headers)
    assert response.status_code == 200
    assert _ids(response.json()) == {g101.user_id, admin.user_id}, (
        "Админ тоже из 101 группы по умолчанию"
    )


def test_фильтр_по_несуществующей_группе_даёт_пустой_список(client, make_user, admin):
    """Нет совпадений — 200 и [], а не 404."""
    make_user(group_number="101")
    response = client.post(FILTER_URL, json={"group_number": "999"}, headers=admin.headers)
    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.parametrize("value", ["", " 101 ", "101 ", "١٠١", "10", "101,102"])
def test_группа_сравнивается_точной_строкой(client, make_user, admin, value):
    """Ни пробелы, ни подстроки, ни юникодные цифры не должны совпадать со '101'."""
    make_user(group_number="101")
    response = client.post(FILTER_URL, json={"group_number": value}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert response.json() == [], f"Значение {value!r} не должно совпасть с группой '101'"


def test_очень_длинная_строка_фильтра_обрабатывается(client, make_user, admin):
    """10 000 символов не ломают запрос — просто пустая выдача."""
    make_user(group_number="101")
    response = client.post(FILTER_URL, json={"group_number": "9" * 10_000}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert response.json() == []


def test_юникод_и_эмодзи_в_фильтре_безопасны(client, make_user, admin):
    """Экзотические символы не приводят к ошибке 500."""
    make_user(group_number="101")
    response = client.post(
        FILTER_URL, json={"group_number": "🙂 группа", "blocks": "Ω≈ç√"}, headers=admin.headers
    )
    assert response.status_code == 200, response.text
    assert response.json() == []


def test_кавычки_в_фильтре_не_ломают_запрос(client, make_user, admin):
    """Проверка на SQL-инъекцию: значение уходит параметром, выдача пустая."""
    make_user(group_number="101")
    response = client.post(
        FILTER_URL, json={"group_number": "101' OR '1'='1"}, headers=admin.headers
    )
    assert response.status_code == 200, response.text
    assert response.json() == [], "Инъекция не должна расширять выборку"
    assert len(db.list_contacts()) == 2, "База цела"


def test_фильтр_по_in_profcom_true(client, make_user, admin):
    """in_profcom=True возвращает только членов профкома."""
    inside = make_user(in_profcom=True)
    make_user(in_profcom=False)
    response = client.post(FILTER_URL, json={"in_profcom": True}, headers=admin.headers)
    assert response.status_code == 200
    assert _ids(response.json()) == {inside.user_id}


def test_фильтр_по_in_profcom_false(client, make_user, admin):
    """in_profcom=False возвращает только тех, кто не в профкоме."""
    make_user(in_profcom=True)
    outside = make_user(in_profcom=False)
    response = client.post(FILTER_URL, json={"in_profcom": False}, headers=admin.headers)
    assert response.status_code == 200
    assert _ids(response.json()) == {outside.user_id, admin.user_id}


def test_фильтр_по_budget_true(client, make_user, admin):
    """budget=True — только бюджетники."""
    budget = make_user(budget=True)
    make_user(budget=False)
    response = client.post(FILTER_URL, json={"budget": True}, headers=admin.headers)
    assert response.status_code == 200
    assert _ids(response.json()) == {budget.user_id, admin.user_id}


def test_фильтр_по_budget_false(client, make_user, admin):
    """budget=False — только платники."""
    make_user(budget=True)
    paid = make_user(budget=False)
    response = client.post(FILTER_URL, json={"budget": False}, headers=admin.headers)
    assert response.status_code == 200
    assert _ids(response.json()) == {paid.user_id}


def test_фильтр_по_блоку_находит_участника_одного_блока(client, make_user, make_block, admin):
    """Пользователь ровно одного блока находится по имени этого блока."""
    make_block(name="Медиа", master="Мастер Мастеров")
    member = _join_blocks(make_user, ["Медиа"])
    make_user()

    response = client.post(FILTER_URL, json={"blocks": "Медиа"}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {member.user_id}


def test_фильтр_по_блоку_совпадает_только_с_полной_строкой_блоков(
    client, make_user, make_block, admin
):
    """
    ФИКСИРУЕМ ФАКТИЧЕСКУЮ СЕМАНТИКУ: db.filter_contacts (database.py:639-640) сравнивает
    contact_info.blocks == criteria['blocks'] строгим равенством, а не подстрокой.
    Значит участник двух блоков находится ТОЛЬКО по полной строке 'Медиа,Спорт'.
    """
    make_block(name="Медиа", master="Мастер Мастеров")
    make_block(name="Спорт", master="Мастер Мастеров")
    multi = _join_blocks(make_user, ["Медиа", "Спорт"])

    exact = client.post(FILTER_URL, json={"blocks": "Медиа,Спорт"}, headers=admin.headers)
    assert exact.status_code == 200, exact.text
    assert _ids(exact.json()) == {multi.user_id}, "Полная строка блоков совпадает"

    with_space = client.post(FILTER_URL, json={"blocks": "Медиа, Спорт"}, headers=admin.headers)
    assert with_space.json() == [], "Лишний пробел ломает совпадение — сравнение строгое"

    reordered = client.post(FILTER_URL, json={"blocks": "Спорт,Медиа"}, headers=admin.headers)
    assert reordered.json() == [], "Порядок блоков важен — база хранит их отсортированными"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "БАГ: db.filter_contacts сравнивает blocks строгим равенством (database.py:639-640), "
        "хотя блоки хранятся списком через запятую — пользователь, состоящий более чем "
        "в одном блоке, не находится фильтром по одному блоку (main.py:871-877)"
    ),
)
def test_фильтр_по_блоку_должен_находить_участника_нескольких_блоков(
    client, make_user, make_block, admin
):
    """Фильтр «покажи всех из блока Медиа» обязан находить и тех, кто состоит ещё где-то."""
    make_block(name="Медиа", master="Мастер Мастеров")
    make_block(name="Спорт", master="Мастер Мастеров")
    multi = _join_blocks(make_user, ["Медиа", "Спорт"])

    response = client.post(FILTER_URL, json={"blocks": "Медиа"}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert multi.user_id in _ids(response.json()), (
        "Участник блока Медиа обязан попадать в выборку по этому блоку"
    )


def test_фильтр_по_блоку_регистрозависим(client, make_user, make_block, admin):
    """ФИКСИРУЕМ: сравнение в SQLite без COLLATE NOCASE — регистр имеет значение."""
    make_block(name="Медиа", master="Мастер Мастеров")
    _join_blocks(make_user, ["Медиа"])

    response = client.post(FILTER_URL, json={"blocks": "медиа"}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert response.json() == [], "Регистр имени блока учитывается"


def test_пустая_строка_блока_выбирает_пользователей_без_блоков(
    client, make_user, make_block, admin
):
    """
    ФИКСИРУЕМ: '' — не то же самое, что None. Код проверяет `is not None`
    (database.py:639), поэтому blocks='' означает «без единого блока».
    """
    make_block(name="Медиа", master="Мастер Мастеров")
    _join_blocks(make_user, ["Медиа"])
    blockless = make_user()

    response = client.post(FILTER_URL, json={"blocks": ""}, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {blockless.user_id, admin.user_id}


def test_фильтр_по_несуществующему_блоку_даёт_пустой_список(client, make_user, admin):
    """Имя блока, которого нет в базе, не находит никого."""
    make_user()
    response = client.post(FILTER_URL, json={"blocks": "Астрономия"}, headers=admin.headers)
    assert response.status_code == 200
    assert response.json() == []


def test_комбинация_всех_четырёх_критериев(client, make_user, make_block, admin):
    """Все критерии соединяются через AND."""
    make_block(name="Медиа", master="Мастер Мастеров")
    target = _join_blocks(
        make_user, ["Медиа"], group_number="205", in_profcom=True, budget=True
    )
    _join_blocks(make_user, ["Медиа"], group_number="205", in_profcom=True, budget=False)
    _join_blocks(make_user, ["Медиа"], group_number="206", in_profcom=True, budget=True)
    _join_blocks(make_user, ["Медиа"], group_number="205", in_profcom=False, budget=True)
    make_user(group_number="205", in_profcom=True, budget=True)

    body = {"group_number": "205", "blocks": "Медиа", "in_profcom": True, "budget": True}
    response = client.post(FILTER_URL, json=body, headers=admin.headers)
    assert response.status_code == 200, response.text
    assert _ids(response.json()) == {target.user_id}


def test_комбинация_группы_и_профкома(client, make_user, admin):
    """Два критерия сужают выборку сильнее одного."""
    target = make_user(group_number="310", in_profcom=True)
    make_user(group_number="310", in_profcom=False)
    make_user(group_number="311", in_profcom=True)

    only_group = client.post(FILTER_URL, json={"group_number": "310"}, headers=admin.headers)
    assert len(only_group.json()) == 2

    both = client.post(
        FILTER_URL, json={"group_number": "310", "in_profcom": True}, headers=admin.headers
    )
    assert _ids(both.json()) == {target.user_id}


def test_взаимоисключающая_комбинация_даёт_пустой_список(client, make_user, admin):
    """Совпадений нет — 200 и []."""
    make_user(group_number="777", in_profcom=True)
    response = client.post(
        FILTER_URL, json={"group_number": "777", "in_profcom": False}, headers=admin.headers
    )
    assert response.status_code == 200
    assert response.json() == []


def test_фильтр_не_прячет_забаненных(client, make_user, admin):
    """Бан не влияет на выдачу фильтра — фильтруется contact_info, не users."""
    banned = make_user(banned=True, group_number="404")
    response = client.post(FILTER_URL, json={"group_number": "404"}, headers=admin.headers)
    assert response.status_code == 200
    assert _ids(response.json()) == {banned.user_id}


def test_повторный_одинаковый_запрос_идемпотентен(client, make_user, admin):
    """Фильтрация — чтение: два одинаковых запроса дают идентичный ответ."""
    make_user(group_number="101")
    body = {"group_number": "101"}
    first = client.post(FILTER_URL, json=body, headers=admin.headers)
    second = client.post(FILTER_URL, json=body, headers=admin.headers)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()


def test_фильтрация_не_меняет_базу(client, make_user, admin):
    """Побочных эффектов у POST /contacts/filter быть не должно."""
    make_user(group_number="101", in_profcom=True)
    before = [(c.user_id, c.blocks, c.in_profcom, c.budget) for c in db.list_contacts()]

    client.post(
        FILTER_URL,
        json={"group_number": "101", "in_profcom": True, "budget": True, "blocks": ""},
        headers=admin.headers,
    )

    after = [(c.user_id, c.blocks, c.in_profcom, c.budget) for c in db.list_contacts()]
    assert after == before, "Фильтрация не должна ничего записывать"


def test_выдача_фильтра_подмножество_полного_справочника(client, make_user, admin):
    """Фильтр без критериев обязан совпадать с GET /api/contacts запись в запись."""
    make_user(group_number="101", in_profcom=True)
    make_user(group_number="102", in_profcom=False)

    full = client.get(CONTACTS_URL, headers=admin.headers)
    filtered = client.post(FILTER_URL, json={}, headers=admin.headers)
    assert full.status_code == 200 and filtered.status_code == 200
    assert filtered.json() == full.json(), (
        "Пустой фильтр обязан возвращать тот же список, что и полный справочник"
    )
