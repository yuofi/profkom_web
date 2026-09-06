"""
Тесты эндпоинта POST /api/auth/register (main.py:230).

Покрывается: успешная регистрация и форма ответа, кука refresh_token,
запись в обе таблицы (users + contact_info), вывод kkr_name, хеширование
пароля, значения по умолчанию, дубликаты email, валидация pydantic,
пригодность выданных токенов и побочные эффекты в базе.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import text

import database as database_module
from auth import verify_password
from database import db

REGISTER_URL = "/api/auth/register"

VALID_BODY: dict[str, Any] = {
    "email": "ivan@test.ru",
    "surname": "Иванов",
    "name": "Иван",
    "patronymic": "Иванович",
    "password": "Passw0rd!",
    "group_number": 305,
    "tg": "@ivan_durov",
}


def body(**overrides: Any) -> dict[str, Any]:
    """Валидное тело запроса с точечными правками."""
    data = dict(VALID_BODY)
    data.update(overrides)
    return {k: v for k, v in data.items() if v is not ...}


def row_counts() -> dict[str, int]:
    """Количество строк в таблицах, которые задевает регистрация."""
    with database_module.engine.begin() as conn:
        return {
            table: conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()
            for table in ("users", "contact_info", "refresh_tokens")
        }


def error_types(response) -> list[str]:
    return [item["type"] for item in response.json()["detail"]]


def error_locations(response) -> list[list[str]]:
    return [list(item["loc"]) for item in response.json()["detail"]]


@pytest.fixture(autouse=True)
def _clear_client_cookies(client):
    """
    Клиент живёт всю сессию, а регистрация ставит куку refresh_token.
    Без очистки кука протекала бы в соседние тесты и ломала их изоляцию.
    """
    client.cookies.clear()
    yield
    client.cookies.clear()


# ═══════════════════════════════════════════════════════════
#  1. Успешный сценарий: код, тело ответа, кука
# ═══════════════════════════════════════════════════════════
def test_успешная_регистрация_возвращает_201(client):
    """Регистрация нового пользователя отвечает 201 Created."""
    response = client.post(REGISTER_URL, json=body())
    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"


def test_успешная_регистрация_возвращает_полную_пару_токенов(client):
    """Тело ответа — ровно TokenPair: access_token, refresh_token, token_type."""
    payload = client.post(REGISTER_URL, json=body()).json()

    assert set(payload) == {"access_token", "refresh_token", "token_type"}, (
        f"Ответ должен содержать ровно поля TokenPair, получено: {sorted(payload)}"
    )
    assert isinstance(payload["access_token"], str), "access_token должен быть строкой"
    assert isinstance(payload["refresh_token"], str), "refresh_token должен быть строкой"
    assert payload["token_type"] == "bearer", "token_type должен быть 'bearer'"
    assert payload["access_token"].count(".") == 2, "access_token должен быть JWT из трёх частей"
    assert uuid.UUID(payload["refresh_token"]), "refresh_token должен быть UUID-строкой"


def test_в_ответе_нет_пароля_и_идентификатора_пользователя(client):
    """Ответ регистрации не должен утекать пароль или внутренние поля пользователя."""
    raw = client.post(REGISTER_URL, json=body()).text
    assert VALID_BODY["password"] not in raw, "Пароль не должен возвращаться клиенту"
    for leaked in ("hashed_password", "user_id", "admin", "super_user"):
        assert leaked not in raw, f"Поле {leaked} не должно попадать в ответ регистрации"


def test_кука_refresh_token_выставляется_с_нужными_атрибутами(client):
    """Set-Cookie: httponly, Max-Age = 7 суток, Path=/, SameSite=none, Secure."""
    response = client.post(REGISTER_URL, json=body())
    raw = response.headers.get("set-cookie")

    assert raw is not None, "Заголовок Set-Cookie должен присутствовать"
    assert raw.startswith(f"refresh_token={response.json()['refresh_token']}"), (
        f"Кука должна содержать выданный refresh_token, получено: {raw}"
    )
    attributes = {part.strip().lower() for part in raw.split(";")[1:]}
    assert "httponly" in attributes, f"Кука обязана быть HttpOnly, получено: {raw}"
    assert "secure" in attributes, f"Кука обязана быть Secure, получено: {raw}"
    assert "max-age=604800" in attributes, (
        f"Max-Age должен равняться REFRESH_TOKEN_EXPIRE_DAYS*86400 = 604800, получено: {raw}"
    )
    assert "samesite=none" in attributes, f"SameSite должен быть none, получено: {raw}"
    assert "path=/" in attributes, f"Path должен быть /, получено: {raw}"


def test_значение_куки_совпадает_с_refresh_token_из_тела(client):
    """response.cookies['refresh_token'] == тело ответа."""
    response = client.post(REGISTER_URL, json=body())
    assert response.cookies["refresh_token"] == response.json()["refresh_token"], (
        "Кука и тело ответа должны нести один и тот же refresh_token"
    )


# ═══════════════════════════════════════════════════════════
#  2. Побочные эффекты в базе
# ═══════════════════════════════════════════════════════════
def test_создаются_ровно_одна_запись_пользователя_и_один_контакт(client):
    """Одна регистрация = одна строка в users, одна в contact_info, один refresh-токен."""
    assert row_counts() == {"users": 0, "contact_info": 0, "refresh_tokens": 0}, "База должна быть пустой до теста"

    client.post(REGISTER_URL, json=body())

    assert row_counts() == {"users": 1, "contact_info": 1, "refresh_tokens": 1}, (
        "Регистрация должна создать ровно по одной строке в users, contact_info и refresh_tokens"
    )


def test_контакт_сохраняет_переданные_поля(client):
    """Все переданные поля контакта попадают в contact_info без искажений."""
    client.post(REGISTER_URL, json=body())

    user = db.get_user_by_email("ivan@test.ru")
    assert user is not None, "Пользователь должен находиться по email"
    contact = db.get_contact(user.user_id)
    assert contact is not None, "Контакт должен создаваться вместе с пользователем"

    assert contact.email == "ivan@test.ru", "email должен сохраняться как есть"
    assert contact.surname == "Иванов", "Фамилия должна сохраняться"
    assert contact.name == "Иван", "Имя должно сохраняться"
    assert contact.patronymic == "Иванович", "Отчество должно сохраняться"
    assert contact.tg == "@ivan_durov", "Телеграм должен сохраняться как есть, вместе с @"


def test_серверные_поля_контакта_по_умолчанию_пустые(client):
    """location/blocks/phone/vk/photo_url на регистрации не заполняются."""
    client.post(REGISTER_URL, json=body())
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)

    assert contact.location == "", "location при регистрации должен быть пустым"
    assert contact.blocks == "", "blocks при регистрации должен быть пустым"
    assert contact.phone == "", "phone при регистрации должен быть пустым"
    assert contact.vk == "", "vk при регистрации должен быть пустым"
    assert contact.photo_url is None, "photo_url при регистрации должен быть None"


def test_флаги_пользователя_по_умолчанию(client):
    """budget=True, in_profcom=False, kkr_score=0, banned/super_user/admin=False."""
    client.post(REGISTER_URL, json=body())
    user = db.get_user_by_email("ivan@test.ru")
    contact = db.get_contact(user.user_id)

    assert contact.budget is True, "budget по умолчанию должен быть True"
    assert contact.in_profcom is False, "in_profcom по умолчанию должен быть False"
    assert user.kkr_score == 0, "kkr_score нового пользователя должен быть 0"
    assert user.banned is False, "Новый пользователь не должен быть забанен"
    assert user.super_user is False, "Новый пользователь не должен быть суперюзером"
    assert user.admin is False, "Новый пользователь не должен быть админом"
    assert user.blocks == "", "blocks нового пользователя должен быть пустым"
    assert user.photo_url is None, "photo_url нового пользователя должен быть None"


def test_group_number_хранится_строкой_в_обеих_таблицах(client):
    """int из запроса превращается в строку и в users, и в contact_info."""
    client.post(REGISTER_URL, json=body(group_number=305))
    user = db.get_user_by_email("ivan@test.ru")
    contact = db.get_contact(user.user_id)

    assert isinstance(user.group_number, str), "users.group_number должен быть строкой"
    assert user.group_number == "305", "users.group_number должен быть '305'"
    assert isinstance(contact.group_number, str), "contact_info.group_number должен быть строкой"
    assert contact.group_number == "305", "contact_info.group_number должен быть '305'"


def test_пароль_хранится_bcrypt_хешем(client):
    """В базе лежит bcrypt-хеш, а не открытый пароль."""
    client.post(REGISTER_URL, json=body())
    user = db.get_user_by_email("ivan@test.ru")

    assert user.hashed_password != VALID_BODY["password"], "Пароль не должен храниться в открытом виде"
    assert user.hashed_password.startswith("$2"), (
        f"Ожидали bcrypt-хеш ($2...), получили: {user.hashed_password[:10]!r}"
    )
    assert len(user.hashed_password) == 60, "Длина bcrypt-хеша должна быть 60 символов"
    assert verify_password(VALID_BODY["password"], user.hashed_password), (
        "Сохранённый хеш должен проверяться исходным паролем"
    )
    assert not verify_password("Passw0rd?", user.hashed_password), "Чужой пароль не должен подходить"


def test_refresh_token_сохранён_в_базе_и_привязан_к_пользователю(client):
    """Выданный refresh-токен лежит в refresh_tokens с user_id нового пользователя."""
    tokens = client.post(REGISTER_URL, json=body()).json()
    user = db.get_user_by_email("ivan@test.ru")

    stored = db.get_refresh_token(tokens["refresh_token"])
    assert stored is not None, "Выданный refresh-токен должен сохраняться в базе"
    assert stored["user_id"] == user.user_id, "refresh-токен должен быть привязан к новому пользователю"


# ═══════════════════════════════════════════════════════════
#  3. Вывод kkr_name
# ═══════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    ("name", "surname", "expected"),
    [
        ("Иван", "Иванов", "Иван Иванов"),
        ("Иван", "", "Иван"),
        ("", "Иванов", "Иванов"),
        ("  Иван  ", "  Иванов  ", "Иван Иванов"),
    ],
    ids=["имя_и_фамилия", "только_имя", "только_фамилия", "с_лишними_пробелами"],
)
def test_kkr_name_собирается_как_имя_фамилия(client, name, surname, expected):
    """kkr_name = 'имя фамилия', непустые части обрезаются по краям."""
    client.post(REGISTER_URL, json=body(name=name, surname=surname))
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)
    assert contact.kkr_name == expected, f"Ожидали kkr_name {expected!r}, получили {contact.kkr_name!r}"


@pytest.mark.parametrize(
    ("name", "surname"),
    [("", ""), ("   ", ""), ("", "\t"), ("  ", "   ")],
    ids=["оба_пустые", "имя_пробелы", "фамилия_таб", "оба_пробелы"],
)
def test_kkr_name_падает_на_email_если_имя_и_фамилия_пустые(client, name, surname):
    """Когда имя и фамилия пусты (или из пробелов), kkr_name = email."""
    client.post(REGISTER_URL, json=body(name=name, surname=surname))
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)
    assert contact.kkr_name == "ivan@test.ru", (
        f"Ожидали подстановку email в kkr_name, получили {contact.kkr_name!r}"
    )


def test_имя_и_фамилия_необязательны(client):
    """Без name/surname/patronymic регистрация проходит, поля пустые."""
    payload = {k: v for k, v in VALID_BODY.items() if k not in ("name", "surname", "patronymic")}
    response = client.post(REGISTER_URL, json=payload)

    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)
    assert (contact.name, contact.surname, contact.patronymic) == ("", "", ""), (
        "Непереданные ФИО должны сохраняться пустыми строками"
    )


# ═══════════════════════════════════════════════════════════
#  4. Выданные токены реально работают
# ═══════════════════════════════════════════════════════════
def test_выданный_access_token_работает_на_profile_me(client):
    """Access-токен из ответа регистрации пускает в GET /api/profile/me."""
    tokens = client.post(REGISTER_URL, json=body()).json()

    response = client.get("/api/profile/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})

    assert response.status_code == 200, f"Ожидали 200, получили {response.status_code}: {response.text}"
    data = response.json()
    assert data["email"] == "ivan@test.ru", "Профиль должен принадлежать зарегистрированному пользователю"
    assert data["kkr_name"] == "Иван Иванов", "kkr_name в профиле должен совпадать с выведенным при регистрации"
    assert data["group_number"] == "305", "group_number в профиле — строка '305'"
    assert data["has_password"] is True, "has_password должен быть True после регистрации с паролем"
    assert data["admin"] is False and data["super_user"] is False, "Новый пользователь без прав"


def test_выданный_refresh_token_работает_на_auth_refresh(client):
    """Refresh-токен из ответа регистрации обменивается на новую пару."""
    tokens = client.post(REGISTER_URL, json=body()).json()
    # Кука выставлена с Secure, поэтому по http testserver она не уедет обратно —
    # кладём тот же самый токен в jar вручную, проверяем именно пригодность токена.
    client.cookies.clear()
    client.cookies.set("refresh_token", tokens["refresh_token"])

    response = client.post("/api/auth/refresh")

    assert response.status_code == 200, f"Ожидали 200, получили {response.status_code}: {response.text}"
    new_tokens = response.json()
    assert new_tokens["token_type"] == "bearer", "token_type новой пары — 'bearer'"
    assert new_tokens["refresh_token"] != tokens["refresh_token"], "Refresh-токен должен ротироваться"
    assert db.get_refresh_token(tokens["refresh_token"]) is None, (
        "Старый refresh-токен должен удаляться из базы после обмена"
    )


def test_после_регистрации_можно_залогиниться_тем_же_паролем(client):
    """Пароль, отданный при регистрации, подходит для POST /api/auth/login."""
    client.post(REGISTER_URL, json=body())
    client.cookies.clear()

    response = client.post("/api/auth/login", json={"email": "ivan@test.ru", "password": VALID_BODY["password"]})

    assert response.status_code == 200, f"Ожидали 200, получили {response.status_code}: {response.text}"


# ═══════════════════════════════════════════════════════════
#  5. Дубликаты email
# ═══════════════════════════════════════════════════════════
def test_повторная_регистрация_того_же_email_даёт_409(client):
    """Второй раз тот же email → 409 'Email already registered'."""
    client.post(REGISTER_URL, json=body())
    client.cookies.clear()

    response = client.post(REGISTER_URL, json=body(name="Пётр", surname="Петров", tg="petrov_tg"))

    assert response.status_code == 409, f"Ожидали 409, получили {response.status_code}: {response.text}"
    assert response.json() == {"detail": "Email already registered"}, (
        f"Неверный текст ошибки: {response.text}"
    )


def test_отклонённый_дубликат_не_оставляет_следов_в_базе(client):
    """После 409 в базе остаются ровно те строки, что были до попытки."""
    client.post(REGISTER_URL, json=body())
    before = row_counts()
    client.cookies.clear()

    response = client.post(REGISTER_URL, json=body(name="Пётр", surname="Петров"))

    assert response.status_code == 409, "Дубликат должен отклоняться"
    assert row_counts() == before, "Отклонённая регистрация не должна ничего писать в базу"
    assert response.headers.get("set-cookie") is None, "При 409 кука refresh_token выставляться не должна"


def test_первый_аккаунт_остаётся_рабочим_после_отклонённого_дубликата(client):
    """409 по второму запросу не портит уже созданный аккаунт."""
    client.post(REGISTER_URL, json=body())
    client.cookies.clear()
    client.post(REGISTER_URL, json=body(password="Другой1!"))
    client.cookies.clear()

    login = client.post("/api/auth/login", json={"email": "ivan@test.ru", "password": VALID_BODY["password"]})
    assert login.status_code == 200, "Исходный пароль должен продолжать работать после отклонённого дубликата"


def test_регистр_домена_в_email_нормализуется_и_даёт_409(client):
    """ivan@test.ru и ivan@TEST.RU — один и тот же адрес → 409."""
    client.post(REGISTER_URL, json=body())
    client.cookies.clear()

    response = client.post(REGISTER_URL, json=body(email="ivan@TEST.RU"))

    assert response.status_code == 409, (
        f"Домен email регистронезависим, ожидали 409, получили {response.status_code}: {response.text}"
    )


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: проверка уникальности email регистрозависима — db.get_user_by_email сравнивает "
           "строки побайтово (database.py:537), а UNIQUE-индекс ux_contact_info_email тоже BINARY "
           "(database.py:270). Ivan@test.ru регистрируется поверх ivan@test.ru (main.py:246)",
)
def test_регистр_локальной_части_email_не_позволяет_завести_второй_аккаунт(client):
    """Ivan@test.ru — тот же адрес, что ivan@test.ru: второй регистрации быть не должно."""
    client.post(REGISTER_URL, json=body(email="ivan@test.ru"))
    client.cookies.clear()

    response = client.post(REGISTER_URL, json=body(email="Ivan@test.ru"))

    assert response.status_code == 409, (
        f"Ожидали 409 на дубликат в другом регистре, получили {response.status_code}"
    )
    assert row_counts()["users"] == 1, "Второй аккаунт на тот же email создаваться не должен"


# ═══════════════════════════════════════════════════════════
#  6. Валидация (422)
# ═══════════════════════════════════════════════════════════
@pytest.mark.parametrize("field", ["email", "password", "group_number", "tg"])
def test_отсутствие_обязательного_поля_даёт_422(client, field):
    """Каждое обязательное поле при отсутствии даёт 422 missing."""
    payload = {k: v for k, v in VALID_BODY.items() if k != field}

    response = client.post(REGISTER_URL, json=payload)

    assert response.status_code == 422, f"Ожидали 422 без поля {field}, получили {response.status_code}"
    assert ["body", field] in error_locations(response), (
        f"Ошибка должна указывать на поле {field}: {response.text}"
    )
    assert row_counts()["users"] == 0, "Невалидный запрос не должен создавать пользователя"


def test_пустое_тело_перечисляет_все_обязательные_поля(client):
    """Пустой JSON → 422 со всеми четырьмя обязательными полями."""
    response = client.post(REGISTER_URL, json={})

    assert response.status_code == 422, f"Ожидали 422, получили {response.status_code}"
    missing = {loc[1] for loc in error_locations(response)}
    assert missing == {"email", "password", "group_number", "tg"}, (
        f"Ожидали ошибки по всем обязательным полям, получили {missing}"
    )


def test_не_json_тело_даёт_422(client):
    """Тело, которое не парсится как JSON, отклоняется с 422."""
    response = client.post(REGISTER_URL, content=b"not-a-json", headers={"Content-Type": "application/json"})
    assert response.status_code == 422, f"Ожидали 422, получили {response.status_code}"


def test_список_вместо_объекта_даёт_422(client):
    """JSON-массив вместо объекта отклоняется с 422."""
    response = client.post(REGISTER_URL, json=[VALID_BODY])
    assert response.status_code == 422, f"Ожидали 422, получили {response.status_code}"


def test_get_на_регистрацию_даёт_405(client):
    """Эндпоинт существует только для POST."""
    response = client.get(REGISTER_URL)
    assert response.status_code == 405, f"Ожидали 405 Method Not Allowed, получили {response.status_code}"


@pytest.mark.parametrize(
    "email",
    ["notanemail", "a@", "@test.ru", "", "a b@test.ru", "ivan@test", "ivan@@test.ru", "ivan@.ru", "   "],
    ids=["без_собаки", "без_домена", "без_локальной_части", "пустая_строка",
         "пробел_внутри", "домен_без_точки", "две_собаки", "точка_в_начале_домена", "только_пробелы"],
)
def test_некорректный_email_даёт_422(client, email):
    """EmailStr отбраковывает синтаксически неверные адреса."""
    response = client.post(REGISTER_URL, json=body(email=email))

    assert response.status_code == 422, f"Ожидали 422 для email {email!r}, получили {response.status_code}"
    assert ["body", "email"] in error_locations(response), f"Ошибка должна указывать на email: {response.text}"
    assert row_counts()["users"] == 0, "Пользователь с некорректным email не должен создаваться"


@pytest.mark.parametrize("group_number", [99, 0, -1, 701, 1000, 100000], ids=str)
def test_group_number_вне_диапазона_даёт_422(client, group_number):
    """Поле ограничено ge=100, le=700."""
    response = client.post(REGISTER_URL, json=body(group_number=group_number))

    assert response.status_code == 422, (
        f"Ожидали 422 для group_number={group_number}, получили {response.status_code}"
    )
    assert error_types(response)[0] in ("greater_than_equal", "less_than_equal"), (
        f"Ожидали ошибку границы диапазона: {response.text}"
    )
    assert row_counts()["users"] == 0, "Пользователь с невалидной группой не должен создаваться"


@pytest.mark.parametrize("group_number", [100, 305, 700], ids=str)
def test_границы_диапазона_group_number_принимаются(client, group_number):
    """100 и 700 включительно — валидные значения."""
    response = client.post(REGISTER_URL, json=body(group_number=group_number))

    assert response.status_code == 201, (
        f"group_number={group_number} должен приниматься, получили {response.status_code}: {response.text}"
    )
    assert db.get_user_by_email("ivan@test.ru").group_number == str(group_number), (
        "Номер группы должен сохраняться строкой"
    )


@pytest.mark.parametrize(
    "group_number",
    ["abc", "", "  ", None, 300.5, [305], {"n": 305}, "0x305", True],
    ids=["буквы", "пустая_строка", "пробелы", "null", "дробное", "массив", "объект", "hex_строка", "bool"],
)
def test_group_number_неверного_типа_даёт_422(client, group_number):
    """Нецелые значения группы отклоняются."""
    response = client.post(REGISTER_URL, json=body(group_number=group_number))

    assert response.status_code == 422, (
        f"Ожидали 422 для group_number={group_number!r}, получили {response.status_code}: {response.text}"
    )
    assert row_counts()["users"] == 0, "Пользователь не должен создаваться при невалидной группе"


def test_group_number_строкой_с_числом_принимается(client):
    """Pydantic в lax-режиме приводит '305' к 305 — фиксируем это поведение."""
    response = client.post(REGISTER_URL, json=body(group_number="305"))

    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"
    assert db.get_user_by_email("ivan@test.ru").group_number == "305", "Группа должна сохраниться как '305'"


@pytest.mark.parametrize(
    "tg",
    ["durov", "@durov", "abcde", "@abcde", "a" * 32, "@" + "a" * 32, "_____", "12345", "Ivan_Durov_1"],
    ids=["без_собаки", "с_собакой", "ровно_5", "собака_и_5", "ровно_32", "собака_и_32",
         "подчёркивания", "цифры", "смешанный"],
)
def test_валидный_tg_принимается(client, tg):
    """Паттерн ^@?[A-Za-z0-9_]{5,32}$ — с ведущей @ и без неё."""
    response = client.post(REGISTER_URL, json=body(tg=tg))

    assert response.status_code == 201, f"tg={tg!r} должен приниматься, получили {response.status_code}"
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)
    assert contact.tg == tg, f"tg должен сохраняться без изменений, получили {contact.tg!r}"


@pytest.mark.parametrize(
    "tg",
    [
        "", "abcd", "@abcd", "a" * 33, "@" + "a" * 33, "иванов_дуров", "ab cde", "@ab cde",
        "dur.ov", "dur-ov", "@@durov", "durov@", "  durov  ", "дуров", "durov!", "@",
    ],
    ids=["пусто", "4_символа", "собака_и_4", "33_символа", "собака_и_33", "кириллица",
         "пробел_внутри", "собака_и_пробел", "точка", "дефис", "две_собаки", "собака_в_конце",
         "пробелы_по_краям", "только_кириллица", "восклицание", "одна_собака"],
)
def test_невалидный_tg_даёт_422(client, tg):
    """Всё, что не проходит паттерн/длину, отклоняется с 422."""
    response = client.post(REGISTER_URL, json=body(tg=tg))

    assert response.status_code == 422, f"Ожидали 422 для tg={tg!r}, получили {response.status_code}"
    assert ["body", "tg"] in error_locations(response), f"Ошибка должна указывать на tg: {response.text}"
    assert row_counts()["users"] == 0, "Пользователь с невалидным tg не должен создаваться"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("email", 5), ("email", None), ("email", ["a@test.ru"]),
        ("password", 12345), ("password", None), ("password", {"p": 1}),
        ("tg", 12345), ("tg", None),
        ("name", 123), ("surname", None), ("patronymic", []),
    ],
    ids=lambda v: str(v)[:20],
)
def test_неверный_тип_поля_даёт_422(client, field, value):
    """Числа/null/массивы вместо строк отклоняются."""
    response = client.post(REGISTER_URL, json=body(**{field: value}))

    assert response.status_code == 422, (
        f"Ожидали 422 для {field}={value!r}, получили {response.status_code}: {response.text}"
    )
    assert row_counts()["users"] == 0, "Пользователь не должен создаваться при неверном типе поля"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: RegisterIn.password не имеет min_length (main.py:83) — регистрация с пустым "
           "паролем проходит и создаёт аккаунт, в который пускает login с пустой строкой",
)
def test_пустой_пароль_отклоняется(client):
    """Пустая строка не является паролем."""
    response = client.post(REGISTER_URL, json=body(password=""))

    assert response.status_code == 422, f"Ожидали 422 на пустой пароль, получили {response.status_code}"
    assert row_counts()["users"] == 0, "Аккаунт с пустым паролем создаваться не должен"


def test_пустой_пароль_всё_равно_хешируется(client):
    """
    Пока пустой пароль принимается (см. xfail выше) — он обязан хотя бы храниться хешем,
    иначе login начнёт считать аккаунт VK-аккаунтом без пароля.
    """
    response = client.post(REGISTER_URL, json=body(password=""))
    assert response.status_code == 201, "Фиксируем текущее поведение: пустой пароль принимается"

    user = db.get_user_by_email("ivan@test.ru")
    assert user.hashed_password.startswith("$2"), "Даже пустой пароль должен храниться bcrypt-хешем"
    assert user.hashed_password != "", "Пустой хеш означал бы 'аккаунт только через VK'"


def test_очень_длинные_строки_принимаются_и_сохраняются(client):
    """Ограничения длины на ФИО нет — проверяем, что данные не режутся и не падают."""
    long_name = "Ю" * 5000
    response = client.post(REGISTER_URL, json=body(name=long_name, surname=""))

    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)
    assert len(contact.name) == 5000, f"Имя не должно обрезаться, длина: {len(contact.name)}"
    assert contact.kkr_name == long_name, "kkr_name должен собираться из полного имени"


def test_очень_длинный_пароль_обрабатывается(client):
    """Длинный пароль либо принимается и хешируется, либо отклоняется — но не 500."""
    response = client.post(REGISTER_URL, json=body(password="П" * 200))

    assert response.status_code in (201, 422), (
        f"Ожидали 201 или 422, получили {response.status_code}: {response.text}"
    )
    if response.status_code == 201:
        user = db.get_user_by_email("ivan@test.ru")
        assert user.hashed_password.startswith("$2"), "Длинный пароль должен храниться bcrypt-хешем"


@pytest.mark.parametrize(
    ("name", "surname", "patronymic"),
    [
        ("Иван", "Иванов", "Иванович"),
        ("Ünal", "Öztürk", "Ş"),
        ("日本", "語", "テスト"),
        ("Ім'я", "Прізвище", "По-батькові"),
        ("Emoji", "Тест", "🙂"),
    ],
    ids=["кириллица", "умляуты", "иероглифы", "украинский_апостроф", "эмодзи"],
)
def test_юникод_в_фио_сохраняется_без_потерь(client, name, surname, patronymic):
    """Юникод проходит через API и базу без искажений."""
    response = client.post(REGISTER_URL, json=body(name=name, surname=surname, patronymic=patronymic))

    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"
    contact = db.get_contact(db.get_user_by_email("ivan@test.ru").user_id)
    assert (contact.name, contact.surname, contact.patronymic) == (name, surname, patronymic), (
        "Юникодные ФИО должны сохраняться посимвольно"
    )
    assert contact.kkr_name == f"{name} {surname}", "kkr_name должен собираться из юникодных частей"


@pytest.mark.parametrize(
    "extra",
    [
        {"admin": True},
        {"super_user": True},
        {"banned": True},
        {"kkr_score": 9999},
        {"budget": False},
        {"in_profcom": True},
        {"user_id": 42},
        {"blocks": "Медиа"},
        {"photo_url": "https://evil.example/pwn.png"},
        {"hashed_password": "$2b$12$fakefakefakefakefakefakefakefakefakefakefakefakefakefake"},
    ],
    ids=lambda v: next(iter(v)),
)
def test_лишние_поля_в_теле_игнорируются(client, extra):
    """Клиент не может выставить себе права или счёт через неизвестные поля."""
    response = client.post(REGISTER_URL, json=body(**extra))

    assert response.status_code == 201, f"Лишнее поле не должно ломать запрос: {response.text}"
    user = db.get_user_by_email("ivan@test.ru")
    contact = db.get_contact(user.user_id)

    assert user.admin is False, "admin из тела запроса должен игнорироваться"
    assert user.super_user is False, "super_user из тела запроса должен игнорироваться"
    assert user.banned is False, "banned из тела запроса должен игнорироваться"
    assert user.kkr_score == 0, "kkr_score из тела запроса должен игнорироваться"
    assert user.blocks == "", "blocks из тела запроса должен игнорироваться"
    assert user.photo_url is None, "photo_url из тела запроса должен игнорироваться"
    assert contact.budget is True, "budget всегда True при регистрации"
    assert contact.in_profcom is False, "in_profcom всегда False при регистрации"
    assert verify_password(VALID_BODY["password"], user.hashed_password), (
        "Хеш должен считаться от переданного пароля, а не браться из тела запроса"
    )


# ═══════════════════════════════════════════════════════════
#  7. Аутентификация: эндпоинт публичный
# ═══════════════════════════════════════════════════════════
def test_регистрация_доступна_без_токена(client, anon):
    """Регистрация — публичный эндпоинт."""
    response = client.post(REGISTER_URL, json=body(), headers=anon)
    assert response.status_code == 201, f"Ожидали 201 без авторизации, получили {response.status_code}"


@pytest.mark.parametrize(
    "header",
    ["Bearer", "Bearer ", "Bearer not.a.jwt", "Basic abc", "Bearer " + "x" * 400, "garbage"],
    ids=["без_токена", "пустой_токен", "не_jwt", "basic", "длинный_мусор", "без_схемы"],
)
def test_битый_заголовок_authorization_не_мешает_регистрации(client, header):
    """Эндпоинт не читает Authorization, любой заголовок игнорируется."""
    response = client.post(REGISTER_URL, json=body(), headers={"Authorization": header})
    assert response.status_code == 201, (
        f"Ожидали 201 с заголовком {header!r}, получили {response.status_code}: {response.text}"
    )


def test_просроченный_токен_не_мешает_регистрации(client, user, expired_access_token):
    """Протухший access-токен в заголовке не влияет на регистрацию."""
    response = client.post(
        REGISTER_URL, json=body(), headers={"Authorization": f"Bearer {expired_access_token(user.user_id)}"}
    )
    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"


def test_refresh_типизированный_токен_не_мешает_регистрации(client, user, refresh_typed_token):
    """JWT с type=refresh в заголовке не влияет на регистрацию."""
    response = client.post(
        REGISTER_URL, json=body(), headers={"Authorization": f"Bearer {refresh_typed_token(user.user_id)}"}
    )
    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"


def test_токен_с_чужой_подписью_не_мешает_регистрации(client, user, foreign_signed_token):
    """Токен, подписанный другим секретом, не влияет на регистрацию."""
    response = client.post(
        REGISTER_URL, json=body(), headers={"Authorization": f"Bearer {foreign_signed_token(user.user_id)}"}
    )
    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"


def test_токен_удалённого_пользователя_не_мешает_регистрации(client, user):
    """Токен пользователя, которого уже нет в базе, не влияет на регистрацию."""
    db.delete_user(user.user_id)
    response = client.post(REGISTER_URL, json=body(), headers=user.headers)
    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"


def test_забаненный_пользователь_может_зарегистрировать_новый_аккаунт(client, banned_user):
    """Бан не влияет на публичную регистрацию — фиксируем текущее поведение."""
    response = client.post(REGISTER_URL, json=body(), headers=banned_user.headers)
    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}: {response.text}"


def test_авторизованный_пользователь_регистрирует_второй_аккаунт(client, user):
    """Наличие валидной сессии не мешает создать ещё один аккаунт."""
    response = client.post(REGISTER_URL, json=body(), headers=user.headers)

    assert response.status_code == 201, f"Ожидали 201, получили {response.status_code}"
    assert response.json()["access_token"] != user.access_token, "Должен выдаваться токен нового аккаунта"
    assert row_counts()["users"] == 2, "Должно стать два пользователя"


# ═══════════════════════════════════════════════════════════
#  8. Повторяемость и права
# ═══════════════════════════════════════════════════════════
def test_две_регистрации_с_разными_email_независимы(client):
    """Каждый вызов создаёт отдельного пользователя со своей парой токенов."""
    first = client.post(REGISTER_URL, json=body(email="a@test.ru", tg="first_tg")).json()
    client.cookies.clear()
    second = client.post(REGISTER_URL, json=body(email="b@test.ru", tg="second_tg")).json()

    assert first["refresh_token"] != second["refresh_token"], "Refresh-токены должны быть разными"
    assert row_counts() == {"users": 2, "contact_info": 2, "refresh_tokens": 2}, (
        "Две регистрации → две пары строк и два refresh-токена"
    )
    assert db.get_user_by_email("a@test.ru").user_id != db.get_user_by_email("b@test.ru").user_id, (
        "Пользователи должны быть разными"
    )


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: _sync_admin_rights вызывается на создании пользователя (database.py:512) и выдаёт "
           "admin=True любому, чей kkr_name ('имя фамилия') совпал с block.master/block.hr — "
           "самоназначение админом через регистрацию (main.py:249)",
)
def test_регистрация_под_именем_мастера_блока_не_даёт_админку(client, make_block):
    """Совпадение ФИО с мастером блока не должно давать права администратора."""
    make_block(name="Медиа", master="Иван Иванов")

    response = client.post(REGISTER_URL, json=body(name="Иван", surname="Иванов"))
    assert response.status_code == 201, "Регистрация должна проходить"

    user = db.get_user_by_email("ivan@test.ru")
    assert user.admin is False, "Регистрация не должна выдавать admin по совпадению ФИО с мастером блока"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: тот же _sync_admin_rights (database.py:512) выдаёт admin=True при совпадении "
           "kkr_name с block.hr — самоназначение админом через регистрацию (main.py:249)",
)
def test_регистрация_под_именем_hr_блока_не_даёт_админку(client, make_block):
    """То же самое для поля hr."""
    make_block(name="Медиа", master="Кто-то Другой", hr="Иван Иванов")

    client.post(REGISTER_URL, json=body(name="Иван", surname="Иванов"))

    user = db.get_user_by_email("ivan@test.ru")
    assert user.admin is False, "Регистрация не должна выдавать admin по совпадению ФИО с HR блока"


def test_два_пользователя_с_одинаковым_kkr_name_регистрируются(client):
    """Уникальность kkr_name не проверяется — фиксируем поведение и отсутствие 500."""
    first = client.post(REGISTER_URL, json=body(email="a@test.ru", tg="first_tg"))
    client.cookies.clear()
    second = client.post(REGISTER_URL, json=body(email="b@test.ru", tg="second_tg"))

    assert (first.status_code, second.status_code) == (201, 201), (
        f"Ожидали две успешные регистрации, получили {first.status_code} и {second.status_code}"
    )
    contacts = [c for c in db.list_contacts() if c.kkr_name == "Иван Иванов"]
    assert len(contacts) == 2, f"Ожидали два контакта с одинаковым kkr_name, получили {len(contacts)}"
