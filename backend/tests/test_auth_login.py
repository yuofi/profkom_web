"""
Тесты POST /api/auth/login и POST /api/auth/change-password.

Разделы:
  1.  login — успешный сценарий и форма ответа
  2.  login — cookie refresh_token
  3.  login — неверные учётные данные (без утечки существования аккаунта)
  4.  login — аккаунт без пароля (VK-only), бан, порядок проверок
  5.  login — валидация тела запроса
  6.  login — побочные эффекты и повторный вход
  7.  change-password — аутентификация
  8.  change-password — счастливый путь и запись в базу
  9.  change-password — old_password
  10. change-password — валидация new_password
  11. change-password — последствия смены пароля
"""
from __future__ import annotations

import uuid

import pytest
from jose import jwt
from sqlalchemy import text

import auth as auth_module
import database as database_module
from database import db

LOGIN_URL = "/api/auth/login"
CHANGE_URL = "/api/auth/change-password"
REFRESH_URL = "/api/auth/refresh"
PROFILE_ME_URL = "/api/profile/me"

INVALID_CREDENTIALS = "Invalid credentials"
NO_PASSWORD = "No password set for this account. Please login via VK."
BANNED = "User is banned"
OLD_REQUIRED = "Old password is required"
OLD_INVALID = "Invalid old password"
CHANGED_OK = "Password updated successfully"

REFRESH_TTL_SECONDS = auth_module.REFRESH_TTL_DAYS * 24 * 60 * 60


# ─────────────────────────────────────────────────────────────
#  Вспомогательные функции (только чтение боевой базы)
# ─────────────────────────────────────────────────────────────
def refresh_tokens_of(user_id: int) -> list[str]:
    """Все refresh-токены пользователя, лежащие в базе."""
    with database_module.engine.begin() as conn:
        rows = conn.execute(
            text("SELECT token FROM refresh_tokens WHERE user_id = :uid"),
            {"uid": user_id},
        ).fetchall()
    return [r[0] for r in rows]


def total_refresh_tokens() -> int:
    with database_module.engine.begin() as conn:
        return conn.execute(text("SELECT COUNT(*) FROM refresh_tokens")).scalar_one()


def stored_hash(user_id: int) -> str:
    user = db.get_user(user_id)
    assert user is not None, "Пользователь исчез из базы"
    return user.hashed_password


def set_cookie_headers(response) -> list[str]:
    return response.headers.get_list("set-cookie")


def parse_set_cookie(raw: str) -> tuple[str, dict[str, str]]:
    """'refresh_token=abc; HttpOnly; Path=/' → ('abc', {'httponly': '', 'path': '/'})."""
    parts = [p.strip() for p in raw.split(";") if p.strip()]
    name_value = parts[0]
    _, _, value = name_value.partition("=")
    attrs: dict[str, str] = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        attrs[k.strip().lower()] = v.strip()
    return value, attrs


def cookie_header(token: str) -> dict[str, str]:
    """Отдельный заголовок Cookie, чтобы не зависеть от общей cookie-банки клиента."""
    return {"Cookie": f"refresh_token={token}"}


# ═════════════════════════════════════════════════════════════
#  1. login — успешный сценарий и форма ответа
# ═════════════════════════════════════════════════════════════
def test_вход_с_верными_данными_возвращает_200(client, user):
    """Правильная пара email/пароль → 200."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"


def test_вход_возвращает_полную_пару_токенов(client, user):
    """Тело ответа содержит ровно access_token, refresh_token, token_type — и ничего лишнего."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    body = r.json()

    assert set(body) == {"access_token", "refresh_token", "token_type"}, (
        f"Неожиданный набор полей в ответе: {sorted(body)}"
    )
    assert isinstance(body["access_token"], str) and body["access_token"], "access_token должен быть непустой строкой"
    assert isinstance(body["refresh_token"], str) and body["refresh_token"], "refresh_token должен быть непустой строкой"
    assert body["token_type"] == "bearer", f"token_type должен быть 'bearer', получено {body['token_type']!r}"


