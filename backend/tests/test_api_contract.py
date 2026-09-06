"""
Контрактные тесты API как единого целого.

Этот файл не проверяет бизнес-логику отдельных эндпоинтов — он охраняет
поверхность API целиком: набор маршрутов, матрицу аутентификации,
обработку методов, слэши, CORS, OpenAPI и форму ошибок.

Строится через интроспекцию `main.app.routes`, поэтому любое изменение
набора маршрутов автоматически ломает тесты этого файла.
"""
from __future__ import annotations

import json
import typing

import pytest
from fastapi.routing import APIRoute
from starlette.routing import Route

import auth as auth_module
import main as main_module
from database import db

# ═══════════════════════════════════════════════════════════════════
#  1. ИНВЕНТАРЬ МАРШРУТОВ
# ═══════════════════════════════════════════════════════════════════
#
#  ВНИМАНИЕ, ЧИТАТЕЛЬ.
#  Список ниже — намеренно захардкоженный литерал, а не то, что вернула
#  интроспекция приложения. Это «золотой слепок» публичной поверхности API.
#
#  Если вы добавили или удалили эндпоинт и тест
#  `test_инвентарь_маршрутов_совпадает_с_эталоном` упал — это НЕ ложное
#  срабатывание. Обновите литерал ВРУЧНУЮ и одновременно добавьте маршрут
#  в PUBLIC_ROUTES или PROTECTED_ROUTES ниже, чтобы новый эндпоинт сразу
#  попал в матрицу аутентификации. Иначе новый маршрут уедет в прод,
#  не будучи ни разу проверенным на «а спросит ли он токен».
#
API_ROUTES: tuple[tuple[str, str], ...] = (
    ("DELETE", "/api/blocks/{block_name}"),
    ("DELETE", "/api/guides/{guide_id}"),
    ("DELETE", "/api/pgas/{entry_id}"),
    ("DELETE", "/api/profile/{user_id}"),
    ("GET", "/api/blocks"),
    ("GET", "/api/contacts"),
    ("GET", "/api/guides"),
    ("GET", "/api/guides/{guide_id}"),
    ("GET", "/api/pgas"),
    ("GET", "/api/profile/me"),
    ("GET", "/api/profile/{user_id}"),
    ("PATCH", "/api/blocks/{block_name}"),
    ("PATCH", "/api/guides/{guide_id}"),
    ("PATCH", "/api/profile/{user_id}"),
    ("POST", "/api/auth/change-password"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
    ("POST", "/api/auth/logout-all"),
    ("POST", "/api/auth/refresh"),
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/vk"),
    ("POST", "/api/blocks"),
    ("POST", "/api/blocks/{block_name}/enter"),
    ("POST", "/api/blocks/{block_name}/exit"),
    ("POST", "/api/contacts/filter"),
    ("POST", "/api/guides"),
    ("POST", "/api/guides/{guide_id}"),
    ("POST", "/api/pgas"),
    ("POST", "/api/upload/presigned-url"),
    ("PUT", "/api/guides/{guide_id}"),
)

# Служебные маршруты, которые FastAPI монтирует сам (единственное законное
# исключение из правила «всё висит под /api»).
FASTAPI_BUILTIN_PATHS = frozenset(
    {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
)

# ── Матрица доступа ────────────────────────────────────────────────
# Маршруты, которые обязаны работать БЕЗ заголовка Authorization.
PUBLIC_ROUTES: tuple[tuple[str, str], ...] = (
    ("GET", "/api/blocks"),
    ("GET", "/api/contacts"),
    ("GET", "/api/guides"),
    ("GET", "/api/guides/{guide_id}"),
    ("GET", "/api/profile/{user_id}"),
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/vk"),
    ("POST", "/api/auth/refresh"),
)

# Всё остальное обязано требовать Bearer-токен.
PROTECTED_ROUTES: tuple[tuple[str, str], ...] = tuple(
    r for r in API_ROUTES if r not in PUBLIC_ROUTES
)

# /api/auth/refresh формально публичный (Bearer не нужен), но без cookie
# отдаёт свой собственный 401 — у него отдельный ожидаемый ответ.
COOKIE_AUTH_ROUTES: tuple[tuple[str, str], ...] = (("POST", "/api/auth/refresh"),)

ANON_PUBLIC_ROUTES: tuple[tuple[str, str], ...] = tuple(
    r for r in PUBLIC_ROUTES if r not in COOKIE_AUTH_ROUTES
)

BODY_METHODS = frozenset({"POST", "PATCH", "PUT"})


def rid(route: tuple[str, str]) -> str:
    """Читаемый ASCII-безопасный id для parametrize."""
    return f"{route[0]}-{route[1]}".replace("{", "").replace("}", "")


def url_for(
    path: str,
    *,
    user_id: int = 1,
    guide_id: int = 1,
    entry_id: int = 1,
    block_name: str = "Медиа",
) -> str:
    """Подставляет конкретные значения в шаблон пути."""
    return (
        path.replace("{user_id}", str(user_id))
        .replace("{guide_id}", str(guide_id))
        .replace("{entry_id}", str(entry_id))
        .replace("{block_name}", block_name)
    )


def call(client, method: str, path: str, headers: dict | None = None, **kw):
    """Единая точка вызова: телу-методам всегда отдаём пустой JSON."""
    if method in BODY_METHODS and "json" not in kw and "data" not in kw:
        kw["json"] = {}
    return client.request(method, path, headers=headers or {}, **kw)


def api_routes_from_app() -> set[tuple[str, str]]:
    """Реальный набор (метод, путь) прикладных маршрутов приложения."""
    found: set[tuple[str, str]] = set()
    for route in main_module.app.routes:
        if isinstance(route, APIRoute):
            for method in route.methods:
                found.add((method, route.path))
    return found


def dependency_calls(dependant) -> list:
    """Рекурсивно собирает все callable-зависимости маршрута."""
    acc = []
    for sub in dependant.dependencies:
        acc.append(sub.call)
        acc.extend(dependency_calls(sub))
    return acc


def route_requires_current_user(route: APIRoute) -> bool:
    """True, если в дереве зависимостей есть обязательный get_current_user."""
    return auth_module.get_current_user in dependency_calls(route.dependant)


def route_object(method: str, path: str) -> APIRoute:
    for route in main_module.app.routes:
        if isinstance(route, APIRoute) and route.path == path and method in route.methods:
            return route
    raise AssertionError(f"Маршрут {method} {path} не найден в приложении")


@pytest.fixture(autouse=True)
def _clean_cookies(client):
    """
    TestClient в conftest — сессионный, у него общая банка cookie.
    Контрактные тесты про анонимный доступ не должны зависеть от того,
    что оставил после себя предыдущий тест.
    """
    client.cookies.clear()
    yield
    client.cookies.clear()


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: инвентарь маршрутов
# ═══════════════════════════════════════════════════════════════════


def test_инвентарь_маршрутов_совпадает_с_эталоном():
    """
    Набор (метод, путь) приложения точно равен эталонному литералу.

    Тест намеренно «хрупкий»: он падает при любом добавлении или удалении
    эндпоинта и заставляет автора изменения обновить и матрицу доступа.
    """
    actual = api_routes_from_app()
    expected = set(API_ROUTES)

    added = sorted(actual - expected)
    removed = sorted(expected - actual)
    assert actual == expected, (
        "Поверхность API изменилась. "
        f"Появились маршруты: {added}. Пропали маршруты: {removed}. "
        "Обнови литерал API_ROUTES и обязательно занеси новый маршрут "
        "в PUBLIC_ROUTES или PROTECTED_ROUTES."
    )


def test_эталонный_литерал_не_содержит_дублей():
    """В самом эталоне не должно быть повторов — иначе он врёт о размере API."""
    assert len(API_ROUTES) == len(set(API_ROUTES)), "В API_ROUTES есть дубликаты"


def test_матрица_доступа_покрывает_все_маршруты():
    """Каждый маршрут отнесён ровно к одной категории: публичный или защищённый."""
    public = set(PUBLIC_ROUTES)
    protected = set(PROTECTED_ROUTES)
    assert public & protected == set(), "Маршрут одновременно публичный и защищённый"
    assert public | protected == set(API_ROUTES), (
        "Матрица доступа не покрывает весь API: "
        f"не классифицированы {sorted(set(API_ROUTES) - public - protected)}"
    )


def test_все_прикладные_маршруты_имеют_префикс_api():
    """Ни один прикладной маршрут не смонтирован мимо префикса /api."""
    bad = [
        (sorted(r.methods), r.path)
        for r in main_module.app.routes
        if isinstance(r, APIRoute) and not r.path.startswith("/api/")
    ]
    assert bad == [], f"Маршруты без префикса /api: {bad}"


def test_роутер_объявлен_с_префиксом_api():
    """Префикс задаётся один раз на роутере, а не руками в каждом пути."""
    assert main_module.router.prefix == "/api", (
        f"Ожидался префикс '/api', а роутер объявлен с {main_module.router.prefix!r}"
    )


def test_кроме_api_смонтированы_только_служебные_маршруты_fastapi():
    """Всё, что вне /api, — это только /docs, /redoc и /openapi.json."""
    non_api = {
        r.path
        for r in main_module.app.routes
        if isinstance(r, Route) and not isinstance(r, APIRoute)
    }
    assert non_api == set(FASTAPI_BUILTIN_PATHS), (
        f"Вне /api смонтировано что-то лишнее или пропало служебное: {sorted(non_api)}"
    )


def test_profile_me_зарегистрирован_раньше_шаблона_с_user_id():
    """
    Порядок регистрации критичен: если /api/profile/{user_id} окажется
    выше /api/profile/me, литерал 'me' поедет в int-параметр и вернётся 422.
    """
    paths = [r.path for r in main_module.app.routes if isinstance(r, APIRoute)]
    assert paths.index("/api/profile/me") < paths.index("/api/profile/{user_id}"), (
        "/api/profile/me должен быть зарегистрирован ДО /api/profile/{user_id}"
    )


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: матрица аутентификации — без учётных данных
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("method,path", PROTECTED_ROUTES, ids=rid)
def test_защищённый_маршрут_без_токена_отдаёт_401(client, method, path):
    """Любой защищённый маршрут без Authorization отвечает 401 'Not authenticated'."""
    resp = call(client, method, url_for(path))
    assert resp.status_code == 401, (
        f"{method} {path} без токена вернул {resp.status_code}, а должен 401. "
        f"Тело: {resp.text[:200]}"
    )
    assert resp.json() == {"detail": "Not authenticated"}, (
        f"{method} {path}: неожиданное тело 401 — {resp.text[:200]}"
    )


@pytest.mark.parametrize("method,path", PROTECTED_ROUTES, ids=rid)
def test_защищённый_маршрут_отдаёт_заголовок_www_authenticate(client, method, path):
    """401 от схемы OAuth2 обязан нести WWW-Authenticate: Bearer."""
    resp = call(client, method, url_for(path))
    assert resp.headers.get("www-authenticate") == "Bearer", (
        f"{method} {path}: WWW-Authenticate = {resp.headers.get('www-authenticate')!r}"
    )


@pytest.mark.parametrize("method,path", ANON_PUBLIC_ROUTES, ids=rid)
def test_публичный_маршрут_без_токена_не_отдаёт_401(client, method, path):
    """Публичные маршруты не требуют Bearer-токен."""
    resp = call(client, method, url_for(path))
    assert resp.status_code != 401, (
        f"{method} {path} объявлен публичным, но вернул 401: {resp.text[:200]}"
    )


@pytest.mark.parametrize(
    "method,path,expected_status",
    [
        pytest.param("GET", "/api/blocks", 200, id="GET-/api/blocks"),
        pytest.param("GET", "/api/contacts", 200, id="GET-/api/contacts"),
        pytest.param("GET", "/api/guides", 200, id="GET-/api/guides"),
        # пустая база: гайда нет
        pytest.param("GET", "/api/guides/{guide_id}", 404, id="GET-/api/guides/{guide_id}"),
        # пустая база: пользователя нет
        pytest.param("GET", "/api/profile/{user_id}", 404, id="GET-/api/profile/{user_id}"),
        # пустое тело: валидация pydantic
        pytest.param("POST", "/api/auth/register", 422, id="POST-/api/auth/register"),
        pytest.param("POST", "/api/auth/login", 422, id="POST-/api/auth/login"),
        pytest.param("POST", "/api/auth/vk", 422, id="POST-/api/auth/vk"),
    ],
)
def test_публичный_маршрут_анонима_даёт_ожидаемый_код(client, method, path, expected_status):
    """Точный код ответа публичного маршрута для анонима на пустой базе."""
    resp = call(client, method, url_for(path))
    assert resp.status_code == expected_status, (
        f"{method} {path}: ожидался {expected_status}, получен {resp.status_code} "
        f"({resp.text[:200]})"
    )


def test_refresh_без_cookie_отдаёт_свой_401(client):
    """/api/auth/refresh не требует Bearer, но без cookie отдаёт собственный 401."""
    resp = client.post("/api/auth/refresh", json={})
    assert resp.status_code == 401, f"Ожидался 401, получен {resp.status_code}"
    assert resp.json() == {"detail": "Refresh token missing in cookies"}, (
        f"Неожиданное тело: {resp.text[:200]}"
    )
    assert "www-authenticate" not in {k.lower() for k in resp.headers}, (
        "refresh не использует схему Bearer, WWW-Authenticate тут неуместен"
    )


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: матрица аутентификации — забаненный пользователь
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("method,path", PROTECTED_ROUTES, ids=rid)
def test_забаненный_пользователь_получает_403_на_защищённом_маршруте(
    client, make_user, method, path
):
    """Валидный токен забаненного пользователя не даёт доступа никуда."""
    banned = make_user(banned=True, password=None, name="Бан", surname="Контрактов")
    resp = call(client, method, url_for(path, user_id=banned.user_id), headers=banned.headers)
    assert resp.status_code == 403, (
        f"{method} {path} с токеном забаненного вернул {resp.status_code}, ждали 403. "
        f"Тело: {resp.text[:200]}"
    )
    assert resp.json() == {"detail": "User is banned"}, (
        f"{method} {path}: неожиданное тело 403 — {resp.text[:200]}"
    )


@pytest.mark.parametrize("method,path", ANON_PUBLIC_ROUTES, ids=rid)
def test_забаненный_пользователь_на_публичных_маршрутах_не_получает_401(
    client, make_user, method, path
):
    """
    Публичные маршруты с токеном забаненного деградируют до анонима,
    а не отвечают 401. Фиксируем это как контракт.
    """
    banned = make_user(banned=True, password=None, name="Бан", surname="Публичный")
    resp = call(client, method, url_for(path, user_id=banned.user_id), headers=banned.headers)
    assert resp.status_code != 401, (
        f"{method} {path} с токеном забаненного вернул 401: {resp.text[:200]}"
    )


def test_забаненный_видит_публичные_гайды_как_аноним(client, make_user, make_guide):
    """
    Побочный эффект get_current_user_optional: забаненный не блокируется
    на /api/guides, а просто теряет доступ к гайдам своих блоков.
    """
    make_guide(title="Общий", owner_block="none")
    banned = make_user(banned=True, password=None, name="Бан", surname="Гайдов")
    resp = client.get("/api/guides", headers=banned.headers)
    assert resp.status_code == 200, f"Ожидался 200, получен {resp.status_code}"
    assert [g["title"] for g in resp.json()] == ["Общий"], (
        f"Забаненный должен видеть ровно публичные гайды, получено {resp.json()}"
    )


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: матрица аутентификации — битые токены
# ═══════════════════════════════════════════════════════════════════

BAD_TOKEN_CASES = (
    pytest.param("expired", "Access token invalid or expired", id="просроченный"),
    pytest.param("refresh_typed", "Not an access token", id="refresh-типа"),
    pytest.param("foreign", "Access token invalid or expired", id="чужая-подпись"),
    pytest.param("garbage", "Access token invalid or expired", id="мусор"),
    pytest.param("deleted_user", "User not found", id="удалённый-пользователь"),
)


@pytest.fixture
def bad_token(expired_access_token, refresh_typed_token, foreign_signed_token):
    """Фабрика невалидных access-токенов по имени кейса."""

    def _make(kind: str) -> str:
        # 424242 — гарантированно отсутствующий в базе user_id
        if kind == "expired":
            return expired_access_token(424242)
        if kind == "refresh_typed":
            return refresh_typed_token(424242)
        if kind == "foreign":
            return foreign_signed_token(424242)
        if kind == "garbage":
            return "definitely.not.a.jwt"
        if kind == "deleted_user":
            return auth_module.create_access_token(424242)
        raise AssertionError(f"неизвестный вид токена: {kind}")

    return _make


@pytest.mark.parametrize("method,path", PROTECTED_ROUTES, ids=rid)
@pytest.mark.parametrize("kind,detail", BAD_TOKEN_CASES)
def test_защищённый_маршрут_отвергает_невалидный_токен(
    client, bad_token, method, path, kind, detail
):
    """Каждый вид негодного токена отклоняется 401 с точным сообщением."""
    headers = {"Authorization": f"Bearer {bad_token(kind)}"}
    resp = call(client, method, url_for(path), headers=headers)
    assert resp.status_code == 401, (
        f"{method} {path} с токеном '{kind}' вернул {resp.status_code}, ждали 401. "
        f"Тело: {resp.text[:200]}"
    )
    assert resp.json() == {"detail": detail}, (
        f"{method} {path} с токеном '{kind}': тело {resp.text[:200]}"
    )


def test_токен_удалённого_пользователя_перестаёт_работать(client, make_user):
    """Access-токен остаётся подписанным, но после удаления пользователя не работает."""
    victim = make_user(password=None, name="Жертва", surname="Удалённая")
    assert client.get("/api/profile/me", headers=victim.headers).status_code == 200

    db.delete_user(victim.user_id)
    resp = client.get("/api/profile/me", headers=victim.headers)
    assert resp.status_code == 401, f"Ожидался 401, получен {resp.status_code}"
    assert resp.json() == {"detail": "User not found"}
    assert db.get_user(victim.user_id) is None, "Пользователь должен быть удалён из базы"


@pytest.mark.parametrize(
    "header_value",
    [
        pytest.param("", id="пустой-заголовок"),
        pytest.param("Basic YWRtaW46YWRtaW4=", id="чужая-схема-basic"),
        pytest.param("bearerabc", id="без-пробела"),
        pytest.param("Token abc", id="схема-token"),
    ],
)
def test_заголовок_не_разбираемый_как_bearer_даёт_not_authenticated(client, header_value):
    """Заголовок, который схема OAuth2 не признаёт своим, — это 'Not authenticated'."""
    resp = client.get("/api/profile/me", headers={"Authorization": header_value})
    assert resp.status_code == 401, f"Получен {resp.status_code}: {resp.text[:200]}"
    assert resp.json() == {"detail": "Not authenticated"}


@pytest.mark.parametrize(
    "header_value",
    [
        pytest.param("Bearer", id="только-схема"),
        pytest.param("Bearer ", id="схема-и-пробел"),
        pytest.param("Bearer      ", id="схема-и-много-пробелов"),
        pytest.param("Bearer abc def", id="лишний-пробел-внутри"),
    ],
)
def test_bearer_с_пустым_токеном_даёт_ошибку_разбора_токена(client, header_value):
    """
    'Bearer' без значения разбирается схемой как пустой токен, поэтому
    сообщение приходит уже от декодера, а не от схемы авторизации.
    """
    resp = client.get("/api/profile/me", headers={"Authorization": header_value})
    assert resp.status_code == 401, f"Получен {resp.status_code}: {resp.text[:200]}"
    assert resp.json() == {"detail": "Access token invalid or expired"}


def test_схема_bearer_регистронезависима(client, make_user):
    """RFC 7235: схема авторизации сравнивается без учёта регистра."""
    actor = make_user(password=None)
    resp = client.get(
        "/api/profile/me", headers={"Authorization": f"bearer {actor.access_token}"}
    )
    assert resp.status_code == 200, (
        f"Схема 'bearer' в нижнем регистре должна приниматься, получен "
        f"{resp.status_code}: {resp.text[:200]}"
    )


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: обработка методов
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "method,path,allow",
    [
        pytest.param("DELETE", "/api/blocks", "GET", id="DELETE-/api/blocks"),
        pytest.param("PUT", "/api/contacts", "GET", id="PUT-/api/contacts"),
        pytest.param("PATCH", "/api/guides", "GET", id="PATCH-/api/guides"),
        pytest.param("GET", "/api/auth/login", "POST", id="GET-/api/auth/login"),
        pytest.param("GET", "/api/contacts/filter", "POST", id="GET-/api/contacts/filter"),
        pytest.param("DELETE", "/api/auth/logout", "POST", id="DELETE-/api/auth/logout"),
    ],
)
def test_неверный_метод_на_существующем_пути_даёт_405(client, method, path, allow):
    """405 + заголовок Allow с реально поддерживаемыми методами."""
    resp = call(client, method, path)
    assert resp.status_code == 405, (
        f"{method} {path}: ожидался 405, получен {resp.status_code} ({resp.text[:200]})"
    )
    assert resp.json() == {"detail": "Method Not Allowed"}
    assert resp.headers.get("allow") == allow, (
        f"{method} {path}: Allow = {resp.headers.get('allow')!r}, ожидался {allow!r}"
    )


def test_405_возвращается_до_проверки_авторизации(client):
    """
    Неверный метод отрабатывает на уровне роутера — раньше зависимостей,
    поэтому 405 приходит и без токена, и не превращается в 401.
    """
    resp = client.delete("/api/auth/logout")
    assert resp.status_code == 405, f"Получен {resp.status_code}"


@pytest.mark.parametrize(
    "method,path",
    [
        pytest.param("HEAD", "/api/guides", id="HEAD-/api/guides"),
        pytest.param("HEAD", "/api/blocks", id="HEAD-/api/blocks"),
        pytest.param("HEAD", "/api/contacts", id="HEAD-/api/contacts"),
    ],
)
def test_head_на_get_маршрутах_не_поддерживается(client, method, path):
    """
    Фиксируем как есть: FastAPI не добавляет HEAD к GET-маршрутам автоматически.
    Мониторинги и балансировщики, пингующие HEAD, получат 405, а не 200.
    """
    resp = client.request(method, path)
    assert resp.status_code == 405, (
        f"{method} {path}: поведение изменилось, получен {resp.status_code}"
    )


@pytest.mark.parametrize(
    "method,path",
    [
        pytest.param("GET", "/api/nonexistent", id="GET-/api/nonexistent"),
        pytest.param("POST", "/api/nonexistent", id="POST-/api/nonexistent"),
        pytest.param("GET", "/api", id="GET-/api"),
        pytest.param("GET", "/", id="GET-корень"),
        pytest.param("GET", "/api/guides/1/extra", id="GET-лишний-сегмент"),
        pytest.param("GET", "/api/Guides", id="GET-другой-регистр"),
    ],
)
def test_неизвестный_путь_даёт_404(client, method, path):
    """Неизвестные пути — 404 со стандартным телом Starlette."""
    resp = call(client, method, path)
    assert resp.status_code == 404, (
        f"{method} {path}: ожидался 404, получен {resp.status_code} ({resp.text[:200]})"
    )
    assert resp.json() == {"detail": "Not Found"}


def test_пути_чувствительны_к_регистру(client):
    """/api/Blocks не равен /api/blocks — маршрутизация регистрозависима."""
    assert client.get("/api/blocks").status_code == 200
    assert client.get("/api/Blocks").status_code == 404


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: завершающий слэш
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/api/guides", id="/api/guides"),
        pytest.param("/api/blocks", id="/api/blocks"),
        pytest.param("/api/contacts", id="/api/contacts"),
    ],
)
def test_путь_без_слэша_обрабатывается_напрямую(client, path):
    """Канонический путь без завершающего слэша отвечает сразу, без редиректа."""
    resp = client.get(path, follow_redirects=False)
    assert resp.status_code == 200, f"{path}: получен {resp.status_code}"
    assert "location" not in {k.lower() for k in resp.headers}, (
        f"{path}: неожиданный редирект на {resp.headers.get('location')}"
    )


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/api/guides/", id="/api/guides/"),
        pytest.param("/api/blocks/", id="/api/blocks/"),
        pytest.param("/api/contacts/", id="/api/contacts/"),
        pytest.param("/api/profile/me/", id="/api/profile/me/"),
    ],
)
def test_путь_со_слэшем_даёт_307_редирект(client, path):
    """
    Starlette redirect_slashes: путь с завершающим слэшем отдаёт 307
    на канонический путь. 307 сохраняет метод и тело.
    """
    resp = client.get(path, follow_redirects=False)
    assert resp.status_code == 307, (
        f"{path}: ожидался 307, получен {resp.status_code} ({resp.text[:200]})"
    )
    location = resp.headers.get("location")
    assert location is not None, f"{path}: нет заголовка Location"
    assert location.endswith(path.rstrip("/")), (
        f"{path}: Location = {location!r}, ожидалось указание на {path.rstrip('/')!r}"
    )


