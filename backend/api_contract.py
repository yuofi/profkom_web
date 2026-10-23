"""Shared wire format for cursor lists and domain errors."""

import base64
import json
from typing import Generic, TypeVar
from pydantic import BaseModel
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


# Server page size of cursor lists; tests/live_api.py lowers it for the integration suite.
PAGE_SIZE = 100


def cursor_page(items, key, cursor=None, *, descending=False):
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
    page, rest = ordered[:PAGE_SIZE], ordered[PAGE_SIZE:]
    following = base64.urlsafe_b64encode(json.dumps(list(key(page[-1]))).encode()).decode() if rest else None
    return Page(items=page, next_cursor=following)


def install_errors(app):
    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        legacy = request.url.path.startswith(
            ("/api/auth/", "/api/profile/", "/api/guides", "/api/pgas", "/api/contacts")
        )
        if legacy:
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
        legacy = request.url.path.startswith(
            ("/api/auth/", "/api/profile/", "/api/guides", "/api/pgas", "/api/contacts")
        )
        if not legacy:
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
                    "code": {
                        401: "unauthenticated",
                        403: "forbidden",
                        404: "not_found",
                        409: "conflict",
                        422: "invalid_input",
                    }.get(exc.status_code, f"http_{exc.status_code}"),
                    "message": str(detail),
                }
        return JSONResponse(
            {"detail": detail}, status_code=exc.status_code, headers=exc.headers
        )
