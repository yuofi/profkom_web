"""Private file contexts, attachment checks and verified object storage I/O.

Bytes are served only by GET /api/files/{id}/content, with the access check on every
request (decision 23, АВ-9). No signed storage link reaches a client: behind nginx the
response is an X-Accel-Redirect to an internal location that fetches the object with a
short signature; without nginx (local runs, tests) the backend streams the object.
"""

from errors import Forbidden, InvalidInput
import json
import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import quote
from fastapi import HTTPException
from fastapi.responses import Response, StreamingResponse
from botocore.exceptions import BotoCoreError, ClientError
from database import (
    db,
    FileRecordORM,
    TaskORM,
    AssignmentORM,
    ReportORM,
    ReportVersionORM,
)
from utils.s3_service import s3_client
from settings import settings
from file_types import TYPES


def now():
    return datetime.now(timezone.utc)


def key(fid):
    """Upload staging key. Never use it to serve a completed file."""
    return "private/" + fid


def sealed_key(fid):
    return "sealed/" + fid


def content_url(fid):
    """The one address of a file's bytes that clients get."""
    return f"/api/files/{quote(fid, safe='')}/content"


# nginx sets this header on proxied API requests: answer with X-Accel-Redirect then.
DELIVERY_HEADER = "X-File-Delivery"
ACCEL_LOCATION = "/_storage"
# The internal location starts the fetch at once; the signature is never shown to a client.
ACCEL_TTL = 60
# Shown in place (avatars and pictures in materials); everything else is downloaded.
INLINE = ("image/png", "image/jpeg", "image/webp")


def storage_error(error):
    if isinstance(error, ClientError) and error.response.get("Error", {}).get("Code") in (
        "404", "NoSuchKey", "NotFound",
    ):
        raise HTTPException(409, {"code": "upload_missing", "message": "Uploaded object not found"}) from error
    raise HTTPException(503, "Object storage unavailable") from error


def check_metadata(fr, metadata):
    if (
        metadata.get("ContentLength") != fr.size_bytes
        or metadata.get("ContentType", "").split(";")[0] != fr.mime_type
    ):
        raise HTTPException(422, "Uploaded object metadata mismatch")


def validate_metadata(kind, purpose, name, mime, size):
    if kind not in ("avatar", "assignment", "report", "material", "pgas"):
        raise InvalidInput("Unsupported file context")
    expected = {
        "avatar": "avatar",
        "assignment": "submission",
        "report": "report",
        "material": "material",
        "pgas": "pgas",
    }
    if purpose != expected[kind]:
        raise InvalidInput("Invalid file purpose")
    limit = 10 if kind == "avatar" else 20
    if not 0 < size <= limit * 1024 * 1024:
        raise InvalidInput(f"File size must be between 1 byte and {limit} MiB")
    if not name or "/" in name or "\\" in name or any(ord(c) < 32 for c in name):
        raise InvalidInput("Invalid file name")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    canonical = next((m for m, extensions in TYPES.items() if ext in extensions), None)
    mime = (mime or "").strip().lower()
    if mime in ("", "application/octet-stream"):
        mime = canonical
    mime = {
        "image/jpg": "image/jpeg",
        "application/x-zip-compressed": "application/zip",
    }.get(mime, mime)
    if not canonical or mime != canonical:
        raise InvalidInput("File type is not allowed")
    if kind == "avatar" and mime not in ("image/png", "image/jpeg", "image/webp"):
        raise InvalidInput("Avatar must be PNG, JPEG or WebP")
    if kind == "pgas" and ext not in ("pdf", "doc", "docx", "png", "jpg", "jpeg"):
        raise InvalidInput("Only pdf, doc, docx, png and jpg files are allowed for PGAS")
    return mime


