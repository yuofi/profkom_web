"""check_live.py against a disposable live_api on a temporary DB (A-TST-9, A-TST-16).

Every mode must exit 0 on a correct API 1.3 server, and --read-only must not send a
single changing request: only GET, CORS preflight and, with an account, login/refresh/logout.
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[1]
CHAIR = ("chair@example.com", "Synthetic-Local-2026")
READS = {"GET", "OPTIONS"}
SESSION_POSTS = {"POST /api/auth/login", "POST /api/auth/refresh", "POST /api/auth/logout"}


def _call(base, method, path, body=None, token=None):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    root = tmp_path_factory.mktemp("check-live")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    log = root / "requests.log"
    server = subprocess.Popen(
        [sys.executable, "tests/live_api.py", "--port", str(port),
         "--database", str(root / "db" / "site.db"), "--request-log", str(log)],
        cwd=BACKEND, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                urllib.request.urlopen(base + "/openapi.json", timeout=2).close()
                break
            except OSError:
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError(f"live_api did not start: {server.stdout.read()}")
                time.sleep(0.2)
        _, tokens = _call(base, "POST", "/api/auth/login", {"email": CHAIR[0], "password": CHAIR[1]})
        yield SimpleNamespace(url=base, log=log, chair=tokens["access_token"])
    finally:
        server.terminate()
        server.wait(timeout=10)


def _register(live, approve):
    ident = uuid.uuid4().hex[:8]
    account = dict(
        email=f"check-live-{ident}@example.com", password=f"Cl-{ident}-Pw!", surname="Проверка",
        name="Участник", patronymic="", group_number=301, tg=f"cl_{ident}", phone="+79990000000",
        vk="https://vk.com/id123", funding="budget", residence="Тест",
    )
    status, tokens = _call(live.url, "POST", "/api/auth/register", account)
    assert status == 201, tokens
    if approve:
        _, application = _call(live.url, "GET", "/api/registrations/me", token=tokens["access_token"])
        status, body = _call(
            live.url, "POST", f"/api/registrations/{application['user_id']}/approve",
            {"expected_revision": application["revision"]}, token=live.chair,
        )
        assert status == 200, body
    return account["email"], account["password"]


@pytest.fixture(scope="module")
def accounts(live):
    return {
        "chair": CHAIR,
        "participant": _register(live, approve=True),
        "pending": _register(live, approve=False),
    }


def _profile(live, credentials):
    _, tokens = _call(live.url, "POST", "/api/auth/login", {"email": credentials[0], "password": credentials[1]})
    _, me = _call(live.url, "GET", "/api/profile/me", token=tokens["access_token"])
    _call(live.url, "POST", "/api/auth/logout", token=tokens["access_token"])
    return me


def _run(live, *args):
    before = live.log.read_text().splitlines() if live.log.exists() else []
    result = subprocess.run(
        [sys.executable, "check_live.py", "--url", live.url, *args],
        cwd=BACKEND, capture_output=True, text=True, timeout=120, env={**os.environ, "NO_COLOR": "1"},
    )
    sent = live.log.read_text().splitlines()[len(before):]
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Провалено: 0" in result.stdout, result.stdout
    return result.stdout, sent


def _writes(sent):
    return [line for line in sent if line.split(" ", 1)[0] not in READS and line not in SESSION_POSTS]


def test_default_mode_checks_a_new_pending_registration(live):
    out, sent = _run(live)
    assert "GET /api/profile/me до одобрения → 403" in out
    assert "POST /api/auth/register" in sent


def test_read_only_without_account_sends_only_reads(live):
    out, sent = _run(live, "--read-only")
    assert sent and all(line.split(" ", 1)[0] in READS for line in sent), sent
    assert "GET /api/blocks без токена → 401" in out


@pytest.mark.parametrize("who", ["chair", "participant", "pending"])
def test_read_only_with_account_changes_nothing(live, accounts, who):
    before = _profile(live, accounts[who]) if who != "pending" else None
    out, sent = _run(live, "--read-only", "--email", accounts[who][0], "--password", accounts[who][1])
    assert _writes(sent) == [], sent
    if who == "pending":
        assert "GET /api/blocks до одобрения → 403" in out
        return
    assert "GET /api/profile/me — профиль текущего пользователя" in out
    assert out.count("режим --read-only") >= 6, out
    assert _profile(live, accounts[who]) == before


@pytest.mark.parametrize("who", ["chair", "participant"])
def test_full_mode_with_account_restores_own_profile(live, accounts, who):
    before = _profile(live, accounts[who])
    out, sent = _run(live, "--email", accounts[who][0], "--password", accounts[who][1])
    assert "режим --read-only" not in out
    assert f"PATCH /api/profile/{before['user_id']}" in sent
    after = _profile(live, accounts[who])
    assert (after.get("location") or "") == (before.get("location") or "")
    assert {k: v for k, v in after.items() if k != "location"} == {k: v for k, v in before.items() if k != "location"}
    if who == "chair":
        # the chair's DELETE /api/profile/{id} archives an account, so it is never sent
        assert not any(line.startswith("DELETE ") for line in sent), sent