def test_выданный_access_токен_подписан_и_принадлежит_пользователю(client, user):
    """access_token — валидный JWT с sub=user_id и type=access."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    payload = jwt.decode(
        r.json()["access_token"],
        auth_module.SECRET_KEY,
        algorithms=[auth_module.ALGORITHM],
    )
    assert payload["sub"] == str(user.user_id), "sub в access-токене должен совпадать с user_id"
    assert payload["type"] == "access", "тип токена должен быть access"
    assert payload["exp"] > payload["iat"], "exp должен быть позже iat"


def test_выданный_access_токен_пускает_в_защищённый_эндпоинт(client, user):
    """Свежий access-токен реально работает как Bearer."""
    token = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["access_token"]
    r = client.get(PROFILE_ME_URL, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, f"Свежий токен должен пускать в /api/profile/me, получено {r.status_code}: {r.text}"


def test_выданный_refresh_токен_сохранён_в_базе(client, user):
    """Побочный эффект: refresh-токен записан в refresh_tokens и привязан к пользователю."""
    raw = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]

    row = db.get_refresh_token(raw)
    assert row is not None, "refresh-токен обязан быть сохранён в базе"
    assert row["user_id"] == user.user_id, "refresh-токен привязан не к тому пользователю"
    uuid.UUID(raw)  # формат — UUID; конкретное значение не проверяем


def test_вход_доступен_забаненному_после_разбана(client, make_user):
    """Снятие бана возвращает возможность входа (проверка, что бан — не необратимое состояние)."""
    actor = make_user(banned=True)
    assert client.post(LOGIN_URL, json={"email": actor.email, "password": actor.password}).status_code == 403
    db.update_user(actor.user_id, banned=False)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": actor.password})
    assert r.status_code == 200, f"После разбана вход должен работать, получено {r.status_code}: {r.text}"


# ═════════════════════════════════════════════════════════════
#  2. login — cookie refresh_token
# ═════════════════════════════════════════════════════════════
def test_вход_выставляет_cookie_refresh_token(client, user):
    """Успешный вход ставит cookie refresh_token с тем же значением, что и в теле."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    cookies = [c for c in set_cookie_headers(r) if c.startswith("refresh_token=")]
    assert len(cookies) == 1, f"Ожидалась ровно одна cookie refresh_token, получено: {set_cookie_headers(r)}"

    value, _ = parse_set_cookie(cookies[0])
    assert value == r.json()["refresh_token"], "Значение cookie должно совпадать с refresh_token из тела ответа"


@pytest.mark.parametrize(
    "attr, expected",
    [
        ("httponly", ""),
        ("secure", ""),
        ("samesite", "none"),
        ("max-age", str(REFRESH_TTL_SECONDS)),
        ("path", "/"),
    ],
)
def test_атрибуты_cookie_refresh_token(client, user, attr, expected):
    """Cookie должна быть HttpOnly + Secure + SameSite=none и жить REFRESH_TTL_DAYS."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    raw = next(c for c in set_cookie_headers(r) if c.startswith("refresh_token="))
    _, attrs = parse_set_cookie(raw)

    assert attr in attrs, f"В cookie отсутствует атрибут {attr}: {raw}"
    assert attrs[attr].lower() == expected, f"Атрибут {attr}: ожидалось {expected!r}, получено {attrs[attr]!r}"


@pytest.mark.parametrize(
    "payload_factory, expected_status",
    [
        (lambda a: {"email": "no-such-user@test.ru", "password": "Passw0rd!"}, 401),
        (lambda a: {"email": a.email, "password": "wrong-password"}, 401),
    ],
    ids=["неизвестный_email", "неверный_пароль"],
)
def test_неуспешный_вход_не_выставляет_cookie(client, user, payload_factory, expected_status):
    """При отказе cookie refresh_token не ставится."""
    r = client.post(LOGIN_URL, json=payload_factory(user))
    assert r.status_code == expected_status
    assert not [c for c in set_cookie_headers(r) if c.startswith("refresh_token=")], (
        "При отказе во входе cookie refresh_token выставляться не должна"
    )


# ═════════════════════════════════════════════════════════════
#  3. login — неверные учётные данные
# ═════════════════════════════════════════════════════════════
def test_неизвестный_email_даёт_401(client):
    """Несуществующий email → 401 Invalid credentials."""
    r = client.post(LOGIN_URL, json={"email": "ghost@test.ru", "password": "Passw0rd!"})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


def test_неверный_пароль_даёт_401(client, user):
    """Существующий email + чужой пароль → 401 Invalid credentials."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": "Wrong-Password-123"})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


def test_ответы_на_неизвестный_email_и_неверный_пароль_неотличимы(client, user):
    """Нет user enumeration: статус и detail совпадают до символа."""
    unknown = client.post(LOGIN_URL, json={"email": "ghost@test.ru", "password": "Passw0rd!"})
    wrong = client.post(LOGIN_URL, json={"email": user.email, "password": "Passw0rd!!!"})

    assert unknown.status_code == wrong.status_code, "Статусы должны совпадать, иначе email перебираем"
    assert unknown.json() == wrong.json(), "Тела ответов должны совпадать, иначе email перебираем"


@pytest.mark.parametrize(
    "wrong_password",
    ["passw0rd!", "PASSW0RD!", "PaSSw0rd!"],
    ids=["всё_строчными", "всё_прописными", "смешанный_регистр"],
)
def test_пароль_чувствителен_к_регистру(client, user, wrong_password):
    """Тот же пароль в другом регистре не подходит."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": wrong_password})
    assert r.status_code == 401, f"Пароль {wrong_password!r} не должен подходить"
    assert r.json()["detail"] == INVALID_CREDENTIALS


@pytest.mark.parametrize(
    "wrong_password",
    ["Passw0rd! ", " Passw0rd!", "Passw0rd"],
    ids=["пробел_в_конце", "пробел_в_начале", "обрезанный"],
)
def test_пароль_не_обрезается_и_не_нормализуется(client, user, wrong_password):
    """Пробелы и усечение не должны считаться совпадением."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": wrong_password})
    assert r.status_code == 401, f"Пароль {wrong_password!r} не должен подходить"


