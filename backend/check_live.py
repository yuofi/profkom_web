#!/usr/bin/env python3
"""
Проверка ЖИВОГО бэкенда Профком ВМК (контракт API 1.3).

Отдельный процесс, не требующий pytest, venv и вообще каких-либо
зависимостей — только стандартная библиотека Python 3.9+.
Ходит по HTTP в уже запущенный сервер и проверяет, что API отвечает
так, как ожидает фронтенд.

    python3 check_live.py                          # localhost:8000
    python3 check_live.py --url https://site.ru    # боевой сервер
    python3 check_live.py --read-only              # ничего не создаёт
    python3 check_live.py --email a@b.ru --password ... --read-only

По умолчанию скрипт РЕГИСТРИРУЕТ временного пользователя. Он остаётся
неодобренным, поэтому проверяется доступ заявки, а не участника.
Проверки одобренного участника требуют --email/--password.

--read-only отправляет только GET (и CORS preflight OPTIONS), а с
--email ещё вход, обновление токена и выход: POST /api/auth/login,
/api/auth/refresh, /api/auth/logout. Проверки запретов, которым нужен
POST/PATCH/DELETE, и правка своего профиля в этом режиме пропускаются.
Без --read-only правка своего профиля возвращает прежнее значение.

Код возврата: 0 — все проверки прошли, 1 — есть провалы.
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

# ─────────────────────────── вывод ───────────────────────────
_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


GREEN = lambda s: _c(s, "32")      # noqa: E731
RED = lambda s: _c(s, "31")        # noqa: E731
YELLOW = lambda s: _c(s, "33")     # noqa: E731
DIM = lambda s: _c(s, "2")         # noqa: E731
BOLD = lambda s: _c(s, "1")        # noqa: E731


@dataclass
class Result:
    name: str
    ok: bool
    detail: str = ""
    skipped: bool = False
    ms: int = 0


@dataclass
class Report:
    results: list[Result] = field(default_factory=list)

    def add(self, r: Result) -> Result:
        self.results.append(r)
        mark = YELLOW("SKIP") if r.skipped else (GREEN(" OK ") if r.ok else RED("FAIL"))
        timing = DIM(f"{r.ms:>4}ms") if r.ms else DIM("     ")
        print(f"  [{mark}] {timing}  {r.name}")
        if r.detail and (not r.ok or r.skipped):
            for line in r.detail.splitlines():
                print(f"          {DIM(line)}")
        return r

    @property
    def failed(self) -> list[Result]:
        return [r for r in self.results if not r.ok and not r.skipped]

    @property
    def passed(self) -> list[Result]:
        return [r for r in self.results if r.ok and not r.skipped]

    @property
    def skipped(self) -> list[Result]:
        return [r for r in self.results if r.skipped]


# ─────────────────────────── HTTP ───────────────────────────
class Api:
    def __init__(self, base_url: str, timeout: float = 15.0, insecure: bool = False):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.token: Optional[str] = None
        self.cookies: dict[str, str] = {}
        self._ctx = ssl.create_default_context()
        if insecure:
            self._ctx.check_hostname = False
            self._ctx.verify_mode = ssl.CERT_NONE

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        auth: bool = False,
        token: Optional[str] = None,
        send_cookies: bool = True,
        extra_headers: Optional[dict] = None,
    ) -> tuple[int, Any, dict]:
        url = self.base + path
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        use_token = token if token is not None else (self.token if auth else None)
        if use_token:
            headers["Authorization"] = f"Bearer {use_token}"
        if send_cookies and self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        if extra_headers:
            headers.update(extra_headers)

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx) as resp:
                raw = resp.read()
                self._store_cookies(resp.headers)
                return resp.status, _maybe_json(raw), dict(resp.headers)
        except urllib.error.HTTPError as e:
            raw = e.read()
            self._store_cookies(e.headers)
            return e.code, _maybe_json(raw), dict(e.headers)
        except urllib.error.URLError as e:
            raise ConnectionError(f"не удалось соединиться с {url}: {e.reason}") from e

    def _store_cookies(self, headers) -> None:
        for value in headers.get_all("Set-Cookie") or []:
            pair = value.split(";", 1)[0]
            if "=" in pair:
                k, v = pair.split("=", 1)
                if v in ('""', ""):
                    self.cookies.pop(k, None)
                else:
                    self.cookies[k] = v


def _maybe_json(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return raw[:400].decode("utf-8", "replace")


# ─────────────────────────── помощники проверок ───────────────────────────
def check(report: Report, name: str, fn) -> Result:
    started = time.time()
    try:
        detail = fn()
        ms = int((time.time() - started) * 1000)
        return report.add(Result(name, True, detail or "", ms=ms))
    except SkipCheck as e:
        return report.add(Result(name, True, str(e), skipped=True))
    except AssertionError as e:
        ms = int((time.time() - started) * 1000)
        return report.add(Result(name, False, str(e), ms=ms))
    except Exception as e:  # noqa: BLE001
        ms = int((time.time() - started) * 1000)
        return report.add(Result(name, False, f"{type(e).__name__}: {e}", ms=ms))


class SkipCheck(Exception):
    pass


def expect_status(got: int, want: int, path: str, body: Any = None) -> None:
    assert got == want, f"{path}: ожидался HTTP {want}, получен {got}" + (
        f"\nтело ответа: {json.dumps(body, ensure_ascii=False)[:300]}" if body is not None else ""
    )


def expect_fields(obj: Any, fields: list[str], where: str) -> None:
    assert isinstance(obj, dict), f"{where}: ожидался объект, получен {type(obj).__name__}"
    missing = [f for f in fields if f not in obj]
    assert not missing, f"{where}: в ответе нет полей {missing}. Пришло: {sorted(obj)[:20]}"


# ─────────────────────────── сценарии ───────────────────────────
READ_ONLY_SKIP = "режим --read-only: проверка отправляет изменяющий запрос"


def run_public(api: Api, rep: Report) -> None:
    print(BOLD("\n▸ Публичные маршруты (без авторизации)"))

    def openapi():
        st, body, _ = api.request("GET", "/openapi.json")
        expect_status(st, 200, "/openapi.json", body)
        assert isinstance(body, dict) and "paths" in body, "openapi.json без ключа paths"
        paths = [p for p in body["paths"] if p.startswith("/api/")]
        assert len(paths) >= 15, f"в схеме всего {len(paths)} маршрутов /api — сервер собран не полностью"
        return f"маршрутов в схеме: {len(paths)}"

    check(rep, "GET /openapi.json — схема отдаётся", openapi)

    def closed(path: str):
        def probe():
            st, body, _ = api.request("GET", path)
            if st == 200 and isinstance(body, list) and body:
                assert False, f"{path} доступен БЕЗ авторизации: {len(body)} записей — утечка содержимого"
            expect_status(st, 401, f"{path} без токена", body)
            return ""
        return probe

    # API 1.3: содержимое видно только одобренным участникам (AUTH-01).
    for path, what in [
        ("/api/blocks", "блоки"),
        ("/api/guides", "гайды"),
        ("/api/contacts", "справочник контактов"),
        ("/api/session", "сессия"),
        ("/api/profile/me", "профиль"),
    ]:
        check(rep, f"GET {path} без токена → 401 ({what})", closed(path))

    def unknown_path():
        st, _, _ = api.request("GET", "/api/definitely-not-a-route")
        expect_status(st, 404, "/api/definitely-not-a-route")
        return ""

    check(rep, "GET несуществующего пути → 404", unknown_path)

    def bad_token():
        # заголовок кодируется в latin-1, поэтому мусор должен быть ASCII
        st, _, _ = api.request("GET", "/api/profile/me", token="not-a-token-at-all.aaa.bbb")
        expect_status(st, 401, "/api/profile/me с мусорным токеном")
        return ""

    check(rep, "GET /api/profile/me с мусорным токеном → 401", bad_token)

    def cors():
        st, _, headers = api.request(
            "OPTIONS",
            "/api/guides",
            extra_headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        allow = headers.get("access-control-allow-origin") or headers.get("Access-Control-Allow-Origin")
        assert allow != "https://evil.example.com", (
            "CORS отражает произвольный Origin — любой сайт сможет читать API от имени пользователя"
        )
        assert allow != "*", "CORS отдаёт '*' вместе с credentials — это небезопасно"
        return f"чужой Origin не отражён (allow-origin={allow!r})"

    check(rep, "CORS не отражает произвольный Origin", cors)


def run_auth(api: Api, rep: Report, args) -> Optional[str]:
    """Входит или регистрирует временную учётку; возвращает режим или None."""
    print(BOLD("\n▸ Авторизация"))

    if args.email and args.password:
        def login_existing():
            st, body, _ = api.request(
                "POST", "/api/auth/login", {"email": args.email, "password": args.password}
            )
            expect_status(st, 200, "/api/auth/login", body)
            expect_fields(body, ["access_token", "refresh_token", "token_type"], "TokenPair")
            api.token = body["access_token"]
            return f"вошли как {args.email}"

        r = check(rep, "POST /api/auth/login — вход существующей учёткой", login_existing)
        return "existing" if r.ok else None

    if args.read_only:
        rep.add(Result(
            "Проверки защищённых маршрутов",
            True,
            "режим --read-only без --email/--password: пропущено, чтобы ничего не создавать на сервере",
            skipped=True,
        ))
        return None

    ident = uuid.uuid4().hex[:8]
    creds = {
        "email": f"healthcheck_{ident}@example.com",
        "password": f"Hc-{ident}-Pw!",
        "name": "Проверка",
        "surname": f"Скрипт{ident[:4]}",
        "patronymic": "",
        "group_number": 101,
        "tg": f"hc_{ident}",
        # Every field but the patronymic is required at the sign-up (decision 29).
        "phone": "+79990000000",
        "vk": "https://vk.com/id1",
        "funding": "budget",
        "residence": "Проверка",
    }

    def register():
        st, body, headers = api.request("POST", "/api/auth/register", creds)
        expect_status(st, 201, "/api/auth/register", body)
        expect_fields(body, ["access_token", "refresh_token", "token_type"], "TokenPair")
        assert body["token_type"] == "bearer", f"token_type={body['token_type']!r}, ожидался 'bearer'"
        set_cookie = headers.get("set-cookie") or headers.get("Set-Cookie") or ""
        assert "refresh_token" in set_cookie, "сервер не выставил cookie refresh_token"
        assert "HttpOnly" in set_cookie, "cookie refresh_token без флага HttpOnly"
        api.token = body["access_token"]
        return f"создан временный пользователь {creds['email']}"

    if not check(rep, "POST /api/auth/register — регистрация", register).ok:
        return None

    def duplicate():
        st, body, _ = api.request("POST", "/api/auth/register", creds)
        expect_status(st, 409, "повторная регистрация", body)
        assert body.get("detail") == "Email already registered", f"detail={body.get('detail')!r}"
        return ""

    check(rep, "POST /api/auth/register с занятым email → 409", duplicate)

    def bad_group():
        st, _, _ = api.request("POST", "/api/auth/register", {**creds, "email": f"x{ident}@e.ru", "group_number": 999})
        expect_status(st, 422, "регистрация с group_number=999")
        return "валидация 100..700 работает"

    check(rep, "POST /api/auth/register с неверной группой → 422", bad_group)

    def bad_tg():
        st, _, _ = api.request("POST", "/api/auth/register", {**creds, "email": f"y{ident}@e.ru", "tg": "аб"})
        expect_status(st, 422, "регистрация с некорректным tg")
        return "валидация telegram работает"

    check(rep, "POST /api/auth/register с некорректным telegram → 422", bad_tg)

    def login_wrong():
        st, body, _ = api.request("POST", "/api/auth/login", {"email": creds["email"], "password": "неверный"})
        expect_status(st, 401, "вход с неверным паролем", body)
        return ""

    check(rep, "POST /api/auth/login с неверным паролем → 401", login_wrong)

    def login_unknown():
        st, body, _ = api.request("POST", "/api/auth/login", {"email": f"nobody{ident}@e.ru", "password": "x"})
        expect_status(st, 401, "вход несуществующего пользователя", body)
        return ""

    check(rep, "POST /api/auth/login с неизвестным email → 401", login_unknown)
    return "temp"


def run_session(api: Api, rep: Report) -> Optional[dict]:
    """GET /api/session доступен и заявке, и участнику; по нему выбираются проверки."""
    print(BOLD("\n▸ Сессия"))
    state: dict[str, Any] = {}

    def session():
        st, body, _ = api.request("GET", "/api/session", auth=True)
        expect_status(st, 200, "/api/session", body)
        expect_fields(
            body,
            ["user_id", "account_state", "registration_status", "access_revision", "capabilities"],
            "SessionOut",
        )
        assert isinstance(body["capabilities"], list), "capabilities должен быть списком"
        state["session"] = body
        return (f"user_id={body['user_id']}, account_state={body['account_state']}, "
                f"registration_status={body['registration_status']}")

    if not check(rep, "GET /api/session — состояние учётки", session).ok:
        return None

    def registration():
        st, body, _ = api.request("GET", "/api/registrations/me", auth=True)
        expect_status(st, 200, "/api/registrations/me", body)
        expect_fields(body, ["user_id", "status", "revision"], "RegistrationOut")
        assert body["status"] == state["session"]["registration_status"], (
            f"статус заявки {body['status']!r} не совпадает с сессией "
            f"{state['session']['registration_status']!r}"
        )
        return f"заявка: {body['status']}"

    check(rep, "GET /api/registrations/me — своя заявка", registration)
    return state["session"]


def run_pending(api: Api, rep: Report, session: dict) -> None:
    print(BOLD("\n▸ Неодобренная учётка"))

    def no_capabilities():
        assert session["capabilities"] == [], f"у неодобренной учётки права {session['capabilities']}"
        return ""

    check(rep, "GET /api/session — у заявки нет прав", no_capabilities)

    def forbidden(path: str):
        def probe():
            st, body, _ = api.request("GET", path, auth=True)
            expect_status(st, 403, f"{path} неодобренной учёткой", body)
            return ""
        return probe

    for path in ("/api/profile/me", "/api/blocks", "/api/guides", "/api/contacts"):
        check(rep, f"GET {path} до одобрения → 403", forbidden(path))


def run_approved(api: Api, rep: Report, session: dict, read_only: bool) -> None:
    print(BOLD("\n▸ Одобренный участник"))

    state: dict[str, Any] = {}
    caps = set(session.get("capabilities") or [])
    is_chair = bool(session.get("super_user") or (session.get("leadership") or {}).get("is_chair"))

    def me():
        st, body, _ = api.request("GET", "/api/profile/me", auth=True)
        expect_status(st, 200, "/api/profile/me", body)
        # kkr_score отдаётся только председателю, замам и мастеру HR (API 1.3).
        expect_fields(
            body,
            ["user_id", "email", "kkr_name", "group_number", "blocks",
             "banned", "super_user", "admin", "has_password"],
            "MeOut",
        )
        if "kkr_score" in body:
            assert isinstance(body["kkr_score"], (int, float)), f"kkr_score={body['kkr_score']!r}"
        assert body["user_id"] == session["user_id"], "профиль не совпадает с сессией"
        state["me"] = body
        return f"user_id={body['user_id']}, ККР {'виден' if 'kkr_score' in body else 'скрыт'}"

    if not check(rep, "GET /api/profile/me — профиль текущего пользователя", me).ok:
        return

    def blocks():
        st, body, _ = api.request("GET", "/api/blocks", auth=True)
        expect_status(st, 200, "/api/blocks", body)
        assert isinstance(body, list), "ожидался список блоков"
        if body:
            expect_fields(body[0], ["block_id", "name", "is_hr", "members", "revision", "capabilities"], "BlockOut")
            assert isinstance(body[0]["members"], list), "members должен быть списком"
        return f"блоков: {len(body)}"

    check(rep, "GET /api/blocks — список блоков", blocks)

    def contacts():
        st, body, _ = api.request("GET", "/api/contacts", auth=True)
        expect_status(st, 200, "/api/contacts", body)
        assert isinstance(body, list), "ожидался список контактов"
        return f"контактов: {len(body)}"

    check(rep, "GET /api/contacts — справочник участника", contacts)

    def guides():
        st, body, _ = api.request("GET", "/api/guides", auth=True)
        expect_status(st, 200, "/api/guides", body)
        assert isinstance(body, list), "ожидался список"
        if body:
            expect_fields(body[0], ["guide_id", "title", "owner_block", "text", "description"], "GuideOut")
            state["guide_id"] = body[0]["guide_id"]
        return f"доступно гайдов: {len(body)}"

    check(rep, "GET /api/guides — список гайдов", guides)

    def guide_one():
        gid = state.get("guide_id")
        if gid is None:
            raise SkipCheck("на сервере нет ни одного доступного гайда")
        st, body, _ = api.request("GET", f"/api/guides/{gid}", auth=True)
        expect_status(st, 200, f"/api/guides/{gid}", body)
        expect_fields(body, ["guide_id", "title", "owner_block", "text"], "GuideOut")
        return f"гайд #{gid}: {body['title']!r}"

    check(rep, "GET /api/guides/{id} — один гайд", guide_one)

    def guide_404():
        st, body, _ = api.request("GET", "/api/guides/99999999", auth=True)
        expect_status(st, 404, "несуществующий гайд", body)
        assert body.get("detail") == "Guide not found", f"detail={body.get('detail')!r}"
        return ""

    check(rep, "GET /api/guides/{id} несуществующего → 404", guide_404)

    def writing(fn):
        """Изменяющие проверки не выполняются в режиме --read-only."""
        def wrapped():
            if read_only:
                raise SkipCheck(READ_ONLY_SKIP)
            return fn()
        return wrapped

    def guides_create_forbidden():
        if "create_material" in caps:
            raise SkipCheck("учётка может создавать материалы — проверка запрета неприменима")
        st, body, _ = api.request("POST", "/api/guides", {"title": "проверка прав"}, auth=True)
        expect_status(st, 403, "создание гайда без права create_material", body)
        return "участник без права не может создавать гайды"

    check(rep, "POST /api/guides без права → 403", writing(guides_create_forbidden))

    def blocks_create_forbidden():
        if is_chair:
            raise SkipCheck("учётка председателя — проверка запрета неприменима")
        st, body, _ = api.request("POST", "/api/blocks", {"name": f"tmp{uuid.uuid4().hex[:6]}", "master": "x"}, auth=True)
        expect_status(st, 403, "создание блока не председателем", body)
        return ""

    check(rep, "POST /api/blocks не председателем → 403", writing(blocks_create_forbidden))

    def delete_other_forbidden():
        if is_chair:
            # председателю этот маршрут архивирует учётку — не вызывать
            raise SkipCheck("учётка председателя — проверка запрета неприменима")
        st, body, _ = api.request("DELETE", "/api/profile/1", auth=True)
        assert st in (403, 404), f"удаление чужого профиля вернуло {st}, ожидалось 403 или 404"
        return f"HTTP {st}"

    check(rep, "DELETE /api/profile/{id} не председателем → 403", writing(delete_other_forbidden))

    def legacy_upload_refused():
        st, body, _ = api.request(
            "POST", "/api/upload/presigned-url",
            {"folder": "guides", "content_type": "image/png"}, auth=True,
        )
        assert st in (403, 409), (
            f"устаревший presigned-url вернул {st}, ожидался отказ 409 (или 403)"
            f"\nтело ответа: {json.dumps(body, ensure_ascii=False)[:300]}"
        )
        return f"HTTP {st}: загрузка идёт через /api/files/upload-intents"

    check(rep, "POST /api/upload/presigned-url — устаревший маршрут отказывает", writing(legacy_upload_refused))

    def patch_self():
        uid = state["me"]["user_id"]
        before = state["me"].get("location") or ""
        marker = f"проверка {uuid.uuid4().hex[:6]}"
        st, body, _ = api.request("PATCH", f"/api/profile/{uid}", {"location": marker}, auth=True)
        try:
            expect_status(st, 200, f"PATCH /api/profile/{uid}", body)
            _, me2, _ = api.request("GET", "/api/profile/me", auth=True)
            assert me2.get("location") == marker, f"изменение не сохранилось: location={me2.get('location')!r}"
        finally:
            restored, _, _ = api.request("PATCH", f"/api/profile/{uid}", {"location": before}, auth=True)
        expect_status(restored, 200, "возврат прежнего location")
        _, me3, _ = api.request("GET", "/api/profile/me", auth=True)
        assert (me3.get("location") or "") == before, f"прежнее значение не вернулось: {me3.get('location')!r}"
        return "изменение сохраняется, прежнее значение возвращено"

    check(rep, "PATCH /api/profile/{id} — правка своего профиля", writing(patch_self))

    def patch_foreign():
        uid = state["me"]["user_id"]
        target = 1 if uid != 1 else 2
        st, body, _ = api.request("PATCH", f"/api/profile/{target}", {"location": "взлом"}, auth=True)
        assert st in (403, 404), f"правка чужого профиля вернула {st}, ожидалось 403 или 404"
        return f"HTTP {st}"

    check(rep, "PATCH /api/profile/{id} чужого профиля → 403", writing(patch_foreign))


def run_token_lifecycle(api: Api, rep: Report) -> None:
    print(BOLD("\n▸ Токены"))
    state: dict[str, Any] = {}

    def refresh():
        assert "refresh_token" in api.cookies, "нет cookie refresh_token — нечего обновлять"
        old = api.cookies["refresh_token"]
        st, body, _ = api.request("POST", "/api/auth/refresh")
        expect_status(st, 200, "/api/auth/refresh", body)
        expect_fields(body, ["access_token", "refresh_token"], "TokenPair")
        assert api.cookies.get("refresh_token") != old, "refresh-токен не был ротирован"
        state["rotated_old"] = old
        api.token = body["access_token"]
        return "токен обновлён и ротирован"

    check(rep, "POST /api/auth/refresh — обновление и ротация токена", refresh)

    def reuse_rotated():
        old = state.get("rotated_old")
        if not old:
            raise SkipCheck("предыдущая проверка не отработала")
        saved = api.cookies.get("refresh_token")
        api.cookies["refresh_token"] = old
        st, _, _ = api.request("POST", "/api/auth/refresh")
        if saved:
            api.cookies["refresh_token"] = saved
        expect_status(st, 401, "повторное использование старого refresh-токена")
        return "старый токен отозван, как и должно быть"

    check(rep, "POST /api/auth/refresh старым токеном → 401", reuse_rotated)

    def logout():
        st, body, _ = api.request("POST", "/api/auth/logout", auth=True)
        expect_status(st, 200, "/api/auth/logout", body)
        return ""

    check(rep, "POST /api/auth/logout — выход", logout)


def run_authenticated(api: Api, rep: Report, mode: str, read_only: bool) -> None:
    session = run_session(api, rep)
    if session is not None:
        approved = session["account_state"] == "active" and session["registration_status"] == "approved"
        if approved:
            run_approved(api, rep, session, read_only)
        else:
            run_pending(api, rep, session)
            if mode == "temp":
                rep.add(Result(
                    "Проверки одобренного участника",
                    True,
                    "временная учётка ждёт одобрения: для этих проверок передайте --email/--password",
                    skipped=True,
                ))
    run_token_lifecycle(api, rep)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Проверка живого бэкенда Профком ВМК",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--url", default=os.environ.get("PROFKOM_API", "http://127.0.0.1:8000"),
                        help="адрес сервера (по умолчанию http://127.0.0.1:8000)")
    parser.add_argument("--email", help="email существующей учётки вместо регистрации временной")
    parser.add_argument("--password", help="пароль к --email")
    parser.add_argument("--read-only", action="store_true",
                        help="не создавать и не изменять данные на сервере: только GET, "
                             "а с --email ещё вход, обновление токена и выход")
    parser.add_argument("--timeout", type=float, default=15.0, help="таймаут запроса, секунд")
    parser.add_argument("--insecure", action="store_true", help="не проверять TLS-сертификат")
    args = parser.parse_args()

    if args.email and not args.password:
        parser.error("--email указан без --password")

    api = Api(args.url, timeout=args.timeout, insecure=args.insecure)
    rep = Report()

    print(BOLD(f"\nПроверка бэкенда: {api.base}"))
    if not args.read_only and not args.email:
        print(YELLOW("  ! будет зарегистрирован временный пользователь healthcheck_*@example.com"))
        print(YELLOW("    для боевого сервера используйте --read-only или --email/--password"))

    try:
        run_public(api, rep)
        mode = run_auth(api, rep, args)
        if mode:
            run_authenticated(api, rep, mode, args.read_only)
    except ConnectionError as e:
        print(RED(f"\n  Сервер недоступен: {e}"))
        return 1

    total = len(rep.results)
    print(BOLD("\n" + "─" * 64))
    line = f"  Пройдено: {len(rep.passed)}   Провалено: {len(rep.failed)}   Пропущено: {len(rep.skipped)}   Всего: {total}"
    print(GREEN(line) if not rep.failed else RED(line))

    if rep.failed:
        print(RED("\n  Провалившиеся проверки:"))
        for r in rep.failed:
            print(RED(f"    • {r.name}"))
            for l in r.detail.splitlines():
                print(f"        {DIM(l)}")
    print()
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