def test_location_редиректа_абсолютный_и_несёт_схему_запроса(client):
    """
    Фиксируем реальное поведение: Location — АБСОЛЮТНЫЙ URL, а схема берётся
    из запроса. За TLS-терминирующим прокси без X-Forwarded-Proto это даёт
    редирект на http:// — деградация до незашифрованного канала.
    """
    resp = client.get("/api/guides/", follow_redirects=False)
    location = resp.headers["location"]
    assert location.startswith("http://"), (
        f"Ожидался абсолютный URL со схемой запроса, получен {location!r}"
    )
    assert location.endswith("/api/guides")


def test_редирект_со_слэша_доводит_до_реального_ответа(client, make_guide):
    """После следования за 307 клиент получает нормальный ответ эндпоинта."""
    make_guide(title="Слэш", owner_block="none")
    resp = client.get("/api/guides/", follow_redirects=True)
    assert resp.status_code == 200, f"Получен {resp.status_code}"
    assert [h.status_code for h in resp.history] == [307], (
        f"Ожидался ровно один 307 в истории, получено {[h.status_code for h in resp.history]}"
    )
    assert [g["title"] for g in resp.json()] == ["Слэш"]


def test_post_со_слэшем_тоже_редиректится_307(client):
    """307 (а не 301/302) сохраняет метод POST — тело не теряется."""
    resp = client.post("/api/auth/login/", json={"email": "a@b.ru", "password": "x"},
                       follow_redirects=False)
    assert resp.status_code == 307, f"Ожидался 307, получен {resp.status_code}"
    assert resp.headers["location"].endswith("/api/auth/login")


