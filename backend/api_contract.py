"""Shared wire format for cursor lists and domain errors."""

import base64
import json
import re
from typing import Generic, TypeVar
from pydantic import BaseModel
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException

from errors import DomainError, InvalidInput, NotFound

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


# Server page size of cursor lists; tests/live_api.py lowers it for the integration suite.
PAGE_SIZE = 100


def cursor_page(items, key, cursor=None, *, descending=False, limit=None):
    """One keyset page of `items`, which already holds only what the reader may see.

    The opaque cursor is the sort key of the last item on the previous page, so a page
    neither repeats nor skips items when others change in between (FIX_PLAN 2.2, A-EVT-10).
    `key` returns a tuple of strings and numbers without None."""
    ordered = sorted(items, key=key, reverse=descending)
    if cursor is not None:
        try:
            last = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
            if not isinstance(last, list) or not all(
                isinstance(v, (str, int, float)) and not isinstance(v, bool) for v in last
            ):
                raise ValueError(cursor)
            last = tuple(last)
            ordered = [item for item in ordered if (key(item) < last if descending else key(item) > last)]
        except (ValueError, TypeError, UnicodeError):
            raise HTTPException(422, "Invalid cursor")
    size=min(limit,PAGE_SIZE) if limit is not None else PAGE_SIZE
    page, rest = ordered[:size], ordered[size:]
    following = base64.urlsafe_b64encode(json.dumps(list(key(page[-1]))).encode()).decode() if rest else None
    return Page(items=page, next_cursor=following)


# Routes of the old site keep a plain string `detail`. Routes added since then, even under
# the same prefixes (/contacts/archive, /profile/me/avatar, /pgas-admins, …), answer
# {detail: {code, message}} (FIX_PLAN 2.13). A path segment may be any id, even a wrong
# one: its validation error keeps the old shape too.
LEGACY_ROUTES = re.compile(r"/api/(?:auth/.+|profile/[^/]+|guides(?:/[^/]+)?|pgas(?:/[^/]+)?|contacts(?:/filter)?)")


def legacy(path):
    return bool(LEGACY_ROUTES.fullmatch(path))


# Codes of plain HTTPException details; a DomainError carries its own.
STATUS_CODES = {
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "invalid_input",
    503: "unavailable",
}


def install_errors(app):
    @app.exception_handler(DomainError)
    async def domain_error(request: Request, exc: DomainError):
        if legacy(request.url.path):
            return JSONResponse({"detail": exc.message}, status_code=exc.status)
        return JSONResponse(
            {"detail": {"code": exc.code, "message": exc.message, "fields": exc.fields}},
            status_code=exc.status,
        )

    # A ValueError or LookupError that is not a DomainError comes from parsing a value
    # (dates, numbers) the request sent, as before the typed errors.
    @app.exception_handler(ValueError)
    async def bad_value(request: Request, exc: ValueError):
        return await domain_error(request, InvalidInput(str(exc)))

    @app.exception_handler(LookupError)
    async def missing(request: Request, exc: LookupError):
        if type(exc) is not LookupError:  # KeyError, IndexError: a defect, not a missing object
            raise exc
        return await domain_error(request, NotFound(str(exc)))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        if legacy(request.url.path):
            return await request_validation_exception_handler(request, exc)
        errors = [
            {
                key: value
                for key, value in error.items()
                if key in ("type", "loc", "msg")
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            {
                "detail": {
                    "code": "validation_error",
                    "message": "Проверьте заполнение полей",
                    "fields": {"errors": errors},
                }
            },
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        detail = exc.detail
        # Existing auth/profile error strings are supported by the client adapter.
        if not legacy(request.url.path):
            if isinstance(detail, dict):
                detail = {
                    "code": detail.get("code")
                    or detail.get("detail")
                    or f"http_{exc.status_code}",
                    "message": detail.get("message") or "Операция недоступна",
                    "fields": {
                        **{
                            k: v
                            for k, v in detail.items()
                            if k not in ("code", "detail", "message", "fields")
                        },
                        **detail.get("fields", {}),
                    },
                }
            else:
                detail = {
                    "code": STATUS_CODES.get(exc.status_code, f"http_{exc.status_code}"),
                    "message": str(detail),
                    "fields": {},
                }
        return JSONResponse(
            {"detail": detail}, status_code=exc.status_code, headers=exc.headers
        )
