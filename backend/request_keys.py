"""Idempotent creation (GL-07).

A task or a comment created with an idempotency key is returned again when the same author
repeats the same request with that key, e.g. after the answer was lost to a timeout. The key
with other data or by another person is a conflict, as for feedback (support.py).
"""
import hashlib
import uuid

from errors import Conflict


def uuid_key(value):
    if value is None:
        return None
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("A UUID idempotency key is required")


def digest(payload, *context) -> str:
    body = payload.model_dump_json(exclude={"idempotency_key"})
    return hashlib.sha256("\n".join([*map(str, context), body]).encode()).hexdigest()


def previous(session, orm, owner_column: str, owner_id: int, key, request_hash: str):
    """The row the first request with this key created, or None."""
    if not key:
        return None
    row = session.query(orm).filter(orm.idempotency_key == key).first()
    if row is None:
        return None
    if getattr(row, owner_column) != owner_id or row.request_hash != request_hash:
        raise Conflict("Idempotency key has already been used", "duplicate_request_key")
    return row


def remember(session, row, key, request_hash: str) -> None:
    if key:
        row.idempotency_key, row.request_hash = key, request_hash
        session.flush()