def test_пустой_пароль_не_подходит_обычному_пользователю(client, user):
    """Пустая строка проходит схему, но не совпадает с хешем → 401."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": ""})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


def test_юникодный_пароль_работает(client, make_user):
    """Пароль из кириллицы и эмодзи логинит, а его вариация — нет."""
    actor = make_user(password="Пароль-Ж🔥1")
    ok = client.post(LOGIN_URL, json={"email": actor.email, "password": "Пароль-Ж🔥1"})
    assert ok.status_code == 200, f"Юникодный пароль должен работать, получено {ok.status_code}: {ok.text}"

    bad = client.post(LOGIN_URL, json={"email": actor.email, "password": "Пароль-Ж🔥2"})
    assert bad.status_code == 401, "Изменённый юникодный пароль не должен подходить"


def test_пароль_только_из_пробелов_работает_как_обычный(client, make_user):
    """Пароль из пробелов принимается на вход и сверяется побайтно."""
    actor = make_user(password="    ")
    assert client.post(LOGIN_URL, json={"email": actor.email, "password": "    "}).status_code == 200
    assert client.post(LOGIN_URL, json={"email": actor.email, "password": "   "}).status_code == 401


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: длина пароля нигде не ограничена, bcrypt молча обрезает его до 72 байт — "
           "первые 72 байта достаточны для входа (main.py:298, auth.py:40)",
)
def test_пароль_длиннее_72_байт_не_должен_обрезаться(client, make_user):
    """Пароль из 100 символов не должен пускать по первым 72."""
    actor = make_user(password="A" * 100)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": "A" * 72})
    assert r.status_code == 401, "Усечённый до 72 байт пароль не должен подходить"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: пароль длиннее 4096 символов роняет passlib (PasswordSizeError) — "
           "неаутентифицированный 500 на /api/auth/login (main.py:307)",
)
def test_гигантский_пароль_не_должен_ронять_сервер(client, user):
    """Пароль на 5000 символов должен приводить к 401/422, а не к исключению."""
    r = client.post(LOGIN_URL, json={"email": user.email, "password": "B" * 5000})
    assert r.status_code in (401, 422), f"Ожидался отказ, получено {r.status_code}: {r.text}"


# ═════════════════════════════════════════════════════════════
#  4. login — аккаунт без пароля, бан, порядок проверок
# ═════════════════════════════════════════════════════════════
def test_аккаунт_без_пароля_отправляют_в_вк(client, make_user):
    """hashed_password пуст (VK-only) → 401 с подсказкой про VK."""
    actor = make_user(password=None)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": "любой"})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == NO_PASSWORD


def test_аккаунт_без_пароля_не_пускают_и_с_пустым_паролем(client, make_user):
    """Пустая строка не должна совпадать с пустым хешем."""
    actor = make_user(password=None)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": ""})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == NO_PASSWORD


def test_забаненный_с_верным_паролем_получает_403(client, make_user):
    """Бан → 403 User is banned."""
    actor = make_user(banned=True)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": actor.password})
    assert r.status_code == 403, f"Ожидался 403, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == BANNED


def test_забаненному_не_выдаются_токены(client, make_user):
    """Побочный эффект: при бане refresh-токен в базу не пишется."""
    actor = make_user(banned=True)
    before = refresh_tokens_of(actor.user_id)

    client.post(LOGIN_URL, json={"email": actor.email, "password": actor.password})

    assert refresh_tokens_of(actor.user_id) == before, "Забаненному не должен выдаваться refresh-токен"


def test_порядок_проверок_пароль_раньше_бана(client, make_user):
    """Забаненный + неверный пароль → 401 (о бане не сообщают, пока пароль не сошёлся)."""
    actor = make_user(banned=True)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": "totally-wrong"})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


def test_порядок_проверок_отсутствие_пароля_раньше_бана(client, make_user):
    """Забаненный VK-only аккаунт сообщает про VK, а не про бан."""
    actor = make_user(password=None, banned=True)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": "что-угодно"})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == NO_PASSWORD


def test_порядок_проверок_email_раньше_всего(client, make_user):
    """Для несуществующего email ответ не зависит от пароля."""
    r1 = client.post(LOGIN_URL, json={"email": "nobody@test.ru", "password": ""})
    r2 = client.post(LOGIN_URL, json={"email": "nobody@test.ru", "password": "Passw0rd!"})
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["detail"] == r2.json()["detail"] == INVALID_CREDENTIALS


# ═════════════════════════════════════════════════════════════
#  5. login — валидация тела запроса
# ═════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "body",
    [
        {"password": "Passw0rd!"},
        {"email": "user@test.ru"},
        {},
    ],
    ids=["нет_email", "нет_password", "пустое_тело"],
)
def test_обязательные_поля_логина(client, body):
    """Отсутствие email или password → 422."""
    r = client.post(LOGIN_URL, json=body)
    assert r.status_code == 422, f"Ожидался 422, получено {r.status_code}: {r.text}"


@pytest.mark.parametrize(
    "email",
    [
        "",
        "   ",
        "not-an-email",
        "user@",
        "@test.ru",
        "user@@test.ru",
        "user name@test.ru",
        "user@test",
        "user@.ru",
        "a" * 300 + "@test.ru",
    ],
)
def test_некорректный_email_даёт_422(client, email):
    """EmailStr отбраковывает мусор до обращения к базе."""
    r = client.post(LOGIN_URL, json={"email": email, "password": "Passw0rd!"})
    assert r.status_code == 422, f"email={email!r}: ожидался 422, получено {r.status_code}: {r.text}"


@pytest.mark.parametrize(
    "email, password",
    [
        (123, "Passw0rd!"),
        (None, "Passw0rd!"),
        (["user@test.ru"], "Passw0rd!"),
        ("user@test.ru", 123),
        ("user@test.ru", None),
        ("user@test.ru", {"value": "Passw0rd!"}),
        ("user@test.ru", True),
    ],
    ids=["email_int", "email_null", "email_list", "pwd_int", "pwd_null", "pwd_dict", "pwd_bool"],
)
def test_неверные_типы_полей_дают_422(client, email, password):
    """pydantic v2 не приводит числа/None/коллекции к str."""
    r = client.post(LOGIN_URL, json={"email": email, "password": password})
    assert r.status_code == 422, f"Ожидался 422, получено {r.status_code}: {r.text}"


@pytest.mark.parametrize(
    "raw_body",
    ["", "not json", "[]", '"строка"', "123"],
    ids=["пусто", "не_json", "массив", "строка", "число"],
)
def test_тело_не_объект_даёт_422(client, raw_body):
    """Любое тело, не являющееся JSON-объектом, → 422."""
    r = client.post(LOGIN_URL, content=raw_body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422, f"Ожидался 422, получено {r.status_code}: {r.text}"


def test_лишние_поля_в_теле_игнорируются(client, user):
    """Неописанные поля не ломают вход и не влияют на результат."""
    r = client.post(
        LOGIN_URL,
        json={"email": user.email, "password": user.password, "admin": True, "user_id": 999},
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    payload = jwt.decode(r.json()["access_token"], auth_module.SECRET_KEY, algorithms=[auth_module.ALGORITHM])
    assert payload["sub"] == str(user.user_id), "Лишние поля не должны подменять пользователя"


def test_валидация_отрабатывает_раньше_обращения_к_базе(client, make_user):
    """Мусорный email не приводит к выдаче токенов никому."""
    make_user()
    before = total_refresh_tokens()
    client.post(LOGIN_URL, json={"email": "не-почта", "password": "Passw0rd!"})
    assert total_refresh_tokens() == before, "Невалидный запрос не должен создавать refresh-токены"


def test_домен_email_регистронезависим(client, make_user):
    """EmailStr приводит домен к нижнему регистру → вход с ПРОПИСНЫМ доменом работает."""
    actor = make_user(email="caseuser@example.com")
    r = client.post(LOGIN_URL, json={"email": "caseuser@EXAMPLE.COM", "password": actor.password})
    assert r.status_code == 200, f"Домен должен сравниваться без учёта регистра, получено {r.status_code}: {r.text}"


def test_локальная_часть_email_регистрозависима(client, make_user):
    """Регистр до @ не нормализуется — это осознанное поведение EmailStr, фиксируем его."""
    actor = make_user(email="caseuser@example.com")
    r = client.post(LOGIN_URL, json={"email": "CaseUser@example.com", "password": actor.password})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


# ═════════════════════════════════════════════════════════════
#  6. login — побочные эффекты и повторный вход
# ═════════════════════════════════════════════════════════════
def test_два_входа_дают_разные_refresh_токены(client, user):
    """Каждый вход выдаёт новый refresh-токен."""
    first = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]
    second = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]

    assert first != second, "Повторный вход обязан выдавать другой refresh-токен"


def test_оба_refresh_токена_лежат_в_базе(client, user):
    """Вход не удаляет ранее выданные токены (несколько устройств)."""
    first = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]
    second = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]

    stored = set(refresh_tokens_of(user.user_id))
    assert {first, second} <= stored, f"Оба токена должны быть в базе, найдено: {stored}"


def test_оба_refresh_токена_остаются_рабочими(client, user):
    """Токен от первой сессии продолжает работать после второго входа."""
    first = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]
    second = client.post(LOGIN_URL, json={"email": user.email, "password": user.password}).json()["refresh_token"]

    r1 = client.post(REFRESH_URL, headers=cookie_header(first))
    assert r1.status_code == 200, f"Первый refresh-токен должен работать, получено {r1.status_code}: {r1.text}"

    r2 = client.post(REFRESH_URL, headers=cookie_header(second))
    assert r2.status_code == 200, f"Второй refresh-токен должен работать, получено {r2.status_code}: {r2.text}"


def test_неудачный_вход_не_создаёт_записей(client, user):
    """Ни одна из форм отказа не пишет refresh-токен."""
    before = total_refresh_tokens()
    client.post(LOGIN_URL, json={"email": user.email, "password": "wrong"})
    client.post(LOGIN_URL, json={"email": "ghost@test.ru", "password": "wrong"})
    assert total_refresh_tokens() == before, "Отказ во входе не должен создавать refresh-токены"


def test_вход_не_меняет_хеш_пароля(client, user):
    """Вход — операция чтения; хеш в базе остаётся прежним."""
    before = stored_hash(user.user_id)
    client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    assert stored_hash(user.user_id) == before, "Вход не должен перезаписывать hashed_password"


def test_вход_разных_пользователей_выдаёт_разные_субъекты(client, make_user):
    """Токены не путаются между пользователями с похожими данными."""
    a = make_user(kkr_name="Одинаковое Имя")
    b = make_user(kkr_name="Одинаковое Имя")

    ta = client.post(LOGIN_URL, json={"email": a.email, "password": a.password}).json()["access_token"]
    tb = client.post(LOGIN_URL, json={"email": b.email, "password": b.password}).json()["access_token"]

    sub_a = jwt.decode(ta, auth_module.SECRET_KEY, algorithms=[auth_module.ALGORITHM])["sub"]
    sub_b = jwt.decode(tb, auth_module.SECRET_KEY, algorithms=[auth_module.ALGORITHM])["sub"]
    assert sub_a == str(a.user_id) and sub_b == str(b.user_id), "sub должен соответствовать вошедшему пользователю"


def test_чужой_пароль_не_подходит_к_соседнему_аккаунту(client, make_user):
    """Пароль одного пользователя не логинит другого."""
    a = make_user(password="Alpha-1111")
    b = make_user(password="Beta-2222")
    r = client.post(LOGIN_URL, json={"email": a.email, "password": b.password})
    assert r.status_code == 401, "Пароль соседнего аккаунта не должен подходить"


def test_вход_после_удаления_пользователя(client, make_user):
    """Удалённый аккаунт больше не логинится."""
    actor = make_user()
    db.delete_user(actor.user_id)
    r = client.post(LOGIN_URL, json={"email": actor.email, "password": actor.password})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


# ═════════════════════════════════════════════════════════════
#  7. change-password — аутентификация
# ═════════════════════════════════════════════════════════════
def test_смена_пароля_без_токена_даёт_401(client, anon):
    """Эндпоинт закрыт Bearer-авторизацией."""
    r = client.post(CHANGE_URL, json={"old_password": "Passw0rd!", "new_password": "New-1234"}, headers=anon)
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not authenticated"


@pytest.mark.parametrize(
    "header_value, expected_detail",
    [
        ("Bearer garbage-token", "Access token invalid or expired"),
        ("Bearer ", "Access token invalid or expired"),
        ("Bearer a.b.c", "Access token invalid or expired"),
        ("no-scheme-token", "Not authenticated"),
        ("Basic dXNlcjpwYXNz", "Not authenticated"),
    ],
    ids=["мусор", "пустой_токен", "три_сегмента", "без_схемы", "чужая_схема"],
)
def test_смена_пароля_с_битым_заголовком(client, header_value, expected_detail):
    """Некорректный Authorization → 401 с ожидаемым сообщением."""
    r = client.post(
        CHANGE_URL,
        json={"new_password": "New-1234"},
        headers={"Authorization": header_value},
    )
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == expected_detail


def test_смена_пароля_с_просроченным_токеном(client, user, expired_access_token):
    """Просроченный access-токен → 401 Access token invalid or expired."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-1234"},
        headers={"Authorization": f"Bearer {expired_access_token(user.user_id)}"},
    )
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Access token invalid or expired"
    assert stored_hash(user.user_id), "Пароль не должен смениться по просроченному токену"