def test_редирект_со_слэша_не_обходит_авторизацию(client):
    """
    Важно для безопасности: /api/profile/me/ не должен «проскакивать»
    мимо проверки токена — после редиректа всё равно 401.
    """
    resp = client.get("/api/profile/me/", follow_redirects=True)
    assert resp.status_code == 401, f"Получен {resp.status_code}: {resp.text[:200]}"
    assert resp.json() == {"detail": "Not authenticated"}


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: CORS
# ═══════════════════════════════════════════════════════════════════

FOREIGN_ORIGIN = "https://evil.example.com"


def test_список_origins_ровно_такой_как_объявлен():
    """Пинним состав main.origins — молчаливое расширение недопустимо."""
    assert main_module.origins == [
        main_module.FRONTEND_URL,
        "https://5x4kxnk4-5173.euw.devtunnels.ms",
    ], f"Состав разрешённых origin изменился: {main_module.origins}"


@pytest.mark.parametrize("origin", main_module.origins, ids=lambda o: o)
def test_preflight_разрешённого_origin_отражается_обратно(client, origin):
    """OPTIONS-preflight с разрешённого origin: 200 и эхо этого origin."""
    resp = client.options(
        "/api/guides",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )
    assert resp.status_code == 200, (
        f"preflight с {origin} вернул {resp.status_code}: {resp.text[:200]}"
    )
    assert resp.headers.get("access-control-allow-origin") == origin, (
        f"Ожидалось эхо {origin}, получено "
        f"{resp.headers.get('access-control-allow-origin')!r}"
    )


