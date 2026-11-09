"""Best-effort VK ID avatar import after login, outside the authentication transaction.

Only a verified provider response supplies the URL. The bounded download pins a
public CDN address while TLS still verifies its hostname; redirects are refused.
Completed bytes use the ordinary private, immutable avatar file contract.
"""

from datetime import datetime, timedelta, timezone
from functools import lru_cache
import hashlib
import http.client
import ipaddress
import logging
import socket
import threading
import time
from urllib.parse import urlsplit
import uuid

from database import db, ExternalIdentityORM, FileRecordORM, UserORM
from domain_models import ProfileMetadataORM

MAX_BYTES = 3 * 1024 * 1024
DOWNLOAD_SECONDS = 5
CDN_DOMAINS = ("userapi.com", "vkuserphoto.ru", "vk-cdn.net", "vkuser.net", "vk.com", "vk.ru")
_guard = threading.Lock()
_inflight: set[int] = set()
logger = logging.getLogger(__name__)


def avatar_url(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    if any(ord(c) < 33 or ord(c) > 126 for c in value) or "\\" in value:
        return None
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower()
        if (url.scheme != "https" or url.username or url.password or url.port not in (None, 443)
                or url.fragment or not any(host == domain or host.endswith("." + domain) for domain in CDN_DOMAINS)):
            return None
    except ValueError:
        return None
    return url


def download(value):
    url = avatar_url(value)
    if not url:
        raise ValueError("Invalid avatar address")
    addresses = socket.getaddrinfo(url.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("Non-public avatar address")
    # Never resolve the hostname a second time: this also rejects DNS rebinding.
    address = addresses[0][4][0]
    connection = http.client.HTTPSConnection(url.hostname, timeout=2)
    connection._create_connection = lambda _addr, timeout, source_address=None: socket.create_connection(
        (address, 443), timeout, source_address)
    deadline = time.monotonic() + DOWNLOAD_SECONDS
    try:
        path = url.path or "/"
        if url.query:
            path += "?" + url.query  # Keep provider signatures; never log this URL.
        connection.request("GET", path, headers={"Accept": "image/jpeg,image/png,image/webp", "Accept-Encoding": "identity"})
        with connection.getresponse() as response:
            if response.status != 200 or response.getheader("Content-Encoding", "identity") != "identity":
                raise ValueError("Avatar response refused")
            mime = response.getheader("Content-Type", "").split(";")[0].strip().lower()
            if mime not in ("image/jpeg", "image/png", "image/webp"):
                raise ValueError("Invalid avatar type")
            length = response.getheader("Content-Length")
            if length is not None and not 0 < int(length) <= MAX_BYTES:
                raise ValueError("Avatar too large")
            chunks, size = [], 0
            while True:
                if response.isclosed():
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Avatar download expired")
                # The HTTP response may own the socket after Connection: close.
                response.fp.raw._sock.settimeout(min(2, remaining))
                chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("Avatar too large")
                chunks.append(chunk)
            data = b"".join(chunks)
            if length is not None and len(data) != int(length):
                raise ValueError("Incomplete avatar")
            validate_image(data, mime)
            return data, mime
    finally:
        connection.close()


def validate_image(data, mime):
    signatures = {
        "image/jpeg": data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n") and data.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"),
        "image/webp": len(data) >= 20 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
                      and int.from_bytes(data[4:8], "little") + 8 == len(data),
    }
    if not 0 < len(data) <= MAX_BYTES or not signatures.get(mime):
        raise ValueError("Invalid avatar bytes")


@lru_cache(maxsize=1)
def storage_client():
    import boto3
    from botocore.config import Config
    from settings import settings
    return boto3.client("s3", endpoint_url=settings.S3_ENDPOINT,
                        aws_access_key_id=f"{settings.S3_TENANT_ID}:{settings.S3_ACCESS_KEY}",
                        aws_secret_access_key=settings.S3_SECRET_KEY, region_name=settings.S3_REGION_NAME,
                        config=Config(signature_version="s3v4", connect_timeout=2, read_timeout=3,
                                      retries={"total_max_attempts": 1}))


def eligible(session, uid, subject):
    user = session.get(UserORM, uid)
    identity = session.get(ExternalIdentityORM, subject)
    meta = session.get(ProfileMetadataORM, uid)
    return bool(user and identity and identity.user_id == uid and not user.is_service and not user.banned
                and user.account_state in ("pending", "active") and not user.photo_url
                and not (meta and (meta.preset_id or meta.avatar_file_id)))


def import_avatar(uid, subject, url):
    """Called by BackgroundTasks after the response; failure is retried on next login.

    At most two imports per worker and one per user. A pending file records the
    object before PUT; failures queue deletion and a later login retires expired
    imports left by an interrupted process.
    """
    if not avatar_url(url):
        return
    with _guard:
        if uid in _inflight or len(_inflight) >= 2:
            return
        _inflight.add(uid)
    fid = None
    try:
        with db.atomic(), db._session() as session:
            expired = session.query(FileRecordORM).filter(
                FileRecordORM.owner_kind == "avatar", FileRecordORM.owner_id == str(uid),
                FileRecordORM.file_id.startswith("vk-avatar-"), FileRecordORM.state == "pending",
                FileRecordORM.expires_at < datetime.now(timezone.utc).isoformat()).all()
            if expired:
                from profile_features import retire_avatar
                for file in expired:
                    retire_avatar(session, file)
            if not eligible(session, uid, subject):
                return
        data, mime = download(url)
        validate_image(data, mime)
        fid = "vk-avatar-" + str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc)
        with db.atomic(), db._session() as session:
            if not eligible(session, uid, subject):
                return
            session.add(FileRecordORM(file_id=fid, owner_kind="avatar", owner_id=str(uid), purpose="avatar",
                name="vk-avatar." + {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime],
                mime_type=mime, size_bytes=len(data), uploaded_by_user_id=uid, state="pending",
                created_at=timestamp.isoformat(), expires_at=(timestamp + timedelta(hours=1)).isoformat()))
        from settings import settings
        from file_access import sealed_key
        storage_client().put_object(Bucket=settings.S3_BUCKET_NAME, Key=sealed_key(fid), Body=data,
            ContentType=mime, IfNoneMatch="*", Metadata={"sha256": hashlib.sha256(data).hexdigest()})
        with db.atomic(), db._session() as session:
            file = session.get(FileRecordORM, fid)
            if not file:
                return
            if not eligible(session, uid, subject):
                from profile_features import retire_avatar
                retire_avatar(session, file)
                return
            meta = session.get(ProfileMetadataORM, uid)
            if meta is None:
                meta = ProfileMetadataORM(user_id=uid)
                session.add(meta)
            file.state, file.sealed_at = "completed", datetime.now(timezone.utc).isoformat()
            meta.avatar_file_id = fid
    except Exception:
        # Provider URL query strings and storage exception messages can contain secrets.
        logger.warning("VK avatar import did not complete; next VK login may retry")
        if fid:
            try:
                with db.atomic(), db._session() as session:
                    file = session.get(FileRecordORM, fid)
                    if file and file.state == "pending":
                        from profile_features import retire_avatar
                        retire_avatar(session, file)
            except Exception:
                logger.warning("VK avatar pending file requires cleanup")
    finally:
        with _guard:
            _inflight.discard(uid)