def test_смена_пароля_по_refresh_типизированному_токену(client, user, refresh_typed_token):
    """JWT с type=refresh не принимается там, где нужен access."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-1234"},
        headers={"Authorization": f"Bearer {refresh_typed_token(user.user_id)}"},
    )
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not an access token"


def test_смена_пароля_по_чужой_подписи(client, user, foreign_signed_token):
    """Токен, подписанный другим секретом, не принимается."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-1234"},
        headers={"Authorization": f"Bearer {foreign_signed_token(user.user_id)}"},
    )
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Access token invalid or expired"


def test_смена_пароля_по_токену_удалённого_пользователя(client, make_user):
    """Пользователь удалён → 401 User not found."""
    actor = make_user()
    headers = actor.headers
    db.delete_user(actor.user_id)

    r = client.post(CHANGE_URL, json={"old_password": actor.password, "new_password": "New-1234"}, headers=headers)
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == "User not found"


def test_смена_пароля_забаненным_даёт_403(client, banned_user):
    """Забаненный не может сменить пароль."""
    before = stored_hash(banned_user.user_id)
    r = client.post(
        CHANGE_URL,
        json={"old_password": banned_user.password, "new_password": "New-1234"},
        headers=banned_user.headers,
    )
    assert r.status_code == 403, f"Ожидался 403, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == BANNED
    assert stored_hash(banned_user.user_id) == before, "Хеш забаненного не должен меняться"


