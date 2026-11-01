"""frontend/nginx.conf with the backend: X-Accel-Redirect serves a file's bytes (АВ-9).

Runs only where an nginx binary is available (NGINX_BIN or nginx on PATH). The storage is
a local HTTP server that checks its own signatures and answers with hostile headers.
Everything listens on 127.0.0.1; nothing leaves the machine.
"""

import hashlib
import hmac
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

import httpx
import pytest

from database import db, FileRecordORM
from file_access import disposition

NGINX = os.environ.get("NGINX_BIN") or shutil.which("nginx")
pytestmark = pytest.mark.skipif(not NGINX, reason="nginx is not installed")
CONF = Path(__file__).resolve().parents[2] / "frontend/nginx.conf"
PDF = b"%PDF-1.7 synthetic bytes"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(port):
    for _ in range(200):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.05)
    raise RuntimeError(f"Nothing listens on {port}")


class Storage:
    """Signed GETs of the mock_s3 objects; records what nginx sent."""

    def __init__(self, objects):
        self.objects, self.secret, self.requests, self.refuse = objects, os.urandom(16), [], False
        storage = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                key = unquote(url.path.lstrip("/"))
                query = parse_qs(url.query)
                storage.requests.append(dict(path=url.path, key=key, headers=dict(self.headers)))
                good = hmac.compare_digest(query.get("signature", [""])[0], storage.sign(key, query.get("expires", ["0"])[0]))
                if storage.refuse or not good or int(query["expires"][0]) < time.time() or key not in storage.objects:
                    self.send_response(403)
                    self.send_header("Content-Type", "application/xml")
                    self.end_headers()
                    self.wfile.write(b"<Error><Code>AccessDenied</Code><Key>" + key.encode() + b"</Key></Error>")
                    return
                data = storage.objects[key][0]
                start, end = 0, len(data) - 1
                ranged = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range", ""))
                if ranged:
                    start, end = int(ranged[1]), min(int(ranged[2]), end)
                self.send_response(206 if ranged else 200)
                # Whatever an object claims must not reach the browser.
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Disposition", "inline; filename=evil.html")
                self.send_header("Cache-Control", "public, max-age=31536000")
                self.send_header("Set-Cookie", "storage=1")
                self.send_header("x-amz-request-id", "synthetic")
                # What the production storage (s3.cloud.ru) adds to every object, seen on the
                # test site on 2026-10-25.
                self.send_header("x-amz-storage-class", "STANDARD")
                self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
                self.send_header("Content-Length", str(end - start + 1))
                if ranged:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                self.end_headers()
                self.wfile.write(data[start : end + 1])

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def sign(self, key, expires):
        return hmac.new(self.secret, f"{key}:{expires}".encode(), hashlib.sha256).hexdigest()

    def presign(self, operation, Params, ExpiresIn):
        expires = str(int(time.time()) + ExpiresIn)
        key = Params["Key"]
        return (f"http://127.0.0.1:{self.port}/{quote(key, safe='/')}"
                f"?expires={expires}&signature={self.sign(key, expires)}")


