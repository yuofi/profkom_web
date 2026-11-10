"""Synthetic provider/storage only, including SSRF, races and short transactions."""
import io
import socket
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from database import db, engine, FileRecordORM, _active_session
from domain_models import ProfileMetadataORM, ObjectDeletionORM
from directory import avatar_url
import vk_avatar

real_download = vk_avatar.download
real_storage_client = vk_avatar.storage_client
IMAGE = b"\xff\xd8\xffsynthetic\xff\xd9"
URL = "https://sun9.userapi.com/synthetic.jpg?signature=never-log-me"


def linked(make_user):
    user = make_user()
    db.link_external_identity(user.user_id, "vk:777")
    return user


@pytest.mark.parametrize("url", [
    "http://sun9.userapi.com/x", "https://userapi.com.evil.test/x", "https://localhost/x",
    "https://127.0.0.1/x", "https://169.254.169.254/x", "https://[::1]/x",
    "https://evil.test@vk.com/x", "https://vk.com:8443/x", "https://vk.com/x#secret",
    "https://vk.com\\@evil.test/x", "https://vk.com/\nfoo", None, {},
])
def test_refuses_unsafe_urls_before_io(url, make_user, mock_s3):
    user = linked(make_user)
    vk_avatar.import_avatar(user.user_id, "vk:777", url)
    assert not mock_s3['upload'] and not mock_s3['objects']


@pytest.mark.parametrize("kind", ["preset", "file", "legacy"])
def test_preserves_chosen_avatar(kind, make_user, mock_s3):
    user = linked(make_user)
    with db.atomic(), db._session() as s:
        if kind == "legacy":
            db.update_user(user.user_id, photo_url="https://cdn.test/old.jpg")
        else:
            s.add(ProfileMetadataORM(user_id=user.user_id, preset_id="default" if kind == "preset" else None,
                                     avatar_file_id="chosen" if kind == "file" else None))
    vk_avatar.import_avatar(user.user_id, "vk:777", URL)
    assert not mock_s3['upload'] and not mock_s3['objects']


def test_login_commits_before_io_and_import_is_idempotent(client, mock_vk, mock_s3, monkeypatch, make_user):
    user = linked(make_user)
    mock_vk(user_id="777", avatar=URL)
    with engine.connect() as connection:
        previous_tokens = connection.execute(text("select count(*) from refresh_tokens where user_id=:id"), {"id": user.user_id}).scalar()
    def download(url):
        assert _active_session.get() is None
        with engine.connect() as connection:
            connection.execute(text("BEGIN IMMEDIATE"))
            assert connection.execute(text("select count(*) from refresh_tokens where user_id=:id"), {"id": user.user_id}).scalar() == previous_tokens + 1
            connection.rollback()
        return IMAGE, "image/jpeg"
    monkeypatch.setattr(vk_avatar, "download", download)
    from utils.s3_service import s3_client
    put = s3_client.put_object
    def store(**kwargs):
        assert _active_session.get() is None
        assert kwargs['IfNoneMatch'] == '*'
        return put(**kwargs)
    monkeypatch.setattr(s3_client, 'put_object', store)
    assert client.post('/api/auth/vk', json={'access_token':'synthetic'}).status_code == 200
    url = avatar_url(user.user_id)
    assert url.startswith('/api/files/')
    response = client.get(url, headers=user.headers)
    assert response.status_code == 200 and response.content == IMAGE
    monkeypatch.setattr(vk_avatar, "download", lambda url: pytest.fail("Repeated import"))
    assert client.post('/api/auth/vk', json={'access_token':'synthetic'}).status_code == 200
    assert avatar_url(user.user_id) == url and len(mock_s3['objects']) == 1


@pytest.mark.parametrize("phase", ["download", "validation", "storage"])
@pytest.mark.parametrize("failure", [TimeoutError, ValueError])
def test_provider_storage_failure_does_not_fail_login_or_leak_secrets(phase, failure, client, mock_vk, monkeypatch, caplog):
    mock_vk(user_id="777", avatar=URL)
    def fail(*args, **kwargs):
        raise failure("never-log-me storage-secret")
    if phase == "download":
        monkeypatch.setattr(vk_avatar, "download", fail)
    elif phase == "validation":
        monkeypatch.setattr(vk_avatar, "validate_image", fail)
    else:
        monkeypatch.setattr(vk_avatar, "storage_client", lambda: SimpleNamespace(put_object=fail))
    response = client.post('/api/auth/vk', json={'access_token':'synthetic'})
    assert response.status_code == 200 and response.json()['access_token']
    assert "never-log-me" not in response.text and "storage-secret" not in response.text
    assert "never-log-me" not in caplog.text and "storage-secret" not in caplog.text
    with db._session() as s:
        assert s.query(FileRecordORM).count() == 0
        if phase == "storage":
            assert s.query(ObjectDeletionORM).count() == 2


def test_manual_selection_during_storage_wins_and_import_is_retired(make_user, mock_s3, monkeypatch):
    user = linked(make_user)
    from utils.s3_service import s3_client
    put = s3_client.put_object
    def choose_avatar(**kwargs):
        result = put(**kwargs)
        with db.atomic(), db._session() as s:
            s.add(ProfileMetadataORM(user_id=user.user_id, preset_id="moon"))
        return result
    monkeypatch.setattr(s3_client, "put_object", choose_avatar)
    vk_avatar.import_avatar(user.user_id, "vk:777", URL)
    assert avatar_url(user.user_id) == '/avatars/moon.svg'
    with db._session() as s:
        assert s.query(FileRecordORM).count() == 0
        assert s.query(ObjectDeletionORM).count() == 2