@pytest.mark.parametrize("role", ["user", "admin", "superuser"])
def test_смена_пароля_доступна_всем_ролям(client, request, role):
    """Эндпоинт не требует прав — доступен и обычному пользователю, и админам."""
    actor = request.getfixturevalue(role)
    r = client.post(
        CHANGE_URL,
        json={"old_password": actor.password, "new_password": "New-Pass-1234"},
        headers=actor.headers,
    )
    assert r.status_code == 200, f"Роль {role}: ожидался 200, получено {r.status_code}: {r.text}"


# ═════════════════════════════════════════════════════════════
#  8. change-password — счастливый путь и запись в базу
# ═════════════════════════════════════════════════════════════
def test_успешная_смена_пароля_возвращает_ровно_detail(client, user):
    """200 и тело {"detail": "Password updated successfully"} без лишних полей."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    assert r.json() == {"detail": CHANGED_OK}, f"Неожиданное тело ответа: {r.json()}"


def test_смена_пароля_переписывает_хеш_в_базе(client, user):
    """Побочный эффект: hashed_password в базе изменился и проверяется новым паролем."""
    before = stored_hash(user.user_id)

    client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )

    after = stored_hash(user.user_id)
    assert after != before, "Хеш пароля обязан измениться"
    assert auth_module.verify_password("New-Pass-1234", after), "Новый хеш должен проверяться новым паролем"
    assert not auth_module.verify_password(user.password, after), "Старый пароль не должен подходить к новому хешу"


def test_смена_пароля_не_трогает_другие_поля(client, make_user):
    """Меняется только hashed_password."""
    actor = make_user(admin=True, group_number="205", blocks="")
    before = db.get_user(actor.user_id)

    client.post(
        CHANGE_URL,
        json={"old_password": actor.password, "new_password": "New-Pass-1234"},
        headers=actor.headers,
    )

    after = db.get_user(actor.user_id)
    assert (after.admin, after.super_user, after.banned) == (before.admin, before.super_user, before.banned)
    assert (after.kkr_score, after.group_number, after.blocks) == (
        before.kkr_score,
        before.group_number,
        before.blocks,
    )


def test_смена_пароля_не_трогает_соседний_аккаунт(client, make_user):
    """Пароль меняется только у владельца токена."""
    me = make_user()
    other = make_user()
    other_hash = stored_hash(other.user_id)

    client.post(
        CHANGE_URL,
        json={"old_password": me.password, "new_password": "New-Pass-1234"},
        headers=me.headers,
    )

    assert stored_hash(other.user_id) == other_hash, "Хеш чужого аккаунта не должен меняться"


def test_повторная_смена_пароля_работает(client, user):
    """Идемпотентность цепочки: сменил → сменил ещё раз новым старым паролем."""
    first = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1111"},
        headers=user.headers,
    )
    assert first.status_code == 200, first.text

    second = client.post(
        CHANGE_URL,
        json={"old_password": "New-Pass-1111", "new_password": "New-Pass-2222"},
        headers=user.headers,
    )
    assert second.status_code == 200, f"Вторая смена должна пройти, получено {second.status_code}: {second.text}"
    assert auth_module.verify_password("New-Pass-2222", stored_hash(user.user_id))


def test_смена_пароля_на_тот_же_самый(client, user):
    """Смена пароля на такой же принимается, но хеш пересолен."""
    before = stored_hash(user.user_id)
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": user.password},
        headers=user.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    after = stored_hash(user.user_id)
    assert after != before, "bcrypt должен выдать новую соль"
    assert auth_module.verify_password(user.password, after)


# ═════════════════════════════════════════════════════════════
#  9. change-password — old_password
# ═════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "body_extra",
    [{}, {"old_password": None}, {"old_password": ""}],
    ids=["поле_отсутствует", "поле_null", "поле_пустая_строка"],
)
def test_старый_пароль_обязателен_если_он_установлен(client, user, body_extra):
    """Нет old_password → 400 Old password is required."""
    before = stored_hash(user.user_id)
    r = client.post(CHANGE_URL, json={"new_password": "New-Pass-1234", **body_extra}, headers=user.headers)

    assert r.status_code == 400, f"Ожидался 400, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == OLD_REQUIRED
    assert stored_hash(user.user_id) == before, "Пароль не должен смениться без old_password"


@pytest.mark.parametrize(
    "old_password",
    ["Wrong-Password", "passw0rd!", "Passw0rd", "Passw0rd! ", "Пароль"],
    ids=["другой", "иной_регистр", "обрезанный", "лишний_пробел", "юникод"],
)
def test_неверный_старый_пароль_даёт_400(client, user, old_password):
    """Неверный old_password → 400 Invalid old password, хеш не тронут."""
    before = stored_hash(user.user_id)
    r = client.post(
        CHANGE_URL,
        json={"old_password": old_password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )

    assert r.status_code == 400, f"Ожидался 400, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == OLD_INVALID
    assert stored_hash(user.user_id) == before, "Хеш не должен меняться при неверном old_password"


def test_неверный_тип_старого_пароля_даёт_422(client, user):
    """old_password не строка → 422 от pydantic."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": 12345, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )
    assert r.status_code == 422, f"Ожидался 422, получено {r.status_code}: {r.text}"