@pytest.mark.parametrize("origin", main_module.origins, ids=lambda o: o)
def test_preflight_разрешает_передачу_учётных_данных(client, origin):
    """allow_credentials=True ⇒ access-control-allow-credentials: true."""
    resp = client.options(
        "/api/guides",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )
    assert resp.headers.get("access-control-allow-credentials") == "true", (
        f"Ожидался 'true', получено "
        f"{resp.headers.get('access-control-allow-credentials')!r}"
    )


@pytest.mark.parametrize("origin", main_module.origins, ids=lambda o: o)
def test_preflight_помечает_ответ_vary_origin(client, origin):
    """Vary: Origin обязателен, иначе кэш отдаст чужому origin чужие заголовки."""
    resp = client.options(
        "/api/guides",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )
    assert "origin" in resp.headers.get("vary", "").lower(), (
        f"Vary = {resp.headers.get('vary')!r}"
    )


def test_чужой_origin_в_preflight_не_отражается(client):
    """Ключевая проверка CORS: чужой origin не получает allow-origin."""
    resp = client.options(
        "/api/guides",
        headers={"Origin": FOREIGN_ORIGIN, "Access-Control-Request-Method": "GET"},
    )
    assert resp.status_code == 400, (
        f"Ожидался 400 Disallowed CORS origin, получен {resp.status_code}"
    )
    assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}, (
        "Чужому origin вернули access-control-allow-origin — это дыра"
    )


