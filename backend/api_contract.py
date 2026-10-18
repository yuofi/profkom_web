"""Shared wire format for cursor lists and domain errors."""
from typing import Generic, TypeVar
from pydantic import BaseModel
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

T=TypeVar('T')
class Page(BaseModel,Generic[T]):
    items:list[T]
    next_cursor:str|None=None


def install_errors(app):
    @app.exception_handler(StarletteHTTPException)
    async def http_error(request:Request,exc:StarletteHTTPException):
        detail=exc.detail
        # Existing auth/profile error strings are supported by the client adapter.
        legacy=request.url.path.startswith(('/api/auth/','/api/profile/','/api/guides','/api/pgas','/api/contacts'))
        if not legacy:
            if isinstance(detail,dict):
                detail={'code':detail.get('code') or detail.get('detail') or f'http_{exc.status_code}','message':detail.get('message') or 'Операция недоступна','fields':detail.get('fields',{})}
            else:
                detail={'code':{401:'unauthenticated',403:'forbidden',404:'not_found',409:'conflict',422:'invalid_input'}.get(exc.status_code,f'http_{exc.status_code}'),'message':str(detail)}
        return JSONResponse({'detail':detail},status_code=exc.status_code,headers=exc.headers)