def test_вк_аккаунт_ставит_пароль_без_старого(client, make_user):
    """У VK-only пользователя hashed_password пуст → old_password не нужен."""
    actor = make_user(password=None)
    assert stored_hash(actor.user_id) == "", "Предусловие: у VK-аккаунта пустой хеш"

    r = client.post(CHANGE_URL, json={"new_password": "Vk-Pass-1234"}, headers=actor.headers)

    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    assert r.json() == {"detail": CHANGED_OK}
    assert auth_module.verify_password("Vk-Pass-1234", stored_hash(actor.user_id)), "Пароль должен появиться в базе"


def test_вк_аккаунт_после_установки_пароля_логинится(client, make_user):
    """После установки пароля VK-only аккаунт входит обычным способом."""
    actor = make_user(password=None)
    assert client.post(LOGIN_URL, json={"email": actor.email, "password": "Vk-Pass-1234"}).status_code == 401

    client.post(CHANGE_URL, json={"new_password": "Vk-Pass-1234"}, headers=actor.headers)

    r = client.post(LOGIN_URL, json={"email": actor.email, "password": "Vk-Pass-1234"})
    assert r.status_code == 200, f"После установки пароля вход должен работать, получено {r.status_code}: {r.text}"


def test_вк_аккаунт_игнорирует_переданный_старый_пароль(client, make_user):
    """Ветка проверки old_password не выполняется при пустом хеше — фиксируем поведение."""
    actor = make_user(password=None)
    r = client.post(
        CHANGE_URL,
        json={"old_password": "какая-угодно-чушь", "new_password": "Vk-Pass-1234"},
        headers=actor.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"


def test_вк_аккаунт_после_установки_пароля_требует_старый(client, make_user):
    """Как только пароль появился, вторая смена уже требует old_password."""
    actor = make_user(password=None)
    client.post(CHANGE_URL, json={"new_password": "Vk-Pass-1234"}, headers=actor.headers)

    r = client.post(CHANGE_URL, json={"new_password": "Vk-Pass-9999"}, headers=actor.headers)
    assert r.status_code == 400, f"Ожидался 400, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == OLD_REQUIRED


# ═════════════════════════════════════════════════════════════
#  10. change-password — валидация new_password
# ═════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "body",
    [
        {"old_password": "Passw0rd!"},
        {},
        {"new_password": None},
        {"new_password": 12345},
        {"new_password": ["New-Pass"]},
        {"new_password": True},
    ],
    ids=["нет_поля", "пустое_тело", "null", "int", "list", "bool"],
)
def test_некорректный_new_password_даёт_422(client, user, body):
    """new_password обязателен и должен быть строкой."""
    before = stored_hash(user.user_id)
    r = client.post(CHANGE_URL, json=body, headers=user.headers)
    assert r.status_code == 422, f"Ожидался 422, получено {r.status_code}: {r.text}"
    assert stored_hash(user.user_id) == before, "При 422 пароль меняться не должен"