def test_чужой_origin_в_простом_запросе_не_отражается(client):
    """Простой GET с чужого origin выполняется, но без allow-origin в ответе."""
    resp = client.get("/api/blocks", headers={"Origin": FOREIGN_ORIGIN})
    assert resp.status_code == 200, f"Получен {resp.status_code}"
    assert "access-control-allow-origin" not in {k.lower() for k in resp.headers}, (
        f"Чужой origin отражён: {resp.headers.get('access-control-allow-origin')!r}"
    )


def test_простой_запрос_со_своего_origin_получает_заголовки_cors(client):
    """Обычный GET с разрешённого origin получает allow-origin и allow-credentials."""
    origin = main_module.origins[0]
    resp = client.get("/api/blocks", headers={"Origin": origin})
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == origin
    assert resp.headers.get("access-control-allow-credentials") == "true"


def test_preflight_разрешает_все_http_методы(client):
    """
    Пинним следствие allow_methods=["*"]: разрешаются все стандартные глаголы,
    включая те, которых у эндпоинта нет. См. отчёт по дефектам.
    """
    resp = client.options(
        "/api/guides",
        headers={"Origin": main_module.origins[0], "Access-Control-Request-Method": "DELETE"},
    )
    assert resp.status_code == 200, (
        "DELETE не объявлен на /api/guides, но preflight его разрешает — "
        f"получен {resp.status_code}"
    )
    allowed = {m.strip() for m in resp.headers["access-control-allow-methods"].split(",")}
    assert {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"} <= allowed, (
        f"Список разрешённых методов сузился: {sorted(allowed)}"
    )


