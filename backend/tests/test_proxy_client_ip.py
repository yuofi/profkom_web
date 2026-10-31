"""Behind nginx the anonymous feedback limit counts the real client, not nginx (GL-25)."""
import re
import uuid
from pathlib import Path

from starlette.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"
NGINX_PEER = "172.19.0.3"  # the frontend container in profkom_web_default (DEPLOY.md)


def trusted_proxies():
    command = next(line for line in ENTRYPOINT.read_text().splitlines() if line.startswith("exec uvicorn"))
    assert "--proxy-headers" in command
    found = re.search(r'--forwarded-allow-ips "\$\{FORWARDED_ALLOW_IPS:-([^}"]+)\}"', command)
    assert found and "*" not in found.group(1), command
    return found.group(1)


def from_peer(app, peer):
    """The production entrypoint's middleware, reached from `peer`."""
    proxied = ProxyHeadersMiddleware(app, trusted_hosts=trusted_proxies())

    async def asgi(scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "client": (peer, 40000)}
        await proxied(scope, receive, send)
    return TestClient(asgi)


def send(site, forwarded):
    return site.post("/api/feedback", headers={"X-Forwarded-For": forwarded}, json=dict(
        kind="bug", title="Синтетический дефект", body="Шаги", idempotency_key=str(uuid.uuid4()))).status_code


def test_anonymous_feedback_limit_is_per_client_behind_nginx(client, app):
    site = from_peer(app, NGINX_PEER)
    assert [send(site, "203.0.113.7") for _ in range(10)] == [200] * 10
    # nginx appends the address it saw; a forged left part does not open a new bucket.
    assert send(site, "6.6.6.6, 203.0.113.7") == 429
    assert send(site, "198.51.100.4") == 200


def test_a_peer_outside_the_proxy_network_cannot_choose_its_address(client, app):
    direct = from_peer(app, "203.0.113.9")
    assert [send(direct, f"198.51.100.{index}") for index in range(11)] == [200] * 10 + [429]