def permitted(session, fr, uid, write=False):
    u = db.get_user(uid)
    if not u or u.banned or u.account_state != "active":
        return False
    if fr.owner_kind == "avatar":
        if str(uid) == fr.owner_id:
            return True
        if write:
            return False
        from domain_models import ProfileMetadataORM

        owner = db.get_user(int(fr.owner_id))
        meta = session.get(ProfileMetadataORM, int(fr.owner_id))
        return bool(
            owner
            and owner.account_state == "active"
            and not owner.banned
            and meta
            and meta.avatar_file_id == fr.file_id
        )
    if fr.owner_kind in ("assignment", "task"):
        if fr.owner_kind == "assignment":
            a = session.get(AssignmentORM, fr.owner_id)
            if not a or (write and a.assignee_user_id != uid):
                return False
            task = session.get(TaskORM, a.task_id)
        else:
            task = session.get(TaskORM, fr.owner_id)
        return bool(task and db.can_view_scope(uid, task.scope_kind, task.scope_id))
    if fr.owner_kind == "report":
        r = session.get(ReportORM, fr.owner_id)
        if not r:
            return False
        if db.is_report_editor(uid, r, session):
            return True
        if write:
            return False
        if not db.can_read_report(uid, r, session):
            return False
        published = (
            set(json.loads(r.files_json or "[]")) if r.state == "published" else set()
        )
        for v in session.query(ReportVersionORM).filter_by(report_id=r.report_id):
            published.update(json.loads(v.files_json or "[]"))
        return fr.file_id in published
    if fr.owner_kind == "material":
        from materials import can_read, can_edit

        if can_edit(fr.owner_id, uid):
            return True
        if write or not can_read(fr.owner_id, uid):
            return False
        from domain_models import MaterialORM

        material = session.get(MaterialORM, fr.owner_id)
        return "file:" + fr.file_id in (material.published_body or "")
    if fr.owner_kind == "pgas":
        import access

        return access.allowed(uid, "pgas.manage") if write else True
    return False


def owner_exists(session, kind, owner_id):
    """An upload into a missing assignment, report or material is a 404 (A-SEC-7)."""
    from domain_models import MaterialORM

    model = {"assignment": AssignmentORM, "report": ReportORM, "material": MaterialORM}.get(kind)
    return model is None or session.get(model, owner_id) is not None


def presign_upload(fr):
    return s3_client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": key(fr.file_id),
            "ContentType": fr.mime_type,
        },
        ExpiresIn=900,
    )


def verify_object(fr):
    """Return the bounded GET snapshot that was actually verified, not a copy source."""
    try:
        metadata = s3_client.head_object(
            Bucket=settings.S3_BUCKET_NAME, Key=key(fr.file_id)
        )
        check_metadata(fr, metadata)
        if not 0 < fr.size_bytes <= (10 if fr.owner_kind == "avatar" else 20) * 1024 * 1024:
            raise HTTPException(422, "Uploaded object exceeds context limit")
        response = s3_client.get_object(
            Bucket=settings.S3_BUCKET_NAME, Key=key(fr.file_id)
        )
        body = response["Body"]
        try:
            check_metadata(fr, response)
            data = body.read(fr.size_bytes + 1)
        finally:
            body.close()
    except (ClientError, BotoCoreError) as error:
        storage_error(error)
    if len(data) != fr.size_bytes:
        raise HTTPException(422, "Uploaded object metadata mismatch")
    sample = data[:512]
    checks = {
        "image/png": sample.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": sample.startswith(b"\xff\xd8\xff"),
        "image/webp": sample.startswith(b"RIFF") and sample[8:12] == b"WEBP",
        "application/pdf": sample.startswith(b"%PDF-"),
    }
    valid = checks.get(fr.mime_type)
    if fr.mime_type in ("application/zip",) or "openxmlformats" in fr.mime_type:
        valid = sample.startswith(b"PK\x03\x04")
    if fr.mime_type in (
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
    ):
        valid = sample.startswith(bytes.fromhex("d0cf11e0a1b11ae1"))
    if valid is False:
        raise HTTPException(422, "Uploaded file content does not match type")
    return data