def test_preflight_с_нестандартным_методом_отклоняется(client):
    """Метод вне списка ALL_METHODS Starlette (например TRACE) не разрешается."""
    resp = client.options(
        "/api/guides",
        headers={"Origin": main_module.origins[0], "Access-Control-Request-Method": "TRACE"},
    )
    assert resp.status_code == 400, f"Получен {resp.status_code}"


def test_options_без_origin_не_обрабатывается_как_preflight(client):
    """Без заголовка Origin OPTIONS уходит в роутер и получает 405."""
    resp = client.options("/api/guides")
    assert resp.status_code == 405, f"Получен {resp.status_code}: {resp.text[:200]}"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "БАГ: в список CORS-origin намертво зашит сторонний dev-туннель "
        "'https://5x4kxnk4-5173.euw.devtunnels.ms' с allow_credentials=True — "
        "тот, кто получит это поддоменное имя, сможет слать запросы с cookie "
        "пользователей (main.py:39)"
    ),
)
def test_в_разрешённых_origin_нет_стороннего_dev_туннеля():
    """Продовый список origin не должен содержать временных dev-туннелей."""
    tunnels = [o for o in main_module.origins if "devtunnels.ms" in o or "ngrok" in o]
    assert tunnels == [], f"Сторонние dev-туннели в CORS-allowlist: {tunnels}"


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: OpenAPI
# ═══════════════════════════════════════════════════════════════════


@pytest.fixture(scope="module")
def spec():
    return main_module.app.openapi()


def test_openapi_json_отдаётся_и_валиден(client):
    """GET /openapi.json — 200, корректный JSON, схема версии 3.x."""
    resp = client.get("/openapi.json")
    assert resp.status_code == 200, f"Получен {resp.status_code}"
    assert resp.headers["content-type"].startswith("application/json")
    doc = json.loads(resp.text)
    assert doc["openapi"].startswith("3."), f"Версия схемы: {doc['openapi']}"
    assert doc["info"]["title"] == "Profcom backend"
    assert isinstance(doc["paths"], dict) and doc["paths"], "paths пуст"


def test_openapi_отдаётся_анониму(client):
    """Схема API публична — фиксируем это осознанно (см. отчёт по дефектам)."""
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200