@pytest.mark.parametrize(
    "new_password",
    ["", " ", "   ", "\t", "\n"],
    ids=["пусто", "один_пробел", "пробелы", "таб", "перевод_строки"],
)
@pytest.mark.xfail(
    strict=True,
    reason="БАГ: ChangePasswordIn.new_password не имеет min_length и не проверяется на пустоту — "
           "пользователь может установить пустой пароль или пароль из пробелов (main.py:183, main.py:328)",
)
def test_пустой_новый_пароль_должен_отклоняться(client, user, new_password):
    """Пустой/пробельный новый пароль должен отвергаться (422/400)."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": new_password},
        headers=user.headers,
    )
    assert r.status_code in (400, 422), f"Ожидался отказ, получено {r.status_code}: {r.text}"


def test_последствия_пустого_нового_пароля_вход_по_пустой_строке(client, user):
    """Фиксация текущего поведения: после установки пустого пароля вход идёт по пустой строке."""
    assert client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": ""},
        headers=user.headers,
    ).status_code == 200

    r = client.post(LOGIN_URL, json={"email": user.email, "password": ""})
    assert r.status_code == 200, (
        "Текущее поведение: пустой пароль реально пускает в аккаунт — "
        f"получено {r.status_code}: {r.text}"
    )


def test_короткий_новый_пароль_принимается(client, user):
    """Минимальной длины пароля нет — фиксируем как есть."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "1"},
        headers=user.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"


