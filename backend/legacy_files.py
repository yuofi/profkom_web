"""Read-time adaptation of existing storage URLs. Never fetch remote content.

No link that a client gets is signed (decision 23): `file:<id>` becomes the API address
of its bytes, where access is checked on every request; an old public upload keeps its
canonical URL until scripts/adopt_legacy_files.py turns it into `file:<id>` (АВ-10).
"""

from errors import InvalidInput
import re
from urllib.parse import quote, unquote, urlsplit

from settings import settings

# A URL in Markdown or HTML: «|» (the gallery caption) and the closing punctuation of
# a sentence are not part of it (A-MAT-3).
LINK = re.compile(r"https?://[^\s<>\"'()|\[\]]*[^\s<>\"'()|\[\].,;:!?]")
FILE_REF = re.compile(r"file:(file-[\w-]+)")
# The read form of a file reference, as a client may send it back.
CONTENT_LINK = re.compile(r"(?:https?://[^\s/<>\"'()|]+)?/api/files/(file-[\w-]+)/content")
# Old uploads went straight to the bucket: pgas/ and guides/ kept the file name,
# avatars/ and every other folder (gallery images) got `<uuid>.<ext>`.
NAMED_FOLDERS = ("pgas", "guides", "avatars")
UUID_NAME = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[^/]+", re.I
)
# Contextual files live under these prefixes and are served only through
# /files/{id}/download with its ACL.
CLOSED_FOLDERS = ("private", "sealed")


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


def legacy_key(url):
    """Key of an old public upload: the only bucket objects a text link is signed for (A-SEC-2)."""
    key = storage_key(url)
    if not key:
        return None
    folder, _, name = key.partition("/")
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]+", folder)
        or folder.lower() in CLOSED_FOLDERS
        or name in ("", ".", "..")
        or "/" in name
        or "\\" in name
    ):
        return None
    return key if folder in NAMED_FOLDERS or UUID_NAME.fullmatch(name) else None


def canonical_url(key):
    # The public URL that utils/s3_service gave old uploads.
    return f"https://global.s3.cloud.ru/{settings.S3_BUCKET_NAME}/{quote(key, safe='/')}"


def read_url(url):
    if not url:
        return url
    from file_access import content_url

    if url.startswith("file:"):
        return content_url(url[5:])
    key = legacy_key(url)
    if key:
        # Unsigned: it works while the bucket is public and only until the adoption.
        return canonical_url(key)
    # Any other bucket key stays as written and unsigned (owner decision 6).
    return url


def read_text(body):
    """The stored text with its file references as API addresses; nothing else changes,
    so captions and punctuation around a link stay as written (A-MAT-3). Nothing here
    checks access or calls the storage: one unreadable file costs only its own link
    (A-MAT-8)."""
    from file_access import content_url

    return FILE_REF.sub(lambda m: content_url(m[1]), body or "")


def bucket_keys(body):
    return {k for k in map(storage_key, LINK.findall(body or "")) if k}


def own_attachments(s, material_id):
    """Key → file id for the sealed objects of completed attachments of this material."""
    from database import FileRecordORM

    def owner(key):
        if not material_id or not key.startswith("sealed/"):
            return None
        fr = s.get(FileRecordORM, key[len("sealed/") :])
        if (
            fr
            and fr.state == "completed"
            and fr.owner_kind == "material"
            and fr.owner_id == material_id
        ):
            return fr.file_id
        return None

    return owner


def stored_text(body, attachment, known=None, counts=None):
    """Bring the bucket links of a material text to their stored form (A-MAT-1).

    A link to the material's own attachment (`attachment(key)` gives its id), also in
    the read form /api/files/<id>/content, becomes `file:<id>`, a signed link to an
    old public upload loses its signature, other links stay byte for byte. With `known` (the keys already in the published
    source) a link to any other bucket key raises ValueError: new files are
    attached, not linked (A-SEC-2)."""

    def own(m):
        fid = attachment("sealed/" + m[1])
        return "file:" + fid if fid else m[0]

    def fix(m):
        url = m[0]
        key = storage_key(url)
        if key is None:
            return url
        fid = attachment(key)
        if fid:
            kind, new = "attachment", "file:" + fid
        elif known is not None and key not in known:
            raise InvalidInput(
                "New links into the file storage are not allowed; attach the file instead"
            )
        elif legacy_key(url):
            kind, new = "legacy", canonical_url(key) if urlsplit(url).query else url
        else:
            kind, new = "other", url
        if counts is not None:
            counts[kind + ("_fixed" if new != url else "_kept")] += 1
        return new

    return LINK.sub(fix, CONTENT_LINK.sub(own, body or ""))