@pytest.mark.parametrize("method,path", API_ROUTES, ids=rid)
def test_каждый_маршрут_присутствует_в_openapi(spec, method, path):
    """Ни один эндпоинт не спрятан от схемы (include_in_schema=False)."""
    assert path in spec["paths"], f"Путь {path} отсутствует в OpenAPI"
    assert method.lower() in spec["paths"][path], (
        f"Метод {method} для {path} отсутствует в OpenAPI: "
        f"есть только {sorted(spec['paths'][path])}"
    )


def test_openapi_не_содержит_лишних_путей(spec):
    """Обратное направление: в схеме нет путей, которых нет в приложении."""
    documented = {(m.upper(), p) for p, item in spec["paths"].items() for m in item}
    assert documented == set(API_ROUTES), (
        f"Лишнее в схеме: {sorted(documented - set(API_ROUTES))}; "
        f"не задокументировано: {sorted(set(API_ROUTES) - documented)}"
    )


def test_схема_безопасности_объявлена(spec):
    """В components должна быть ровно одна схема — OAuth2PasswordBearer."""
    schemes = spec["components"]["securitySchemes"]
    assert list(schemes) == ["OAuth2PasswordBearer"], f"Схемы: {list(schemes)}"
    assert schemes["OAuth2PasswordBearer"]["type"] == "oauth2"
    flows = schemes["OAuth2PasswordBearer"]["flows"]
    assert flows["password"]["tokenUrl"] == "/api/auth/login", (
        f"tokenUrl = {flows['password'].get('tokenUrl')!r}"
    )


@pytest.mark.parametrize("method,path", PROTECTED_ROUTES, ids=rid)
def test_защищённый_маршрут_помечен_требованием_безопасности(spec, method, path):
    """Каждый маршрут с Depends(get_current_user) несёт security в схеме."""
    route = route_object(method, path)
    assert route_requires_current_user(route), (
        f"{method} {path} отнесён к защищённым, но get_current_user "
        "не найден в дереве зависимостей"
    )
    operation = spec["paths"][path][method.lower()]
    assert operation.get("security") == [{"OAuth2PasswordBearer": []}], (
        f"{method} {path}: security = {operation.get('security')!r}"
    )


@pytest.mark.parametrize(
    "method,path",
    [
        pytest.param("GET", "/api/blocks", id="GET-/api/blocks"),
        pytest.param("GET", "/api/contacts", id="GET-/api/contacts"),
        pytest.param("GET", "/api/profile/{user_id}", id="GET-/api/profile/{user_id}"),
        pytest.param("POST", "/api/auth/register", id="POST-/api/auth/register"),
        pytest.param("POST", "/api/auth/login", id="POST-/api/auth/login"),
        pytest.param("POST", "/api/auth/vk", id="POST-/api/auth/vk"),
        pytest.param("POST", "/api/auth/refresh", id="POST-/api/auth/refresh"),
    ],
)
def test_полностью_публичный_маршрут_не_помечен_security(spec, method, path):
    """У маршрутов вообще без зависимости на токен нет требования безопасности."""
    route = route_object(method, path)
    assert not route_requires_current_user(route), (
        f"{method} {path} неожиданно зависит от get_current_user"
    )
    operation = spec["paths"][path][method.lower()]
    assert "security" not in operation, (
        f"{method} {path}: в схеме указано security = {operation.get('security')!r}, "
        "хотя маршрут не требует токена"
    )


@pytest.mark.parametrize(
    "method,path,anon_status",
    [
        pytest.param("GET", "/api/guides", 200, id="GET-/api/guides"),
        pytest.param("GET", "/api/guides/{guide_id}", 404, id="GET-/api/guides/{guide_id}"),
    ],
)
def test_расхождение_схемы_и_поведения_на_гайдах(client, spec, method, path, anon_status):
    """
    ЗАФИКСИРОВАННОЕ РАСХОЖДЕНИЕ. Маршруты гайдов используют
    get_current_user_optional (auto_error=False), поэтому реально работают
    анонимно, но OpenAPI помечает их как требующие OAuth2PasswordBearer:
    сгенерированный из схемы клиент будет считать их закрытыми.
    """
    route = route_object(method, path)
    assert auth_module.get_current_user_optional in dependency_calls(route.dependant)
    assert not route_requires_current_user(route)

    operation = spec["paths"][path][method.lower()]
    assert operation.get("security") == [{"OAuth2PasswordBearer": []}], (
        "Схема перестала помечать маршрут как защищённый — расхождение исправлено, "
        "обнови этот тест"
    )
    resp = call(client, method, url_for(path))
    assert resp.status_code == anon_status, (
        f"{method} {path} анонимно вернул {resp.status_code}, ожидался {anon_status}"
    )


def test_каждая_операция_описывает_ответ_422_для_тел_и_параметров(spec):
    """Операции с телом или параметрами пути обязаны документировать 422."""
    missing = []
    for method, path in API_ROUTES:
        operation = spec["paths"][path][method.lower()]
        has_input = "requestBody" in operation or operation.get("parameters")
        if has_input and "422" not in operation["responses"]:
            missing.append((method, path))
    assert missing == [], f"Операции без описанного 422: {missing}"


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: форма ошибок (контракт с фронтендом — он читает data.detail)
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "method,path,status,detail",
    [
        pytest.param("GET", "/api/profile/999999", 404, "User not found", id="404-профиль"),
        pytest.param("GET", "/api/guides/999999", 404, "Guide not found", id="404-гайд"),
        pytest.param("GET", "/api/profile/me", 401, "Not authenticated", id="401-без-токена"),
        pytest.param("POST", "/api/auth/refresh", 401,
                     "Refresh token missing in cookies", id="401-refresh"),
        pytest.param("GET", "/api/nonexistent", 404, "Not Found", id="404-неизвестный-путь"),
        pytest.param("DELETE", "/api/blocks", 405, "Method Not Allowed", id="405"),
    ],
)
def test_ошибка_http_имеет_форму_detail_строка(client, method, path, status, detail):
    """Все HTTPException отдают ровно {"detail": "<строка>"} — и ничего больше."""
    resp = call(client, method, path)
    assert resp.status_code == status, (
        f"{method} {path}: получен {resp.status_code} ({resp.text[:200]})"
    )
    body = resp.json()
    assert isinstance(body, dict), f"Тело не объект: {body!r}"
    assert list(body) == ["detail"], f"Лишние ключи в теле ошибки: {sorted(body)}"
    assert body["detail"] == detail, f"detail = {body['detail']!r}"
    assert isinstance(body["detail"], str)