def nginx_conf(backend_port, port, html, ca, extra):
    server = CONF.read_text()
    for old, new in (
        ("listen  443 ssl;", f"listen 127.0.0.1:{port};"),
        ("    ssl_certificate /etc/nginx/ssl/fullchain.pem;\n", ""),
        ("    ssl_certificate_key /etc/nginx/ssl/privkey.pem;\n", ""),
        ("http://backend:8000/api/", f"http://127.0.0.1:{backend_port}/api/"),
        ("/usr/share/nginx/html", str(html)),
        ("/etc/ssl/certs/ca-certificates.crt", ca),
        ("/etc/nginx/extra/*.conf", f"{extra}/*.conf"),
    ):
        assert old in server, old
        server = server.replace(old, new)
    temp = "".join(f"    {name}_temp_path temp/{name};\n" for name in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi"))
    return (f"pid nginx.pid;\nerror_log error.log warn;\nevents {{}}\nhttp {{\n    access_log off;\n{temp}"
            f"{server}\n}}\n")


@pytest.fixture
def site(mock_s3, monkeypatch, tmp_path):
    import certifi
    import uvicorn
    import main
    from utils.s3_service import s3_client

    storage = Storage(mock_s3["objects"])
    monkeypatch.setattr(s3_client, "generate_presigned_url", storage.presign)
    backend_port, port = free_port(), free_port()
    api = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=backend_port, log_level="warning"))
    threading.Thread(target=api.run, daemon=True).start()
    wait_for(backend_port)
    (tmp_path / "temp").mkdir()
    (tmp_path / "html").mkdir()
    (tmp_path / "html/index.html").write_text("<p>SPA</p>")
    # A server-local block, like the routes of another service on the production host.
    (tmp_path / "extra").mkdir()
    (tmp_path / "extra/other-service.conf").write_text("location = /other-service { return 204; }\n")
    (tmp_path / "nginx.conf").write_text(
        nginx_conf(backend_port, port, tmp_path / "html", certifi.where(), tmp_path / "extra"))
    nginx = subprocess.Popen([NGINX, "-p", str(tmp_path), "-c", "nginx.conf", "-g", "daemon off;"],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        wait_for(port)
        yield dict(url=f"http://127.0.0.1:{port}", storage=storage)
    finally:
        nginx.terminate()
        nginx.wait(10)
        api.should_exit = True
        storage.server.shutdown()


def upload(client, actor, mock_s3, name):
    intent = client.post("/api/files/upload-intents", headers=actor.headers, json=dict(
        owner_kind="pgas", purpose="pgas", name="a.pdf", mime_type="application/pdf", size_bytes=len(PDF)))
    fid = intent.json()["file_id"]
    mock_s3["objects"]["private/" + fid] = (PDF, "application/pdf")
    assert client.post(f"/api/files/{fid}/complete", headers=actor.headers, json={}).status_code == 200
    with db._session() as s:
        s.get(FileRecordORM, fid).name = name
        s.commit()
        return fid, disposition(s.get(FileRecordORM, fid))


def test_nginx_serves_the_checked_bytes_with_the_backend_headers(client, site, pgas_admin, user, mock_s3):
    fid, expected = upload(client, pgas_admin, mock_s3, "Заявление на ПГАС.pdf")
    url = f"{site['url']}/api/files/{fid}/content"
    r = httpx.get(url, cookies={"access_token": user.access_token})
    assert r.status_code == 200 and r.content == PDF
    assert r.headers.get_list("content-type") == ["application/pdf"]
    assert r.headers.get_list("content-disposition") == [expected]
    assert r.headers.get_list("cache-control") == ["private, no-cache"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-security-policy"] == "sandbox"
    for leaked in ("x-storage-url", "x-accel-redirect", "x-amz-request-id", "x-amz-storage-class",
                   "strict-transport-security", "set-cookie"):
        assert leaked not in r.headers, leaked
    # The storage got the signed GET only: nothing of the visitor.
    [seen] = site["storage"].requests
    assert seen["path"] == f"/sealed/{fid}"
    assert not {"Cookie", "Authorization"} & set(seen["headers"])
    # The bearer header works too, and a range reaches the storage.
    part = httpx.get(url, headers={**user.headers, "Range": "bytes=0-3"})
    assert part.status_code == 206 and part.content == PDF[:4]
    assert "Authorization" not in site["storage"].requests[-1]["headers"]


def test_nginx_keeps_the_signed_form_of_an_old_key(client, site, user, mock_s3):
    """An adopted old upload keeps a key with Cyrillic and spaces (АВ-10): nginx must pass
    the percent-encoded path it was signed for, not decode it."""
    key = "pgas/Заявление на ПГАС.pdf"
    mock_s3["objects"][key] = (PDF, "application/pdf")
    with db._session() as s:
        s.add(FileRecordORM(file_id="file-adopted", owner_kind="pgas", owner_id=None, purpose="pgas",
                            name="Заявление на ПГАС.pdf", mime_type="application/pdf", size_bytes=0,
                            uploaded_by_user_id=0, state="completed", created_at="", expires_at="",
                            storage_key=key))
        s.commit()
    r = httpx.get(f"{site['url']}/api/files/file-adopted/content", headers=user.headers)
    assert r.status_code == 200 and r.content == PDF
    [seen] = site["storage"].requests
    assert seen["path"] == "/" + quote(key, safe="/") and seen["key"] == key


def test_nginx_gives_nothing_without_access(client, site, pgas_admin, mock_s3):
    fid, _ = upload(client, pgas_admin, mock_s3, "a.pdf")
    url = f"{site['url']}/api/files/{fid}/content"
    assert httpx.get(url).status_code == 401
    assert httpx.get(f"{site['url']}/api/files/file-missing/content", headers=pgas_admin.headers).status_code == 404
    # The internal location cannot be asked for directly: its 404 goes through the
    # same error_page as a storage refusal.
    direct = httpx.get(f"{site['url']}/_storage", headers={"X-Storage-Url": f"http://127.0.0.1:{site['storage'].port}/sealed/{fid}"})
    assert direct.status_code == 502 and direct.content != PDF
    assert site["storage"].requests == []
    # A refusal of the storage is a plain 502, without its answer.
    site["storage"].refuse = True
    failed = httpx.get(url, headers=pgas_admin.headers)
    assert failed.status_code == 502 and b"AccessDenied" not in failed.content and fid.encode() not in failed.content


def test_nginx_serves_server_local_blocks_next_to_the_site(site):
    """Routes of other services on the host (a VPN on the production server) are kept in
    ./nginx-extra outside git and survive a deployment of a new nginx.conf."""
    assert httpx.get(f"{site['url']}/other-service").status_code == 204
    spa = httpx.get(f"{site['url']}/some/page")
    assert spa.status_code == 200 and spa.text == "<p>SPA</p>"


@pytest.mark.parametrize("folder", ["empty", "missing"])
def test_nginx_starts_without_server_local_blocks(tmp_path, folder):
    import certifi

    (tmp_path / "temp").mkdir()
    if folder == "empty":
        (tmp_path / "extra").mkdir()
    (tmp_path / "nginx.conf").write_text(
        nginx_conf(free_port(), free_port(), tmp_path / "html", certifi.where(), tmp_path / "extra"))
    out = subprocess.run([NGINX, "-t", "-p", str(tmp_path), "-c", "nginx.conf"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr


def test_nginx_lets_a_full_feedback_screenshot_through_and_keeps_the_api_limit(site):
    """A PNG of 2 MiB is about 2.8 MB of base64 inside the feedback JSON (GL-15)."""
    screenshot = '{"kind": "bug", "screenshot": "data:image/png;base64,' + "A" * 2_790_000 + '"}'
    reached = httpx.post(f"{site['url']}/api/feedback", content=screenshot, headers={"content-type": "application/json"})
    assert reached.status_code == 422  # the backend itself validated it
    refused = httpx.post(f"{site['url']}/api/feedback", content=b"x" * 4_300_000, headers={"content-type": "application/json"})
    assert refused.status_code == 413
    other = httpx.post(f"{site['url']}/api/tasks", content=b"x" * 1_300_000, headers={"content-type": "application/json"})
    assert other.status_code == 413


# About 4 kB of task-list JSON: well over gzip_min_length.
API_JSON = ('{"items": [' + ", ".join(f'{{"task_id": "task-{n}", "title": "Задача {n}", "status": "open"}}'
                                     for n in range(60)) + "]}").encode()


class Upstream:
    """A backend stand-in for the nginx rules alone: every answer is API_JSON (typed text/csv
    under *.csv); records the path and the headers nginx sent."""

    def __init__(self):
        self.requests = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                upstream.requests.append(dict(path=self.path, headers=dict(self.headers)))
                self.send_response(200)
                self.send_header("Content-Type", "text/csv" if self.path.endswith(".csv") else "application/json")
                self.send_header("Content-Length", str(len(API_JSON)))
                self.end_headers()
                self.wfile.write(API_JSON)

            do_GET = do_POST = answer

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def test_nginx_compresses_api_json_but_never_tokens_or_files(tmp_path):
    """PF-12: a JSON answer of /api/ goes gzipped; token answers (/api/auth/, BREACH), file
    bytes (/api/files/) and other types go as they are. The nested locations keep the proxy
    headers of /api/: nginx inherits proxy_set_header only into a level that sets none."""
    import certifi

    upstream = Upstream()
    for name in ("temp", "html", "extra"):
        (tmp_path / name).mkdir()
    port = free_port()
    (tmp_path / "nginx.conf").write_text(
        nginx_conf(upstream.port, port, tmp_path / "html", certifi.where(), tmp_path / "extra"))
    nginx = subprocess.Popen([NGINX, "-p", str(tmp_path), "-c", "nginx.conf", "-g", "daemon off;"],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        wait_for(port)
        gz = {"Accept-Encoding": "gzip"}
        compressed = [("GET", "/api/tasks?limit=20"), ("GET", "/api/session"), ("POST", "/api/feedback")]
        plain = [("POST", "/api/auth/login"), ("POST", "/api/auth/refresh"), ("POST", "/api/files/upload-intents"),
                 ("GET", "/api/files/file-1/content"), ("GET", "/api/reports/export.csv")]
        for method, path in compressed:
            r = httpx.request(method, f"http://127.0.0.1:{port}{path}", headers=gz, content=b"{}" if method == "POST" else None)
            assert r.headers.get("content-encoding") == "gzip" and r.headers.get("vary") == "Accept-Encoding", path
            assert r.content == API_JSON and r.num_bytes_downloaded < len(API_JSON) / 4, path
        for method, path in plain:
            r = httpx.request(method, f"http://127.0.0.1:{port}{path}", headers=gz, content=b"{}" if method == "POST" else None)
            assert "content-encoding" not in r.headers and r.headers["content-length"] == str(len(API_JSON)), path
            assert r.content == API_JSON and r.num_bytes_downloaded == len(API_JSON), path
        # A client that does not take gzip gets the JSON as it is.
        r = httpx.get(f"http://127.0.0.1:{port}/api/tasks", headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in r.headers and r.content == API_JSON
        assert [seen["path"] for seen in upstream.requests] == [path for _, path in compressed + plain] + ["/api/tasks"]
        for seen in upstream.requests:
            headers = seen["headers"]
            assert headers["Host"] == "127.0.0.1" and headers["X-Real-IP"] == "127.0.0.1", seen["path"]
            assert headers["X-Forwarded-For"] == "127.0.0.1" and headers["X-File-Delivery"] == "accel", seen["path"]
    finally:
        nginx.terminate()
        nginx.wait(10)
        upstream.server.shutdown()


def test_nginx_never_compresses_file_bytes(client, site, user, superuser, mock_s3):
    """PF-12: a stored JSON file keeps its bytes, length and ranges on the X-Accel-Redirect
    path, while the API's own JSON answers are compressed."""
    key = "pgas/data.json"
    mock_s3["objects"][key] = (API_JSON, "application/json")
    with db._session() as s:
        s.add(FileRecordORM(file_id="file-json", owner_kind="pgas", owner_id=None, purpose="pgas",
                            name="data.json", mime_type="application/json", size_bytes=len(API_JSON),
                            uploaded_by_user_id=0, state="completed", created_at="", expires_at="",
                            storage_key=key))
        s.commit()
    gz = {**user.headers, "Accept-Encoding": "gzip"}
    url = f"{site['url']}/api/files/file-json/content"
    r = httpx.get(url, headers=gz)
    assert r.status_code == 200 and r.headers["content-type"] == "application/json"
    assert "content-encoding" not in r.headers and r.headers["content-length"] == str(len(API_JSON))
    assert r.content == API_JSON and r.num_bytes_downloaded == len(API_JSON)
    part = httpx.get(url, headers={**gz, "Range": "bytes=0-9"})
    assert part.status_code == 206 and part.content == API_JSON[:10] and "content-encoding" not in part.headers
    assert [seen["key"] for seen in site["storage"].requests] == [key, key]
    # The real backend's own JSON goes compressed through the same nginx (the chair's session
    # with its capabilities is over gzip_min_length).
    session = httpx.get(f"{site['url']}/api/session", headers={**superuser.headers, "Accept-Encoding": "gzip"})
    assert session.status_code == 200 and session.headers.get("content-encoding") == "gzip"
    assert session.json()["user_id"] == superuser.user_id
