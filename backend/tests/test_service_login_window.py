"""Root login must survive an expired throttle row in the shared write UOW."""
from datetime import datetime, timezone

import pytest

import service_account
from database import db
from service_account_models import ServiceLoginThrottleORM
from test_service_account import PASSWORD, configured, sign_in  # noqa: F401


@pytest.mark.parametrize("elapsed_windows", [1, 2, 96])
@pytest.mark.parametrize("valid_password", [True, False])
def test_login_after_expired_window_preserves_its_updated_counter(
    client, configured, monkeypatch, elapsed_windows, valid_password
):
    service_account.sync()
    at = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
    window = int(at.timestamp()) // service_account.THROTTLE_WINDOW_S
    key = service_account._throttle_key("testclient")
    expired = service_account._throttle_key("synthetic-expired-peer")
    previous = service_account._throttle_key("synthetic-previous-peer")
    with db._session() as session:
        session.add_all([
            ServiceLoginThrottleORM(key=key, window=window - elapsed_windows,
                                    count=service_account.THROTTLE_LIMIT),
            ServiceLoginThrottleORM(key=expired, window=window - 3, count=2),
            ServiceLoginThrottleORM(key=previous, window=window - 1, count=3),
        ])
        session.commit()
    reserve = service_account.reserve
    monkeypatch.setattr(service_account, "reserve", lambda ip: reserve(ip, at=at))

    response = sign_in(client, password=PASSWORD if valid_password else "Synthetic-Wrong-Password")
    assert response.status_code == (200 if valid_password else 401)
    with db._session() as session:
        current = session.get(ServiceLoginThrottleORM, key)
        assert current is not None and current.window == window
        assert current.count == (0 if valid_password else 1)
        assert session.get(ServiceLoginThrottleORM, expired) is None
        recent = session.get(ServiceLoginThrottleORM, previous)
        assert recent is not None and (recent.window, recent.count) == (window - 1, 3)
