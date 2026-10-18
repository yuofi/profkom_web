"""Shared wire format for cursor lists and domain errors."""

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