def test_ошибка_валидации_имеет_стандартную_форму_pydantic(client):
    """422: detail — список объектов с ключами type/loc/msg/input."""
    resp = client.post("/api/auth/login", json={"email": "не-почта", "password": 123})
    assert resp.status_code == 422, f"Получен {resp.status_code}"
    body = resp.json()
    assert list(body) == ["detail"], f"Лишние ключи: {sorted(body)}"
    assert isinstance(body["detail"], list) and body["detail"], "detail должен быть непустым списком"
    for item in body["detail"]:
        assert isinstance(item, dict), f"Элемент detail не объект: {item!r}"
        assert {"type", "loc", "msg", "input"} <= set(item), (
            f"В элементе detail не хватает ключей: {sorted(item)}"
        )
        assert isinstance(item["loc"], list), f"loc не список: {item['loc']!r}"
        assert isinstance(item["msg"], str)
    locations = {tuple(i["loc"]) for i in body["detail"]}
    assert ("body", "email") in locations, f"Нет ошибки по email: {locations}"
    assert ("body", "password") in locations, f"Нет ошибки по password: {locations}"


def test_ошибка_валидации_пути_указывает_на_path(client, make_user):
    """Нечисловой user_id в пути — 422 с loc = ['path', 'user_id']."""
    actor = make_user(password=None)
    resp = client.patch("/api/profile/не-число", json={}, headers=actor.headers)
    assert resp.status_code == 422, f"Получен {resp.status_code}: {resp.text[:200]}"
    locs = {tuple(i["loc"]) for i in resp.json()["detail"]}
    assert ("path", "user_id") in locs, f"Полученные loc: {locs}"


def test_patch_profile_me_упирается_в_валидацию_user_id(client, make_user):
    """
    Для PATCH нет алиаса /profile/me — литерал 'me' попадает в int-параметр.
    Фиксируем: с валидным токеном это 422, а не 404 и не 200.
    """
    actor = make_user(password=None)
    resp = client.patch("/api/profile/me", json={}, headers=actor.headers)
    assert resp.status_code == 422, f"Получен {resp.status_code}: {resp.text[:200]}"
    assert ("path", "user_id") in {tuple(i["loc"]) for i in resp.json()["detail"]}


def test_битый_json_в_теле_даёт_422_а_не_500(client, make_user):
    """Невалидный JSON не должен ронять обработчик."""
    actor = make_user(password=None)
    resp = client.post(
        "/api/auth/change-password",
        content="{не json".encode("utf-8"),
        headers={**actor.headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 422, f"Получен {resp.status_code}: {resp.text[:200]}"
    assert "detail" in resp.json()


def test_проверка_токена_идёт_раньше_валидации_тела(client, make_user):
    """
    Порядок важен: неавторизованный не должен по кодам ответа различать
    валидное и невалидное тело — иначе это канал утечки информации о схеме.
    """
    valid_body = client.post("/api/auth/change-password", json={"new_password": "x"})
    invalid_body = client.post("/api/auth/change-password", json={"мусор": 1})
    assert valid_body.status_code == invalid_body.status_code == 401, (
        f"Коды разошлись: {valid_body.status_code} и {invalid_body.status_code}"
    )
    assert valid_body.json() == invalid_body.json() == {"detail": "Not authenticated"}


def test_запрос_отклонённый_авторизацией_не_меняет_базу(client, make_user):
    """Побочный эффект не должен произойти, если запрос отбит на входе."""
    banned = make_user(banned=True, password=None, name="Бан", surname="Побочный")
    before = len(db.list_blocks())

    resp = client.post(
        "/api/blocks",
        json={"name": "Новый блок", "master": "Кто-то"},
        headers=banned.headers,
    )
    assert resp.status_code == 403, f"Получен {resp.status_code}"
    assert len(db.list_blocks()) == before, "Блок создан, несмотря на отказ в доступе"
    assert db.get_block("Новый блок") is None, "Блок оказался в базе после 403"


# ═══════════════════════════════════════════════════════════════════
#  ТЕСТЫ: целостность модуля auth
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.xfail(
    strict=True,
    reason=(
        "БАГ: в auth.py используется typing.Optional в аннотации "
        "get_current_user_optional, но Optional не импортирован; "
        "спасает только 'from __future__ import annotations' и снисходительный "
        "eval аннотаций в FastAPI (auth.py:106)"
    ),
)
def test_аннотации_модуля_auth_разрешаются():
    """Аннотации всех зависимостей auth должны быть вычислимы."""
    typing.get_type_hints(auth_module.get_current_user_optional)


def test_обязательная_и_опциональная_схемы_различаются_только_auto_error():
    """Опциональная схема не должна сама бросать 401 — этим занимается код."""
    assert auth_module.oauth2_scheme.auto_error is True
    assert auth_module.oauth2_scheme_optional.auto_error is False