def test_юникодный_новый_пароль(client, user):
    """Кириллица и эмодзи корректно хешируются и проверяются."""
    new = "Новый-Пароль-Ж🔥"
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": new},
        headers=user.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    assert client.post(LOGIN_URL, json={"email": user.email, "password": new}).status_code == 200


def test_длинный_новый_пароль_принимается(client, user):
    """Пароль в 1000 символов не ломает эндпоинт."""
    new = "Ы" * 1000
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": new},
        headers=user.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"


@pytest.mark.xfail(
    strict=True,
    reason="БАГ: new_password длиннее 4096 символов роняет passlib (PasswordSizeError) → 500 "
           "вместо 422 (main.py:340)",
)
def test_гигантский_новый_пароль_не_должен_ронять_сервер(client, user):
    """Новый пароль на 5000 символов должен приводить к 422/400, а не к исключению."""
    r = client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "B" * 5000},
        headers=user.headers,
    )
    assert r.status_code in (400, 422), f"Ожидался отказ, получено {r.status_code}: {r.text}"


def test_лишние_поля_при_смене_пароля_игнорируются(client, user):
    """Неописанные поля не позволяют менять что-то ещё."""
    r = client.post(
        CHANGE_URL,
        json={
            "old_password": user.password,
            "new_password": "New-Pass-1234",
            "user_id": 999,
            "admin": True,
        },
        headers=user.headers,
    )
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    assert db.get_user(user.user_id).admin is False, "Лишнее поле admin не должно применяться"


# ═════════════════════════════════════════════════════════════
#  11. change-password — последствия смены пароля
# ═════════════════════════════════════════════════════════════
def test_старый_пароль_после_смены_не_пускает(client, user):
    """Вход по старому паролю → 401 Invalid credentials."""
    client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )
    r = client.post(LOGIN_URL, json={"email": user.email, "password": user.password})
    assert r.status_code == 401, f"Ожидался 401, получено {r.status_code}: {r.text}"
    assert r.json()["detail"] == INVALID_CREDENTIALS


def test_новый_пароль_после_смены_пускает(client, user):
    """Вход по новому паролю → 200 и полноценная пара токенов."""
    client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )
    r = client.post(LOGIN_URL, json={"email": user.email, "password": "New-Pass-1234"})
    assert r.status_code == 200, f"Ожидался 200, получено {r.status_code}: {r.text}"
    assert set(r.json()) == {"access_token", "refresh_token", "token_type"}


@pytest.mark.xfail(
    strict=True,
    reason="БАГ (безопасность): change_password не вызывает revoke_all_user_tokens — "
           "все ранее выданные refresh-токены (в т.ч. у угонщика) переживают смену пароля "
           "и позволяют бесконечно продлевать доступ (main.py:328-342)",
)
def test_смена_пароля_должна_отзывать_refresh_токены(client, user):
    """После смены пароля старые refresh-токены обязаны перестать работать."""
    old_refresh = client.post(
        LOGIN_URL, json={"email": user.email, "password": user.password}
    ).json()["refresh_token"]

    client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )

    assert refresh_tokens_of(user.user_id) == [], "Смена пароля должна вычищать refresh-токены из базы"
    r = client.post(REFRESH_URL, headers=cookie_header(old_refresh))
    assert r.status_code == 401, f"Старый refresh-токен должен быть отозван, получено {r.status_code}: {r.text}"


def test_смена_пароля_не_отзывает_текущий_access_токен(client, user):
    """Фиксация поведения stateless-JWT: выданный access-токен живёт до истечения TTL."""
    client.post(
        CHANGE_URL,
        json={"old_password": user.password, "new_password": "New-Pass-1234"},
        headers=user.headers,
    )
    r = client.get(PROFILE_ME_URL, headers=user.headers)
    assert r.status_code == 200, (
        "Текущее поведение: access-токен продолжает действовать после смены пароля — "
        f"получено {r.status_code}: {r.text}"
    )
