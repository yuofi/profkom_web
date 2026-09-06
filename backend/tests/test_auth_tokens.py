"""
Жизненный цикл токенов: /api/auth/refresh, /api/auth/logout, /api/auth/logout-all
и семантика access-токена в общей зависимости get_current_user.

Представительный защищённый маршрут для проверки access-токена — GET /api/profile/me.

Все проверки побочных эффектов идут напрямую в базу (`from database import db`),
чтобы отличать «ручка вернула 200» от «строка действительно удалена».
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt
from sqlalchemy import text

import auth as auth_module
import database as database_module
from database import db

# ─────────────────────────────────────────────────────────────
#  Константы и утилиты
# ─────────────────────────────────────────────────────────────
REFRESH_URL = "/api/auth/refresh"
LOGOUT_URL = "/api/auth/logout"
LOGOUT_ALL_URL = "/api/auth/logout-all"
ME_URL = "/api/profile/me"

DETAIL_NO_COOKIE = "Refresh token missing in cookies"
DETAIL_NOT_FOUND = "Refresh token not found (revoked or already used)"
DETAIL_EXPIRED = "Refresh token expired"
DETAIL_ACCESS_BAD = "Access token invalid or expired"
DETAIL_NOT_ACCESS = "Not an access token"
DETAIL_USER_NOT_FOUND = "User not found"
DETAIL_BANNED = "User is banned"
DETAIL_NOT_AUTHENTICATED = "Not authenticated"

_MISSING = object()


@pytest.fixture(autouse=True)
def _isolate_cookie_jar(client):
    """
    Фикстура `client` — сессионная, её cookie-jar общий для всех тестов.
    Чистим до и после каждого теста, чтобы кука одного теста не утекала в другой.
    """
    client.cookies.clear()
    yield
    client.cookies.clear()


def _post(client, url, *, refresh=None, headers=None, **kwargs):
    """POST с ровно одной (или ни одной) refresh-кукой в запросе."""
    client.cookies.clear()
    if refresh is not None:
        client.cookies.set("refresh_token", refresh)
    resp = client.post(url, headers=headers or {}, **kwargs)
    client.cookies.clear()
    return resp


def _get(client, url, *, headers=None, **kwargs):
    client.cookies.clear()
    return client.get(url, headers=headers or {}, **kwargs)


def _refresh_rows(user_id: int) -> int:
    """Сколько refresh-токенов лежит в базе у пользователя."""
    with database_module.engine.begin() as conn:
        return conn.execute(
            text("SELECT COUNT(*) FROM refresh_tokens WHERE user_id = :uid"),
            {"uid": user_id},
        ).scalar_one()


def _total_refresh_rows() -> int:
    with database_module.engine.begin() as conn:
        return conn.execute(text("SELECT COUNT(*) FROM refresh_tokens")).scalar_one()


def _new_session(user_id: int) -> dict:
    """Ещё одна «сессия»: пара токенов, refresh при этом сохраняется в базе."""
    return auth_module.create_token_pair(user_id)


def _craft_token(
    *,
    sub=_MISSING,
    token_type: str = "access",
    secret: str | None = None,
    ttl_min: int = 30,
) -> str:
    """Собирает JWT вручную — для случаев, которые фикстуры не покрывают."""
    now = datetime.now(timezone.utc)
    payload: dict = {"type": token_type, "iat": now, "exp": now + timedelta(minutes=ttl_min)}
    if sub is not _MISSING:
        payload["sub"] = sub
    return jwt.encode(
        payload,
        secret if secret is not None else auth_module.SECRET_KEY,
        algorithm=auth_module.ALGORITHM,
    )


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ═════════════════════════════════════════════════════════════
#  1. POST /api/auth/refresh — happy path
# ═════════════════════════════════════════════════════════════
class TestRefreshHappyPath:
    def test_refresh_возвращает_полную_пару_токенов(self, client, user):
        """200 и тело TokenPair целиком: access_token, refresh_token, token_type."""
        resp = _post(client, REFRESH_URL, refresh=user.refresh_token)

        assert resp.status_code == 200, f"ожидали 200, получили {resp.status_code}: {resp.text}"
        body = resp.json()
        assert set(body) == {"access_token", "refresh_token", "token_type"}, (
            f"тело ответа должно содержать ровно поля TokenPair, получено: {sorted(body)}"
        )
        assert isinstance(body["access_token"], str) and body["access_token"], "access_token — непустая строка"
        assert isinstance(body["refresh_token"], str) and body["refresh_token"], "refresh_token — непустая строка"
        assert body["token_type"] == "bearer", "token_type должен быть 'bearer'"
        assert body["refresh_token"] != user.refresh_token, "refresh-токен обязан смениться (ротация)"

    def test_новый_access_токен_подписан_корректно_и_принадлежит_тому_же_пользователю(self, client, user):
        """В новом access-токене sub = user_id, type = access."""
        body = _post(client, REFRESH_URL, refresh=user.refresh_token).json()

        payload = jwt.decode(
            body["access_token"], auth_module.SECRET_KEY, algorithms=[auth_module.ALGORITHM]
        )
        assert payload["sub"] == str(user.user_id), "sub должен указывать на того же пользователя"
        assert payload["type"] == "access", "выданный токен должен быть access-токеном"

    def test_новый_access_токен_работает_на_защищённом_маршруте(self, client, user):
        """Выданный access-токен реально пускает на /api/profile/me."""
        body = _post(client, REFRESH_URL, refresh=user.refresh_token).json()

        resp = _get(client, ME_URL, headers=_bearer(body["access_token"]))
        assert resp.status_code == 200, f"новый access-токен должен работать, получили {resp.text}"
        assert resp.json()["user_id"] == user.user_id, "профиль должен быть того же пользователя"

    def test_refresh_переустанавливает_куку(self, client, user):
        """Ответ содержит Set-Cookie с новым refresh-токеном и защитными флагами."""
        resp = _post(client, REFRESH_URL, refresh=user.refresh_token)
        new_refresh = resp.json()["refresh_token"]

        set_cookie = resp.headers.get("set-cookie")
        assert set_cookie is not None, "refresh обязан переустанавливать куку refresh_token"
        assert f"refresh_token={new_refresh}" in set_cookie, "в куку кладётся именно новый токен"
        low = set_cookie.lower()
        assert "httponly" in low, "кука refresh_token должна быть HttpOnly"
        assert "secure" in low, "кука refresh_token должна быть Secure"
        assert "samesite=none" in low, "кука refresh_token должна быть SameSite=None"
        assert f"max-age={auth_module.REFRESH_TTL_DAYS * 24 * 60 * 60}" in low, (
            "срок жизни куки должен совпадать с REFRESH_TOKEN_EXPIRE_DAYS"
        )

    def test_ротация_старый_токен_удалён_из_базы(self, client, user):
        """Побочный эффект: старая строка refresh_tokens исчезает, появляется ровно одна новая."""
        old = user.refresh_token
        assert db.get_refresh_token(old) is not None, "предусловие: старый токен лежит в базе"

        new = _post(client, REFRESH_URL, refresh=old).json()["refresh_token"]

        assert db.get_refresh_token(old) is None, "старый refresh-токен обязан быть удалён (ротация)"
        row = db.get_refresh_token(new)
        assert row is not None, "новый refresh-токен обязан быть сохранён в базе"
        assert row["user_id"] == user.user_id, "новый токен принадлежит тому же пользователю"
        assert _refresh_rows(user.user_id) == 1, "у пользователя должна остаться ровно одна сессия"

    def test_повторное_использование_старого_refresh_токена_отклоняется(self, client, user):
        """Ключевое свойство ротации: старый токен нельзя использовать второй раз."""
        old = user.refresh_token
        _post(client, REFRESH_URL, refresh=old)

        resp = _post(client, REFRESH_URL, refresh=old)
        assert resp.status_code == 401, "повторное использование refresh-токена должно отклоняться"
        assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_цепочка_из_трёх_обновлений(self, client, user):
        """Ротацию можно выполнять многократно, каждый раз оставаясь с одной сессией."""
        token = user.refresh_token
        seen = {token}
        for step in range(3):
            resp = _post(client, REFRESH_URL, refresh=token)
            assert resp.status_code == 200, f"шаг {step}: ожидали 200, получили {resp.text}"
            token = resp.json()["refresh_token"]
            assert token not in seen, f"шаг {step}: refresh-токен обязан быть новым"
            seen.add(token)
            assert _refresh_rows(user.user_id) == 1, f"шаг {step}: сессия должна остаться одна"

    def test_обновление_одной_сессии_не_ломает_вторую(self, client, user):
        """Ротация затрагивает только предъявленный токен."""
        second = _new_session(user.user_id)

        _post(client, REFRESH_URL, refresh=user.refresh_token)

        resp = _post(client, REFRESH_URL, refresh=second["refresh_token"])
        assert resp.status_code == 200, "вторая сессия не должна пострадать от обновления первой"


# ═════════════════════════════════════════════════════════════
#  2. POST /api/auth/refresh — источник токена, ошибки
# ═════════════════════════════════════════════════════════════
class TestRefreshErrors:
    def test_без_куки_401(self, client, user):
        """Куки нет вовсе → 401 с точным сообщением."""
        resp = _post(client, REFRESH_URL)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NO_COOKIE

    def test_токен_только_в_теле_запроса_не_принимается(self, client, user):
        """
        Ручка читает токен ТОЛЬКО из куки: тело запроса игнорируется целиком
        (схема RefreshRequest в main.py объявлена, но нигде не используется).
        """
        resp = _post(client, REFRESH_URL, json={"refresh_token": user.refresh_token})

        assert resp.status_code == 401, "тело запроса не должно приниматься как источник токена"
        assert resp.json()["detail"] == DETAIL_NO_COOKIE
        assert db.get_refresh_token(user.refresh_token) is not None, (
            "отклонённый запрос не должен потреблять refresh-токен"
        )

    def test_токен_в_заголовке_authorization_не_принимается(self, client, user):
        """Refresh-токен, переданный как Bearer, тоже не считается кукой."""
        resp = _post(client, REFRESH_URL, headers=_bearer(user.refresh_token))
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NO_COOKIE

    def test_пустая_кука_считается_отсутствующей(self, client, user):
        """refresh_token="" → falsy → «missing in cookies», а не «not found»."""
        resp = _post(client, REFRESH_URL, refresh="")
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NO_COOKIE

    @pytest.mark.parametrize(
        "bad_token",
        [
            pytest.param("garbage", id="мусорная-строка"),
            pytest.param("00000000-0000-0000-0000-000000000000", id="uuid-которого-нет-в-базе"),
            pytest.param("A" * 4096, id="очень-длинная-строка"),
            pytest.param("../../etc/passwd", id="путь"),
            pytest.param("' OR 1=1 --", id="sql-инъекция"),
        ],
    )
    def test_неизвестный_или_мусорный_токен_401(self, client, user, bad_token):
        """Любое непустое значение, которого нет в базе → 401 «not found»."""
        resp = _post(client, REFRESH_URL, refresh=bad_token)
        assert resp.status_code == 401, f"ожидали 401 для {bad_token!r}, получили {resp.status_code}"
        assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_кука_из_одних_пробелов_считается_отсутствующей(self, client, user):
        """Значение из пробелов схлопывается в пустую строку → «missing in cookies»."""
        resp = _post(client, REFRESH_URL, refresh="   ")
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NO_COOKIE

    def test_отклонённый_запрос_не_создаёт_новых_токенов(self, client, user):
        """Неудачный refresh не должен плодить строки в refresh_tokens."""
        before = _total_refresh_rows()
        _post(client, REFRESH_URL, refresh="garbage")
        assert _total_refresh_rows() == before, "неудачный refresh не должен создавать токены"

    def test_access_токен_в_куке_не_подходит(self, client, user):
        """JWT — не opaque refresh-токен, в таблице его нет."""
        resp = _post(client, REFRESH_URL, refresh=user.access_token)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_просроченный_refresh_токен_401(self, client, user, expired_refresh_token):
        """Протухший токен отклоняется с точным сообщением."""
        token = expired_refresh_token(user.user_id)
        resp = _post(client, REFRESH_URL, refresh=token)

        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_EXPIRED

    def test_просроченный_refresh_токен_удаляется_из_базы(self, client, user, expired_refresh_token):
        """Побочный эффект: протухшая строка вычищается при попытке использования."""
        token = expired_refresh_token(user.user_id)
        assert db.get_refresh_token(token) is not None, "предусловие: строка лежит в базе"

        _post(client, REFRESH_URL, refresh=token)

        assert db.get_refresh_token(token) is None, "протухший refresh-токен должен удаляться из базы"

    def test_повторный_запрос_с_протухшим_токеном_меняет_сообщение(self, client, user, expired_refresh_token):
        """После первой попытки строки уже нет → сообщение становится «not found»."""
        token = expired_refresh_token(user.user_id)
        _post(client, REFRESH_URL, refresh=token)

        resp = _post(client, REFRESH_URL, refresh=token)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_отозванный_через_logout_токен_не_обновляется(self, client, user):
        """logout действительно закрывает сессию для refresh."""
        _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)

        resp = _post(client, REFRESH_URL, refresh=user.refresh_token)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_токен_удалённого_пользователя_не_обновляется(self, client, user):
        """delete_user чистит refresh_tokens → обновление невозможно."""
        db.delete_user(user.user_id)

        resp = _post(client, REFRESH_URL, refresh=user.refresh_token)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_метод_get_не_поддерживается(self, client):
        assert _get(client, REFRESH_URL).status_code == 405

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: refresh_tokens() не проверяет пользователя — забаненному выдаётся "
               "новая пара токенов со статусом 200 (auth.py:139, main.py:517)",
    )
    def test_refresh_забаненного_пользователя_отклоняется(self, client, banned_user):
        """
        Забаненному пользователю нельзя выдавать новые токены.

        Сейчас refresh_tokens() смотрит только на строку в таблице и не проверяет
        состояние пользователя — бан обнаруживается лишь на следующем защищённом запросе.
        """
        resp = _post(client, REFRESH_URL, refresh=banned_user.refresh_token)
        assert resp.status_code == 403, (
            f"забаненному не должны выдаваться новые токены, получили {resp.status_code}"
        )

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: refresh_tokens() не проверяет существование пользователя — осиротевшая "
               "строка refresh_tokens позволяет чеканить токены для удалённого id (auth.py:139)",
    )
    def test_refresh_для_несуществующего_пользователя_отклоняется(self, client):
        """
        Строка refresh_tokens может пережить пользователя (FK в SQLite не включены),
        и тогда ручка выдаёт пару токенов «в никуда».
        """
        ghost_id = 987654
        token = str(uuid.uuid4())
        db.save_refresh_token(token, ghost_id, datetime.now(timezone.utc) + timedelta(days=1))

        resp = _post(client, REFRESH_URL, refresh=token)
        assert resp.status_code == 401, (
            f"нельзя выдавать токены несуществующему пользователю, получили {resp.status_code}"
        )


# ═════════════════════════════════════════════════════════════
#  3. POST /api/auth/logout
# ═════════════════════════════════════════════════════════════
class TestLogout:
    def test_успешный_logout(self, client, user):
        """200 и ровно {"detail": "Logged out"}."""
        resp = _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"detail": "Logged out"}

    def test_logout_удаляет_куку(self, client, user):
        """Ответ гасит куку refresh_token."""
        resp = _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)

        set_cookie = resp.headers.get("set-cookie")
        assert set_cookie is not None, "logout обязан гасить куку refresh_token"
        assert "refresh_token=" in set_cookie, "гасится именно кука refresh_token"
        low = set_cookie.lower()
        assert "max-age=0" in low or "expires=thu, 01 jan 1970" in low, (
            f"кука должна быть просрочена, получили: {set_cookie}"
        )

    def test_logout_отзывает_токен_в_базе(self, client, user):
        """Побочный эффект: строка refresh_tokens исчезает."""
        _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)

        assert db.get_refresh_token(user.refresh_token) is None, "refresh-токен должен быть удалён"
        assert _refresh_rows(user.user_id) == 0

    def test_logout_отзывает_только_одну_сессию(self, client, user):
        """Вторая сессия того же пользователя продолжает работать."""
        second = _new_session(user.user_id)

        _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)

        assert db.get_refresh_token(second["refresh_token"]) is not None, "вторая сессия не должна отзываться"
        resp = _post(client, REFRESH_URL, refresh=second["refresh_token"])
        assert resp.status_code == 200, "refresh второй сессии обязан работать после logout первой"

    def test_повторный_logout_безвреден(self, client, user):
        """Двойной выход — 200 оба раза, состояние базы не меняется."""
        first = _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)
        second = _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=user.headers)

        assert first.status_code == 200
        assert second.status_code == 200, "повторный logout должен быть идемпотентным"
        assert second.json() == {"detail": "Logged out"}
        assert _refresh_rows(user.user_id) == 0

    def test_logout_без_куки_возвращает_200(self, client, user):
        """Валидный access есть, куки нет → 200, но ничего не отзывается."""
        resp = _post(client, LOGOUT_URL, headers=user.headers)

        assert resp.status_code == 200
        assert resp.json() == {"detail": "Logged out"}
        assert db.get_refresh_token(user.refresh_token) is not None, (
            "без куки logout не может знать, какую сессию гасить, и не должен трогать базу"
        )

    def test_logout_с_неизвестной_кукой_безвреден(self, client, user):
        """Неизвестный токен в куке — 200, чужие строки не трогаем."""
        resp = _post(client, LOGOUT_URL, refresh=str(uuid.uuid4()), headers=user.headers)

        assert resp.status_code == 200
        assert _refresh_rows(user.user_id) == 1, "чужой/несуществующий токен не должен ничего удалять"

    @pytest.mark.parametrize(
        "headers_name",
        ["anon", "expired", "foreign", "garbage"],
        ids=["без-токена", "просроченный-access", "чужая-подпись", "мусор"],
    )
    def test_logout_без_валидного_access_токена_401(
        self, client, user, headers_name, expired_access_token, foreign_signed_token
    ):
        """Ручка защищена get_current_user: без валидного access — 401."""
        headers = {
            "anon": {},
            "expired": _bearer(expired_access_token(user.user_id)),
            "foreign": _bearer(foreign_signed_token(user.user_id)),
            "garbage": _bearer("not.a.jwt"),
        }[headers_name]

        resp = _post(client, LOGOUT_URL, refresh=user.refresh_token, headers=headers)

        assert resp.status_code == 401, f"ожидали 401, получили {resp.status_code}: {resp.text}"
        assert db.get_refresh_token(user.refresh_token) is not None, (
            "отклонённый logout не должен отзывать refresh-токен"
        )

    def test_logout_забаненного_пользователя_403(self, client, banned_user):
        """Бан проверяется до тела ручки; токен остаётся нетронутым."""
        resp = _post(client, LOGOUT_URL, refresh=banned_user.refresh_token, headers=banned_user.headers)

        assert resp.status_code == 403
        assert resp.json()["detail"] == DETAIL_BANNED
        assert db.get_refresh_token(banned_user.refresh_token) is not None, (
            "отклонённый по бану logout не должен отзывать токен"
        )

    def test_logout_удалённого_пользователя_401(self, client, user):
        db.delete_user(user.user_id)
        resp = _post(client, LOGOUT_URL, headers=user.headers)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_USER_NOT_FOUND

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: logout отзывает токен из куки без проверки владельца — любой "
               "аутентифицированный пользователь может разлогинить чужую сессию (main.py:538-546)",
    )
    def test_logout_не_отзывает_чужой_refresh_токен(self, client, user, make_user):
        """
        Пользователь A предъявляет свой access-токен и чужую refresh-куку.

        Ручка отзывает токен из куки без проверки владельца, поэтому A может
        разлогинить любого, чей refresh-токен ему известен.
        """
        victim = make_user()

        resp = _post(client, LOGOUT_URL, refresh=victim.refresh_token, headers=user.headers)

        assert resp.status_code == 200, resp.text
        assert db.get_refresh_token(victim.refresh_token) is not None, (
            "logout не должен отзывать refresh-токен другого пользователя"
        )

    def test_logout_игнорирует_тело_запроса(self, client, user):
        """Тело не влияет на выбор отзываемого токена."""
        second = _new_session(user.user_id)

        resp = _post(
            client,
            LOGOUT_URL,
            headers=user.headers,
            json={"refresh_token": second["refresh_token"]},
        )

        assert resp.status_code == 200
        assert db.get_refresh_token(second["refresh_token"]) is not None, (
            "токен из тела запроса не должен отзываться"
        )

    def test_метод_get_не_поддерживается(self, client, user):
        assert _get(client, LOGOUT_URL, headers=user.headers).status_code == 405


# ═════════════════════════════════════════════════════════════
#  4. POST /api/auth/logout-all
# ═════════════════════════════════════════════════════════════
class TestLogoutAll:
    def test_успешный_ответ(self, client, user):
        resp = _post(client, LOGOUT_ALL_URL, headers=user.headers)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"detail": "Logged out from all devices"}

    def test_отзываются_все_сессии(self, client, user):
        """Три сессии — после logout-all ни одна не обновляется."""
        sessions = [user.refresh_token] + [_new_session(user.user_id)["refresh_token"] for _ in range(2)]
        assert _refresh_rows(user.user_id) == 3, "предусловие: у пользователя три сессии"

        _post(client, LOGOUT_ALL_URL, headers=user.headers)

        for i, token in enumerate(sessions):
            resp = _post(client, REFRESH_URL, refresh=token)
            assert resp.status_code == 401, f"сессия {i} должна быть отозвана"
            assert resp.json()["detail"] == DETAIL_NOT_FOUND

    def test_строки_в_базе_удалены(self, client, user):
        _new_session(user.user_id)
        _new_session(user.user_id)

        _post(client, LOGOUT_ALL_URL, headers=user.headers)

        assert _refresh_rows(user.user_id) == 0, "все refresh_tokens пользователя должны быть удалены"

    def test_чужие_токены_не_трогаются(self, client, user, make_user):
        other = make_user()
        _new_session(other.user_id)

        _post(client, LOGOUT_ALL_URL, headers=user.headers)

        assert _refresh_rows(other.user_id) == 2, "сессии другого пользователя должны остаться"
        assert db.get_refresh_token(other.refresh_token) is not None
        resp = _post(client, REFRESH_URL, refresh=other.refresh_token)
        assert resp.status_code == 200, "чужая сессия обязана продолжать работать"

    def test_идемпотентность(self, client, user):
        """Второй вызов подряд — тоже 200 и по-прежнему ноль строк."""
        first = _post(client, LOGOUT_ALL_URL, headers=user.headers)
        second = _post(client, LOGOUT_ALL_URL, headers=user.headers)

        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json() == {"detail": "Logged out from all devices"}
        assert _refresh_rows(user.user_id) == 0

    def test_access_токен_продолжает_работать_после_logout_all(self, client, user):
        """
        Access-токены не хранятся в базе и не отзываются — после logout-all
        уже выданный access живёт до истечения ACCESS_TOKEN_EXPIRE_MINUTES.
        """
        _post(client, LOGOUT_ALL_URL, headers=user.headers)

        resp = _get(client, ME_URL, headers=user.headers)
        assert resp.status_code == 200, (
            "документируем текущее поведение: выданный access-токен переживает logout-all"
        )

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: logout-all не вызывает delete_cookie — браузер остаётся с мёртвой "
               "refresh-кукой, в отличие от logout (main.py:551-555)",
    )
    def test_кука_не_очищается(self, client, user):
        """
        logout-all не гасит куку refresh_token, в отличие от logout.

        Браузер остаётся с мёртвым refresh-токеном в куке.
        """
        resp = _post(client, LOGOUT_ALL_URL, refresh=user.refresh_token, headers=user.headers)

        assert resp.status_code == 200
        set_cookie = resp.headers.get("set-cookie")
        assert set_cookie is not None and "refresh_token=" in set_cookie, (
            "logout-all должен гасить куку refresh_token так же, как logout"
        )

    @pytest.mark.parametrize(
        "headers_name",
        ["anon", "expired", "foreign", "garbage"],
        ids=["без-токена", "просроченный-access", "чужая-подпись", "мусор"],
    )
    def test_без_валидного_access_токена_401(
        self, client, user, headers_name, expired_access_token, foreign_signed_token
    ):
        headers = {
            "anon": {},
            "expired": _bearer(expired_access_token(user.user_id)),
            "foreign": _bearer(foreign_signed_token(user.user_id)),
            "garbage": _bearer("not.a.jwt"),
        }[headers_name]

        resp = _post(client, LOGOUT_ALL_URL, headers=headers)

        assert resp.status_code == 401, f"ожидали 401, получили {resp.status_code}: {resp.text}"
        assert _refresh_rows(user.user_id) == 1, "отклонённый запрос не должен отзывать сессии"

    def test_забаненный_пользователь_403(self, client, banned_user):
        resp = _post(client, LOGOUT_ALL_URL, headers=banned_user.headers)

        assert resp.status_code == 403
        assert resp.json()["detail"] == DETAIL_BANNED
        assert _refresh_rows(banned_user.user_id) == 1, "отклонённый по бану запрос не должен чистить сессии"

    def test_удалённый_пользователь_401(self, client, user):
        db.delete_user(user.user_id)
        resp = _post(client, LOGOUT_ALL_URL, headers=user.headers)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_USER_NOT_FOUND

    def test_метод_get_не_поддерживается(self, client, user):
        assert _get(client, LOGOUT_ALL_URL, headers=user.headers).status_code == 405


# ═════════════════════════════════════════════════════════════
#  5. Семантика access-токена (GET /api/profile/me как представитель)
# ═════════════════════════════════════════════════════════════
class TestAccessTokenSemantics:
    def test_happy_path_полная_форма_ответа(self, client, make_user):
        """200 и все поля MeOut с ожидаемыми типами и значениями."""
        actor = make_user(
            name="Иван",
            surname="Петров",
            patronymic="Сергеевич",
            kkr_name="Иван Петров",
            group_number="205",
            location="ДСЛ",
            phone="+79990000000",
            vk="https://vk.com/id1",
            tg="@ivanpetrov",
            budget=True,
            in_profcom=True,
            photo_url="https://example.test/a.jpg",
        )

        resp = _get(client, ME_URL, headers=actor.headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) == {
            "user_id", "email", "surname", "name", "patronymic", "kkr_name",
            "group_number", "location", "blocks", "phone", "vk", "tg",
            "budget", "in_profcom", "photo_url", "kkr_score",
            "banned", "super_user", "admin", "pgas_admin", "has_password",
        }, f"состав полей MeOut изменился: {sorted(body)}"

        assert body["user_id"] == actor.user_id and isinstance(body["user_id"], int)
        assert body["email"] == actor.email
        assert body["surname"] == "Петров"
        assert body["name"] == "Иван"
        assert body["patronymic"] == "Сергеевич"
        assert body["kkr_name"] == "Иван Петров"
        assert body["group_number"] == "205" and isinstance(body["group_number"], str)
        assert body["location"] == "ДСЛ"
        # blocks в базе выставляется только через существующие блоки (_sync_blocks_for_user)
        assert body["blocks"] == "" and isinstance(body["blocks"], str)
        assert body["phone"] == "+79990000000"
        assert body["vk"] == "https://vk.com/id1"
        assert body["tg"] == "@ivanpetrov"
        assert body["budget"] is True
        assert body["in_profcom"] is True
        assert body["photo_url"] == "https://example.test/a.jpg"
        assert body["kkr_score"] == 0 and isinstance(body["kkr_score"], int)
        assert body["banned"] is False
        assert body["super_user"] is False
        assert body["admin"] is False
        assert body["has_password"] is True

    def test_has_password_false_у_вк_аккаунта(self, client, make_user):
        """Пользователь без пароля (вход через ВК) помечается has_password=False."""
        actor = make_user(password=None)
        body = _get(client, ME_URL, headers=actor.headers).json()
        assert body["has_password"] is False, "у аккаунта с пустым хешем has_password должен быть False"

    def test_без_заголовка_authorization_401(self, client, user):
        resp = _get(client, ME_URL)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_AUTHENTICATED
        assert resp.headers.get("www-authenticate") == "Bearer", (
            "OAuth2PasswordBearer обязан вернуть заголовок WWW-Authenticate"
        )

    @pytest.mark.parametrize(
        "header_value",
        [
            pytest.param("Basic dXNlcjpwYXNz", id="схема-Basic"),
            pytest.param("Token abcdef", id="схема-Token"),
            pytest.param("", id="пустой-заголовок"),
            pytest.param("abcdef", id="без-схемы"),
        ],
    )
    def test_неверная_схема_авторизации_401(self, client, user, header_value):
        """Всё, что не «Bearer <token>», отбрасывается зависимостью OAuth2PasswordBearer."""
        resp = _get(client, ME_URL, headers={"Authorization": header_value})
        assert resp.status_code == 401, f"ожидали 401 для {header_value!r}, получили {resp.status_code}"
        assert resp.json()["detail"] == DETAIL_NOT_AUTHENTICATED

    @pytest.mark.parametrize(
        "token",
        [
            pytest.param("", id="пустое-значение"),
            pytest.param("garbage", id="мусор"),
            pytest.param("a.b.c", id="три-сегмента-но-не-jwt"),
            pytest.param("x" * 5000, id="очень-длинная-строка"),
            pytest.param(
                "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxIiwidHlwZSI6ImFjY2VzcyJ9.",
                id="alg-none",
            ),
        ],
    )
    def test_битый_bearer_токен_401(self, client, user, token):
        """Схема правильная, значение — не валидный подписанный JWT."""
        resp = _get(client, ME_URL, headers=_bearer(token))
        assert resp.status_code == 401, f"ожидали 401 для {token[:20]!r}, получили {resp.status_code}"
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD

    @pytest.mark.parametrize(
        "header_value",
        [
            pytest.param("Bearer", id="Bearer-без-пробела-и-значения"),
            pytest.param("Bearer ", id="Bearer-с-пустым-значением"),
            pytest.param("bearer   ", id="bearer-в-нижнем-регистре-без-значения"),
        ],
    )
    def test_bearer_без_значения_доходит_до_декодера(self, client, user, header_value):
        """
        OAuth2PasswordBearer не проверяет непустоту параметра: пустая строка
        доезжает до jwt.decode и падает уже там.
        """
        resp = _get(client, ME_URL, headers={"Authorization": header_value})
        assert resp.status_code == 401, f"ожидали 401 для {header_value!r}, получили {resp.status_code}"
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD

    def test_просроченный_access_токен_401(self, client, user, expired_access_token):
        resp = _get(client, ME_URL, headers=_bearer(expired_access_token(user.user_id)))
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD

    def test_токен_с_чужой_подписью_401(self, client, user, foreign_signed_token):
        resp = _get(client, ME_URL, headers=_bearer(foreign_signed_token(user.user_id)))
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD

    def test_refresh_типизированный_jwt_не_принимается(self, client, user, refresh_typed_token):
        """
        HTTPException("Not an access token") поднимается внутри try, но JWTError
        его не перехватывает (это не подкласс JWTError) — клиент видит именно это
        сообщение, а не общее «Access token invalid or expired».
        """
        resp = _get(client, ME_URL, headers=_bearer(refresh_typed_token(user.user_id)))

        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_ACCESS

    def test_jwt_без_поля_type_не_принимается(self, client, user):
        """Токен без claim type тоже не access."""
        now = datetime.now(timezone.utc)
        token = jwt.encode(
            {"sub": str(user.user_id), "iat": now, "exp": now + timedelta(minutes=30)},
            auth_module.SECRET_KEY,
            algorithm=auth_module.ALGORITHM,
        )
        resp = _get(client, ME_URL, headers=_bearer(token))
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_NOT_ACCESS

    def test_opaque_refresh_токен_как_bearer_401(self, client, user):
        resp = _get(client, ME_URL, headers=_bearer(user.refresh_token))
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD

    def test_токен_удалённого_пользователя_401(self, client, user):
        """sub указывает на несуществующего пользователя."""
        db.delete_user(user.user_id)

        resp = _get(client, ME_URL, headers=user.headers)
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_USER_NOT_FOUND

    def test_токен_на_никогда_не_существовавший_id_401(self, client):
        token = auth_module.create_access_token(424242)
        resp = _get(client, ME_URL, headers=_bearer(token))
        assert resp.status_code == 401
        assert resp.json()["detail"] == DETAIL_USER_NOT_FOUND

    def test_бан_после_выдачи_токена_403(self, client, user):
        """Токен выдан до бана — доступ всё равно закрывается сразу."""
        assert _get(client, ME_URL, headers=user.headers).status_code == 200, "предусловие: доступ есть"

        db.update_user(user.user_id, banned=True)

        resp = _get(client, ME_URL, headers=user.headers)
        assert resp.status_code == 403
        assert resp.json()["detail"] == DETAIL_BANNED

    def test_разбан_возвращает_доступ(self, client, banned_user):
        db.update_user(banned_user.user_id, banned=False)
        resp = _get(client, ME_URL, headers=banned_user.headers)
        assert resp.status_code == 200, "после снятия бана доступ должен восстановиться"

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: int(payload['sub']) без обработки ValueError — токен с нечисловым sub "
               "вызывает необработанное исключение и 500 вместо 401 (auth.py:97)",
    )
    def test_нечисловой_sub_отклоняется_с_401(self, client, user):
        """
        auth.py:97 делает int(payload["sub"]) без обработки ошибок.

        Валидно подписанный токен с sub="не-число" роняет обработчик
        необработанным ValueError вместо честного 401.
        """
        token = _craft_token(sub="не-число")

        resp = _get(client, ME_URL, headers=_bearer(token))
        assert resp.status_code == 401, f"ожидали 401, получили {resp.status_code}"
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: payload['sub'] по ключу без обработки KeyError — токен без claim sub "
               "вызывает необработанное исключение и 500 вместо 401 (auth.py:97)",
    )
    def test_отсутствующий_sub_отклоняется_с_401(self, client, user):
        """
        auth.py:97 обращается к payload["sub"] по ключу.

        Токен без claim sub роняет обработчик KeyError вместо 401.
        """
        token = _craft_token()

        resp = _get(client, ME_URL, headers=_bearer(token))
        assert resp.status_code == 401, f"ожидали 401, получили {resp.status_code}"

    def test_числовой_sub_отклоняется_валидатором_jose(self, client, user):
        """python-jose требует, чтобы claim sub был строкой: sub=1 → JWTError → 401."""
        token = _craft_token(sub=user.user_id)
        resp = _get(client, ME_URL, headers=_bearer(token))
        assert resp.status_code == 401, "sub-число не проходит валидацию jose"
        assert resp.json()["detail"] == DETAIL_ACCESS_BAD


# ═════════════════════════════════════════════════════════════
#  6. Сквозные сценарии
# ═════════════════════════════════════════════════════════════
class TestTokenLifecycleScenarios:
    def test_полный_цикл_refresh_потом_logout(self, client, user):
        """Обновились → вышли → обновиться больше нельзя."""
        new_tokens = _post(client, REFRESH_URL, refresh=user.refresh_token).json()

        logout = _post(
            client, LOGOUT_URL, refresh=new_tokens["refresh_token"], headers=_bearer(new_tokens["access_token"])
        )
        assert logout.status_code == 200, logout.text

        again = _post(client, REFRESH_URL, refresh=new_tokens["refresh_token"])
        assert again.status_code == 401
        assert again.json()["detail"] == DETAIL_NOT_FOUND
        assert _refresh_rows(user.user_id) == 0

    def test_logout_all_после_серии_обновлений(self, client, user):
        """После ротаций logout-all всё равно вычищает всё до нуля."""
        token = user.refresh_token
        for _ in range(2):
            token = _post(client, REFRESH_URL, refresh=token).json()["refresh_token"]
        _new_session(user.user_id)
        assert _refresh_rows(user.user_id) == 2, "предусловие: одна ротированная сессия + одна новая"

        _post(client, LOGOUT_ALL_URL, headers=user.headers)

        assert _refresh_rows(user.user_id) == 0
        assert _post(client, REFRESH_URL, refresh=token).status_code == 401

    def test_сессии_двух_пользователей_независимы(self, client, user, make_user):
        other = make_user()

        _post(client, LOGOUT_ALL_URL, headers=user.headers)

        assert _get(client, ME_URL, headers=other.headers).status_code == 200
        assert _post(client, REFRESH_URL, refresh=other.refresh_token).status_code == 200
        assert _refresh_rows(user.user_id) == 0
