"""Read-time adaptation of existing storage URLs. Never fetch remote content."""

import re
from urllib.parse import unquote, urlsplit

from file_access import download
from settings import settings
from utils.s3_service import s3_client


def storage_key(url):
    parsed = urlsplit(url)
    endpoint = urlsplit(settings.S3_ENDPOINT)
    if parsed.scheme not in ("https", "http") or parsed.netloc not in (
        endpoint.netloc,
        "global.s3.cloud.ru",
    ):
        return None
    prefix = "/" + settings.S3_BUCKET_NAME + "/"
    return (
        unquote(parsed.path[len(prefix) :]) if parsed.path.startswith(prefix) else None
    )


def read_url(url, uid):
    if not url:
        return url
    if url.startswith("file:"):
        return download(url[5:], uid)["download_url"]
    key = storage_key(url)
    if key:
        return s3_client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.S3_BUCKET_NAME,
                "Key": key,
            },
            ExpiresIn=300,
        )
    return url


def read_text(body, uid):
    # Source remains immutable. Resolve only links in serialized published/draft text.
    return re.sub(
        r'https?://[^\s<>"\)]+|file:file-[\w-]+',
        lambda m: read_url(m[0], uid),
        body or "",
    )