def test_identity_revoked_during_download_does_not_attach_photo(make_user, mock_s3, monkeypatch):
    user = linked(make_user)
    def revoke(url):
        from database import ExternalIdentityORM
        with db.atomic(), db._session() as s:
            s.delete(s.get(ExternalIdentityORM, 'vk:777'))
        return IMAGE, 'image/jpeg'
    monkeypatch.setattr(vk_avatar, 'download', revoke)
    vk_avatar.import_avatar(user.user_id, 'vk:777', URL)
    assert not mock_s3['objects']


def test_concurrent_imports_are_bounded_and_same_user_is_deduplicated(make_user, mock_s3):
    user = linked(make_user)
    for inflight in ({user.user_id}, {100001,100002}):
        vk_avatar._inflight.update(inflight)
        try:
            vk_avatar.import_avatar(user.user_id, 'vk:777', URL)
        finally:
            vk_avatar._inflight.clear()
    assert not mock_s3['upload']


@pytest.mark.parametrize('address', ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fc00::1'])
def test_cdn_dns_must_be_public(address, monkeypatch):
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address,443))])
    with pytest.raises(ValueError, match='Non-public'):
        real_download(URL)


def fake_download(monkeypatch, data=IMAGE, status=200, mime='image/jpeg', length=None):
    requests = []
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8',443))])
    monkeypatch.setattr(socket, 'create_connection', lambda target, timeout, source: requests.append(('connect', target, timeout)))
    class Response:
        def __init__(self):
            self.status = status
            self.body = io.BytesIO(data)
            self.fp = SimpleNamespace(raw=SimpleNamespace(_sock=SimpleNamespace(settimeout=lambda value: None)))
        def getheader(self, name, default=None):
            return {'Content-Type': mime, 'Content-Length': str(len(data) if length is None else length)}.get(name, default)
        def isclosed(self): return False
        def read1(self, amount): return self.body.read(amount)
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Connection:
        def __init__(self, host, timeout): requests.append(('tls', host, timeout))
        def request(self, method, path, headers):
            self._create_connection(('host-should-not-be-resolved-again',443), 2)
            requests.append(('request', method, path))
        def getresponse(self): return Response()
        def close(self): requests.append(('closed',))
    monkeypatch.setattr(vk_avatar.http.client, 'HTTPSConnection', Connection)
    return requests


def test_download_pins_public_ip_retains_tls_hostname_and_signed_query(monkeypatch):
    calls = fake_download(monkeypatch)
    assert real_download(URL) == (IMAGE, 'image/jpeg')
    assert ('tls', 'sun9.userapi.com', 2) in calls
    assert ('connect', ('8.8.8.8',443), 2) in calls
    assert ('request', 'GET', '/synthetic.jpg?signature=never-log-me') in calls
    assert calls[-1] == ('closed',)


@pytest.mark.parametrize('options', [
    {'status':302}, {'mime':'text/html'}, {'data':b'<html>no</html>'},
    {'length':vk_avatar.MAX_BYTES+1}, {'length':500}, {'data':b'\xff\xd8\xfftruncated'},
])
def test_download_rejects_redirects_invalid_bytes_and_size(monkeypatch, options):
    calls = fake_download(monkeypatch, **options)
    with pytest.raises(ValueError): real_download(URL)
    assert calls[-1] == ('closed',)


def test_download_total_deadline(monkeypatch):
    fake_download(monkeypatch)
    ticks = iter([0, 6])
    monkeypatch.setattr(vk_avatar.time, 'monotonic', lambda: next(ticks))
    with pytest.raises(TimeoutError): real_download(URL)


def test_storage_has_short_timeouts_without_retries(monkeypatch):
    import boto3
    calls = []
    monkeypatch.setattr(boto3, 'client', lambda *args, **kwargs: calls.append(kwargs) or object())
    real_storage_client.cache_clear()
    try:
        real_storage_client()
        config = calls[0]['config']
        assert (config.connect_timeout, config.read_timeout) == (2, 3)
        assert config.retries == {'total_max_attempts': 1}
    finally:
        real_storage_client.cache_clear()


def test_interrupted_expired_import_is_retired_on_next_login(make_user, mock_s3):
    user = linked(make_user)
    with db.atomic(), db._session() as s:
        s.add(FileRecordORM(file_id='vk-avatar-expired', owner_kind='avatar', owner_id=str(user.user_id), purpose='avatar',
            name='vk-avatar.jpg', mime_type='image/jpeg', size_bytes=12, uploaded_by_user_id=user.user_id,
            state='pending', created_at='2020-01-01T00:00:00+00:00', expires_at='2020-01-01T01:00:00+00:00'))
    vk_avatar.import_avatar(user.user_id, 'vk:777', URL)
    with db._session() as s:
        assert s.get(FileRecordORM, 'vk-avatar-expired') is None
        assert s.get(ObjectDeletionORM, 'sealed/vk-avatar-expired') is not None
        assert s.query(FileRecordORM).filter_by(state='completed').count() == 1
