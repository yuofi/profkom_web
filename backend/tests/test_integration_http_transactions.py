"""Overlapping real HTTP writers must allow the first transaction to finish."""
import asyncio
import threading
import time

import httpx
from sqlalchemy.orm import Session
import main


def test_overlapping_logins_do_not_block_transaction_exit(monkeypatch, superuser):
    entered = threading.Event()
    verify = main.verify_password
    execute = Session.execute

    def pause_first(password, hashed):
        if not entered.is_set():
            entered.set()
            time.sleep(0.05)
        return verify(password, hashed)

    def bounded_begin(session, statement, *args, **kwargs):
        if str(statement) == "BEGIN IMMEDIATE":
            execute(session, main.database_module.text("PRAGMA busy_timeout=500"))
        return execute(session, statement, *args, **kwargs)

    monkeypatch.setattr(main, 'verify_password', pause_first)
    monkeypatch.setattr(Session, 'execute', bounded_begin)

    async def requests():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url='http://test') as client:
            payload = dict(email=superuser.email, password=superuser.password)
            first = asyncio.create_task(client.post('/api/auth/login', json=payload))
            for _ in range(1000):
                if entered.is_set():
                    break
                await asyncio.sleep(0.001)
            assert entered.is_set()
            second = asyncio.create_task(client.post('/api/auth/login', json=payload))
            return await asyncio.gather(first, second)

    responses = asyncio.run(requests())
    assert [r.status_code for r in responses] == [200, 200]


def test_more_readers_than_pooled_connections_all_finish(monkeypatch, superuser):
    """A burst larger than the connection pool queues instead of stalling the loop.

    Each request holds one pooled connection for its unit of work. Checking one out
    on the event loop while the pool is empty blocked the loop that the holders need
    to commit and give theirs back: the whole server stopped for the pool timeout."""
    import access
    from database import engine

    monkeypatch.setattr(engine.pool, "_timeout", 2)
    capacity = engine.pool.size() + engine.pool._max_overflow
    revision = access.scope_access_revision

    def slow(uid):
        time.sleep(0.05)
        return revision(uid)

    monkeypatch.setattr(access, "scope_access_revision", slow)

    async def burst():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url='http://test') as client:
            # The first read seeds the registration row, as the v1.3 migration does for all accounts.
            assert (await client.get('/api/session', headers=superuser.headers)).status_code == 200
            return await asyncio.gather(*(client.get('/api/session', headers=superuser.headers) for _ in range(3 * capacity)))

    started = time.monotonic()
    responses = asyncio.run(burst())
    assert [r.status_code for r in responses] == [200] * (3 * capacity)
    assert time.monotonic() - started < 2


def asgi_client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url='http://test')


def test_parallel_refreshes_of_one_cookie_keep_it_for_the_winner(client, superuser):
    """A-ROL-14: tabs of one browser refresh together. One rotates the pair; the others get
    401 without a Set-Cookie deleting refresh_token, so the winner's new cookie stays."""
    login = client.post('/api/auth/login', json=dict(email=superuser.email, password=superuser.password))
    old = login.json()['refresh_token']
    client.cookies.clear()

    async def refreshes():
        async with asgi_client() as c:
            return await asyncio.gather(*(c.post('/api/auth/refresh', headers={'Cookie': f'refresh_token={old}'}) for _ in range(3)))

    responses = asyncio.run(refreshes())
    assert sorted(r.status_code for r in responses) == [200, 401, 401]
    for r in responses:
        cookies = r.headers.get_list('set-cookie')
        if r.status_code == 200:
            assert any(c.startswith('refresh_token=') and 'Max-Age=0' not in c for c in cookies)
        else:
            assert not any(c.startswith('refresh_token=') for c in cookies), cookies
    # A replay of the rotated token is still refused.
    assert client.post('/api/auth/refresh', headers={'Cookie': f'refresh_token={old}'}).status_code == 401


def test_expired_refresh_token_still_clears_the_cookie(client, superuser):
    from datetime import datetime, timedelta, timezone
    from database import db

    token = 'expired-' + superuser.email
    db.save_refresh_token(token, superuser.user_id, datetime.now(timezone.utc) - timedelta(seconds=1))
    client.cookies.clear()
    r = client.post('/api/auth/refresh', headers={'Cookie': f'refresh_token={token}'})
    assert r.status_code == 401
    assert any(c.startswith('refresh_token=') for c in r.headers.get_list('set-cookie'))


def test_slow_vk_and_password_checks_do_not_hold_other_writers(monkeypatch, superuser, user):
    """A-ROL-15: the VK answer and bcrypt are waited for outside the shared write lock."""
    import vk_auth

    started = threading.Event()
    verify = main.verify_password

    def slow_vk(token):
        started.set()
        time.sleep(1)
        return {"subject": "vk:90901", "vk_id": "90901", "first_name": "Медленный", "last_name": "VK"}

    def slow_password(password, hashed):
        started.set()
        time.sleep(1)
        return verify(password, hashed)

    monkeypatch.setattr(vk_auth, 'verified_identity', slow_vk)
    monkeypatch.setattr(main, 'verify_password', slow_password)

    async def scenario(path, payload):
        started.clear()
        async with asgi_client() as c:
            assert (await c.get('/api/session', headers=user.headers)).status_code == 200
            slow = asyncio.create_task(c.post(path, json=payload))
            while not started.is_set():
                await asyncio.sleep(0.005)
            began = time.monotonic()
            write = await c.post('/api/notifications/read-all', headers=user.headers)
            return write.status_code, time.monotonic() - began, (await slow).status_code

    for path, payload in [('/api/auth/vk', {'access_token': 'slow'}),
                          ('/api/auth/login', dict(email=superuser.email, password=superuser.password))]:
        status, waited, slow_status = asyncio.run(scenario(path, payload))
        assert status == 200 and waited < 0.5, (path, waited)
        assert slow_status == 200, path
