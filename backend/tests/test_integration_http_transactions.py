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