def ensure_sealed(fr):
    """Create once, including old completed IDs; GETs never use the staging key.

    The conditional put resolves competing completes/legacy reads without a DB
    write from GET. A late staging PUT cannot alter the verified in-memory bytes.
    """
    destination = sealed_key(fr.file_id)
    try:
        metadata = s3_client.head_object(Bucket=settings.S3_BUCKET_NAME, Key=destination)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey", "NotFound"):
            storage_error(error)
    except BotoCoreError as error:
        storage_error(error)
    else:
        check_metadata(fr, metadata)
        return destination
    data = verify_object(fr)
    try:
        s3_client.put_object(
            Bucket=settings.S3_BUCKET_NAME, Key=destination, Body=data,
            ContentType=fr.mime_type, IfNoneMatch="*",
            Metadata={"sha256": hashlib.sha256(data).hexdigest()},
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") not in ("412", "PreconditionFailed"):
            storage_error(error)
        # A concurrent operation already sealed its verified snapshot. Never replace it.
        try:
            check_metadata(fr, s3_client.head_object(Bucket=settings.S3_BUCKET_NAME, Key=destination))
        except (ClientError, BotoCoreError) as error:
            storage_error(error)
    except BotoCoreError as error:
        storage_error(error)
    return destination


def complete(fid, uid):
    with db._session() as s:
        fr = s.get(FileRecordORM, fid)
        if not fr or fr.uploaded_by_user_id != uid or not permitted(s, fr, uid, True):
            raise HTTPException(404, "File not found")
        if fr.state != "completed":
            if datetime.fromisoformat(fr.expires_at) < now():
                raise HTTPException(409, {"code": "upload_expired", "message": "Upload intent expired"})
            ensure_sealed(fr)
            fr.state = "completed"
            fr.sealed_at = now().isoformat()
            s.commit()
        elif not fr.storage_key:
            ensure_sealed(fr)
            if not fr.sealed_at:
                fr.sealed_at = now().isoformat()
                s.commit()
        return dict(
            file_id=fr.file_id,
            name=fr.name,
            mime_type=fr.mime_type,
            size_bytes=fr.size_bytes,
        )


def readable(s, fid, uid):
    fr = s.get(FileRecordORM, fid)
    if not fr or fr.state != "completed" or not permitted(s, fr, uid):
        raise HTTPException(404, "File not found")
    return fr


def download(fid, uid):
    """Checks access now and gives the address; the bytes are checked again (decision 23)."""
    with db._session() as s:
        readable(s, fid, uid)
        return dict(download_url=content_url(fid), expires_at=None)


def stored_key(fr):
    """Key of the verified bytes. Only a record sealed before this marker existed costs
    a storage check here; seal_completed_files marks those at cutover (A-MAT-9)."""
    if fr.storage_key:
        return fr.storage_key
    return sealed_key(fr.file_id) if fr.sealed_at else ensure_sealed(fr)


def disposition(fr):
    """RFC 6266 with the original name (A-MAT-15): an ASCII fallback and the UTF-8 form."""
    name = re.sub(r'[\x00-\x1f\x7f"\\]', "", fr.name).strip() or "file"
    fallback = re.sub(r"[^\x20-\x7e]", "_", name)
    kind = "inline" if fr.mime_type in INLINE else "attachment"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(name, safe='')}"


def delivery_headers(fr):
    return {
        "Content-Type": fr.mime_type,
        "Content-Disposition": disposition(fr),
        # Every use asks again, so a revoked reader stops at once (decision 23).
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
    }


def deliver(fid, uid, accel):
    with db._session() as s:
        fr = readable(s, fid, uid)
        object_key = stored_key(fr)
        headers = delivery_headers(fr)
    if accel:
        url = s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.S3_BUCKET_NAME, "Key": object_key},
            ExpiresIn=ACCEL_TTL,
        )
        return Response(
            status_code=200,
            headers={**headers, "X-Accel-Redirect": ACCEL_LOCATION, "X-Storage-Url": url},
        )
    try:
        stored = s3_client.get_object(Bucket=settings.S3_BUCKET_NAME, Key=object_key)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(404, "File not found") from error
        raise HTTPException(503, "Object storage unavailable") from error
    except BotoCoreError as error:
        raise HTTPException(503, "Object storage unavailable") from error
    body = stored["Body"]

    def chunks():
        try:
            while chunk := body.read(64 * 1024):
                yield chunk
        finally:
            body.close()

    if stored.get("ContentLength") is not None:
        headers["Content-Length"] = str(stored["ContentLength"])
    return StreamingResponse(chunks(), headers=headers)


def check_attachments(session, file_ids, kind, owner_id, uid):
    if len(file_ids) != len(set(file_ids)):
        raise InvalidInput("Duplicate files", "duplicate_files")
    for fid in file_ids:
        fr = session.get(FileRecordORM, fid)
        if (
            not fr
            or fr.state != "completed"
            or fr.owner_kind != kind
            or fr.owner_id != owner_id
            or not permitted(session, fr, uid, True)
        ):
            raise Forbidden("Forbidden: invalid attachment or context")
