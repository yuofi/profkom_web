#!/usr/bin/env python3
"""
Проверка ЖИВОГО бэкенда Профком ВМК.

Отдельный процесс, не требующий pytest, venv и вообще каких-либо
зависимостей — только стандартная библиотека Python 3.9+.
Ходит по HTTP в уже запущенный сервер и проверяет, что API отвечает
так, как ожидает фронтенд.

    python3 check_live.py                          # localhost:8000
    python3 check_live.py --url https://site.ru    # боевой сервер
    python3 check_live.py --read-only              # ничего не создаёт
    python3 check_live.py --email a@b.ru --password ... --read-only

По умолчанию скрипт РЕГИСТРИРУЕТ временного пользователя, чтобы
проверить защищённые маршруты. На боевом сервере запускайте с
--read-only либо с учёткой существующего пользователя.

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

    def blocks():
        st, body, _ = api.request("GET", "/api/blocks")
        expect_status(st, 200, "/api/blocks", body)
        assert isinstance(body, list), "ожидался список блоков"
        if body:
            expect_fields(body[0], ["name", "master", "hr", "cnt_of_human", "arr_of_human"], "block")
            assert isinstance(body[0]["arr_of_human"], list), "arr_of_human должен быть списком, а не строкой"
        return f"блоков: {len(body)}"

    check(rep, "GET /api/blocks — список блоков", blocks)

    def guides_anon():
        st, body, _ = api.request("GET", "/api/guides")
        expect_status(st, 200, "/api/guides", body)
        assert isinstance(body, list), "ожидался список гайдов"
        for g in body:
            ob = (g.get("owner_block") or "").strip().lower()
            assert ob in ("", "none", "all"), (
                f"анониму виден гайд '{g.get('title')}' блока '{g.get('owner_block')}' — "
                "утечка приватного контента"
            )
        return f"публичных гайдов: {len(body)}"

    check(rep, "GET /api/guides — аноним видит только публичные", guides_anon)

    def contacts_exposure():
        st, body, _ = api.request("GET", "/api/contacts")
        if st == 200 and isinstance(body, list) and body:
            sample = body[0]
            leaked = [f for f in ("email", "phone", "vk", "tg") if sample.get(f)]
            assert False, (
                f"справочник контактов доступен БЕЗ авторизации: {len(body)} записей, "
                f"в них персональные данные {leaked}. Маршрут обязан требовать авторизацию."
            )
        if st == 200:
            return "справочник пуст, утечки нет"
        return f"маршрут закрыт (HTTP {st}) — так и должно быть"

    check(rep, "GET /api/contacts — справочник НЕ должен быть публичным", contacts_exposure)

    def unknown_path():
        st, _, _ = api.request("GET", "/api/definitely-not-a-route")
        expect_status(st, 404, "/api/definitely-not-a-route")
        return ""

    check(rep, "GET несуществующего пути → 404", unknown_path)

    def protected_without_token():
        st, body, _ = api.request("GET", "/api/profile/me")
        expect_status(st, 401, "/api/profile/me без токена", body)
        return ""

    check(rep, "GET /api/profile/me без токена → 401", protected_without_token)

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


def run_auth(api: Api, rep: Report, args) -> Optional[dict]:
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
        return {"mode": "existing"} if r.ok else None

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

    return {"mode": "temp", "creds": creds}


def run_authenticated(api: Api, rep: Report) -> None:
    if not api.token:
        return
    print(BOLD("\n▸ Защищённые маршруты"))

    state: dict[str, Any] = {}

    def me():
        st, body, _ = api.request("GET", "/api/profile/me", auth=True)
        expect_status(st, 200, "/api/profile/me", body)
        expect_fields(
            body,
            ["user_id", "email", "kkr_name", "kkr_score", "group_number", "blocks",
             "banned", "super_user", "admin", "has_password"],
            "MeOut",
        )
        state["me"] = body
        return f"user_id={body['user_id']}, admin={body['admin']}, super_user={body['super_user']}"

    if not check(rep, "GET /api/profile/me — профиль текущего пользователя", me).ok:
        return

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
        api.cookies["refresh_token"] = saved
        expect_status(st, 401, "повторное использование старого refresh-токена")
        return "старый токен отозван, как и должно быть"

    check(rep, "POST /api/auth/refresh старым токеном → 401", reuse_rotated)

    def guides_auth():
        st, body, _ = api.request("GET", "/api/guides", auth=True)
        expect_status(st, 200, "/api/guides", body)
        assert isinstance(body, list), "ожидался список"
        if body:
            expect_fields(body[0], ["guide_id", "title", "owner_block", "text", "description"], "GuideOut")
            state["guide_id"] = body[0]["guide_id"]
        return f"доступно гайдов: {len(body)}"

    check(rep, "GET /api/guides — список с авторизацией", guides_auth)

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

    is_privileged = bool(state.get("me", {}).get("super_user") or state.get("me", {}).get("admin"))

    def guides_create_forbidden():
        if is_privileged:
            raise SkipCheck("учётка привилегированная — проверка запрета неприменима")
        st, body, _ = api.request("POST", "/api/guides", {"title": "проверка прав"}, auth=True)
        expect_status(st, 403, "создание гайда обычным пользователем", body)
        return "обычный пользователь не может создавать гайды"

    check(rep, "POST /api/guides обычным пользователем → 403", guides_create_forbidden)

    def blocks_create_forbidden():
        if state.get("me", {}).get("super_user"):
            raise SkipCheck("учётка суперпользователя — проверка запрета неприменима")
        st, body, _ = api.request("POST", "/api/blocks", {"name": f"tmp{uuid.uuid4().hex[:6]}", "master": "x"}, auth=True)
        expect_status(st, 403, "создание блока без прав суперпользователя", body)
        return ""

    check(rep, "POST /api/blocks без прав → 403", blocks_create_forbidden)

    def contacts_filter_forbidden():
        if is_privileged:
            raise SkipCheck("учётка привилегированная — проверка запрета неприменима")
        st, body, _ = api.request("POST", "/api/contacts/filter", {}, auth=True)
        expect_status(st, 403, "фильтр контактов без прав администратора", body)
        assert body.get("detail") == "Admin rights required", f"detail={body.get('detail')!r}"
        return ""

    check(rep, "POST /api/contacts/filter без прав → 403", contacts_filter_forbidden)

    def delete_other_forbidden():
        if state.get("me", {}).get("super_user"):
            raise SkipCheck("учётка суперпользователя — проверка запрета неприменима")
        st, body, _ = api.request("DELETE", "/api/profile/1", auth=True)
        assert st in (403, 404), f"удаление чужого профиля вернуло {st}, ожидалось 403 или 404"
        return f"HTTP {st}"

    check(rep, "DELETE /api/profile/{id} без прав → 403", delete_other_forbidden)

    def upload_guides_forbidden():
        if is_privileged:
            raise SkipCheck("учётка привилегированная — проверка запрета неприменима")
        st, body, _ = api.request(
            "POST", "/api/upload/presigned-url",
            {"folder": "guides", "content_type": "image/png"}, auth=True,
        )
        expect_status(st, 403, "presigned-url в папку guides без прав", body)
        return ""

    check(rep, "POST /api/upload/presigned-url в 'guides' без прав → 403", upload_guides_forbidden)

    def patch_self():
        uid = state.get("me", {}).get("user_id")
        st, body, _ = api.request("PATCH", f"/api/profile/{uid}", {"location": "проверка"}, auth=True)
        expect_status(st, 200, f"PATCH /api/profile/{uid}", body)
        st2, me2, _ = api.request("GET", "/api/profile/me", auth=True)
        assert me2.get("location") == "проверка", f"изменение не сохранилось: location={me2.get('location')!r}"
        return "изменение профиля сохраняется"

    check(rep, "PATCH /api/profile/{id} — правка своего профиля", patch_self)

    def patch_foreign():
        uid = state.get("me", {}).get("user_id")
        target = 1 if uid != 1 else 2
        if is_privileged:
            raise SkipCheck("учётка привилегированная — проверка запрета неприменима")
        st, body, _ = api.request("PATCH", f"/api/profile/{target}", {"location": "взлом"}, auth=True)
        assert st in (403, 404), f"правка чужого профиля вернула {st}, ожидалось 403 или 404"
        return f"HTTP {st}"

    check(rep, "PATCH /api/profile/{id} чужого профиля → 403", patch_foreign)

    def logout():
        st, body, _ = api.request("POST", "/api/auth/logout", auth=True)
        expect_status(st, 200, "/api/auth/logout", body)
        return ""

    check(rep, "POST /api/auth/logout — выход", logout)


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
                        help="не создавать и не изменять данные на сервере")
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
        run_auth(api, rep, args)
        if not args.read_only or args.email:
            run_authenticated(api, rep)
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
