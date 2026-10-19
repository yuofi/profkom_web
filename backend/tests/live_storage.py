"""In-memory S3 boundary for the disposable localhost API, with real HTTP PUT/GET.

Installed only by tests/live_api.py. Production routes and credentials are untouched.
"""

from io import BytesIO
import hashlib
import hmac
import secrets
import time
from urllib.parse import quote

from botocore.exceptions import ClientError
from fastapi import HTTPException, Request, Response


def install(app, port):
    from utils.s3_service import s3_client

    secret = secrets.token_bytes(32)
    objects = {}

    def signature(method, key, expires):
        return hmac.new(
            secret, f"{method}:{key}:{expires}".encode(), hashlib.sha256
        ).hexdigest()

    def presign(operation, Params, ExpiresIn):
        method = {"put_object": "PUT", "get_object": "GET"}[operation]
        expires = int(time.time()) + ExpiresIn
        key = Params["Key"]
        return (
            f"http://localhost:{port}/_test/objects/{quote(key, safe='/')}"
            f"?expires={expires}&signature={signature(method, key, expires)}"
        )

    def get(key):
        if key not in objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return objects[key]

    def head_object(Bucket, Key):
        data, mime = get(Key)
        return {"ContentLength": len(data), "ContentType": mime}

    def get_object(Bucket, Key, Range=None):
        data, _ = get(Key)
        return {"Body": BytesIO(data[:512] if Range else data)}

    s3_client.generate_presigned_url = presign
    s3_client.head_object = head_object
    s3_client.get_object = get_object
    s3_client.delete_object = lambda Bucket, Key: objects.pop(Key, None)

    @app.api_route(
        "/_test/objects/{key:path}", methods=["PUT", "GET"], include_in_schema=False
    )
    async def object_route(key: str, request: Request, expires: int, signature: str):
        expected = hmac.new(
            secret, f"{request.method}:{key}:{expires}".encode(), hashlib.sha256
        ).hexdigest()
        if expires < time.time() or not hmac.compare_digest(signature, expected):
            raise HTTPException(403, "Invalid or expired test object signature")
        if request.method == "PUT":
            data = await request.body()
            if len(data) > 20 * 1024 * 1024:
                raise HTTPException(413, "Test object exceeds upload limit")
            objects[key] = (data, request.headers.get("content-type", ""))
            return Response(status_code=200)
        if key not in objects:
            raise HTTPException(404, "Test object not found")
        data, mime = objects[key]
        return Response(data, media_type=mime)
