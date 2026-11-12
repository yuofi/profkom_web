"""Persistence and file references for precompiled guide inserts. Reads never compile."""
import json
import re
from collections import OrderedDict
from threading import RLock

from pydantic import ValidationError
from pydantic_core import to_json
from domain_models import MaterialRenderArtifactORM
from domain_contract import GuideRender, JournalRender
from guide_embeds import source_hash, SCHEMA_VERSION, POLICY_VERSION

EXTENDED = "markdown-embeds-v1"
JOURNAL = "journal-v1"
FORMATS = frozenset({EXTENDED, JOURNAL})
_CACHE_ENTRIES = 8
_CACHE_BYTES = 2 * 1024 * 1024  # Serialized artifact budget, not a claim about Python heap size.
_cache = OrderedDict()
_cache_bytes = 0
_cache_lock = RLock()


class ArtifactInvariantError(RuntimeError):
    """A server-produced artifact is inconsistent, not a user's validation error."""


def clear_cache():
    """Only derived content is cached; useful for policy rollout and isolated checks."""
    global _cache_bytes
    with _cache_lock:
        _cache.clear()
        _cache_bytes = 0


def artifacts(session, material_id):
    return {item.slot: item for item in session.query(MaterialRenderArtifactORM).filter_by(material_id=material_id)}


def load_model(artifact, body, format=EXTENDED):
    """Bounded immutable derived-tree cache. Every caller still checks current ACL.

    The current source hash and policy are checked on every hit. No material ID,
    user, session, capabilities, file permissions or signed URL is cached here.
    """
    global _cache_bytes
    if format not in FORMATS or artifact is None or artifact.source_hash != source_hash(format, body or ""):
        return None
    payload = getattr(artifact, "render_json", None)
    # A string-keyed cache compares exact immutable JSON. On a warm hit this
    # avoids UTF-8 encoding and SHA-256 of the entire tree for every reader.
    if not isinstance(payload, str) or len(payload) > 512 * 1024:
        return None
    schema_version = 2 if format == JOURNAL else SCHEMA_VERSION
    key = (format, schema_version, POLICY_VERSION, payload)
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            parsed, _, _, _ = cached
            _cache.move_to_end(key)
            return parsed if parsed.source_hash == artifact.source_hash else None
    try:
        encoded = payload.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if len(encoded) > 512 * 1024:
        return None
    try:
        parsed = (JournalRender if format == JOURNAL else GuideRender).model_validate_json(artifact.render_json)
    except (ValueError, ValidationError):
        return None
    if (parsed.source_hash != artifact.source_hash or parsed.schema_version != schema_version
            or parsed.policy_version != POLICY_VERSION):
        return None
    serialized = parsed.model_dump_json(exclude_unset=True).encode("utf-8")
    content_json = b'{"format":' + to_json(format) + b',"body":' + to_json(body or "") + b',"render":' + serialized + b"}"
    size = len(encoded) + len(serialized) + len(content_json)
    if size > _CACHE_BYTES:
        return parsed
    with _cache_lock:
        # Another reader may have validated the same cold entry concurrently.
        if key not in _cache:
            while _cache and (len(_cache) >= _CACHE_ENTRIES or _cache_bytes + size > _CACHE_BYTES):
                _, (_, _, _, removed_size) = _cache.popitem(last=False)
                _cache_bytes -= removed_size
            _cache[key] = (parsed, serialized, content_json, size)
            _cache_bytes += size
    return parsed


def load(artifact, body, format=EXTENDED):
    """Writers receive their own plain copy; never mutate a response model."""
    parsed = load_model(artifact, body, format)
    return parsed.model_dump(mode="json", exclude_unset=True) if parsed is not None else None


def save(session, material_id, slot, body, render, format=EXTENDED):
    old = session.get(MaterialRenderArtifactORM, (material_id, slot))
    if render is None:
        if old:
            session.delete(old)
        return
    if format not in FORMATS:
        raise ArtifactInvariantError("Unknown guide render format")
    digest = source_hash(format, body or "")
    checked = (JournalRender if format == JOURNAL else GuideRender).model_validate(render)
    if checked.source_hash != digest:
        raise ArtifactInvariantError("Guide render source mismatch")
    payload = json.dumps(checked.model_dump(mode="json", exclude_unset=True), ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 512 * 1024:
        raise ArtifactInvariantError("Guide render exceeds storage limit")
    if old is None:
        old = MaterialRenderArtifactORM(material_id=material_id, slot=slot)
        session.add(old)
    old.source_hash, old.render_json = digest, payload


def published_file_ids(session, material):
    if material.published_format in FORMATS:
        render = load_model(session.get(MaterialRenderArtifactORM, (material.material_id, "published")), material.published_body, material.published_format)
        return set(render.file_ids) if render and not render.diagnostics else set()
    # Historical Markdown readers accepted stored file references anywhere in the source.
    # Preserve that contract without parsing on read; rich content uses only verified refs.
    return set(re.findall(r"file:(file-[\w-]+)", material.published_body or ""))


def check_images(session, render):
    """Context and completion are checked by check_attachments; image MIME here."""
    from database import FileRecordORM
    from file_access import INLINE
    from errors import InvalidInput
    if render.get("schema_version") == 2:
        for fid in render["image_file_ids"]:
            record = session.get(FileRecordORM, fid)
            if not record or record.mime_type not in INLINE:
                raise InvalidInput("Изображение требует завершённый файл PNG, JPEG или WebP", "guide_image_type")
        return
    def walk(nodes):
        for node in nodes:
            if node["tag"] == "img":
                fid = node["attrs"]["src"][5:]
                record = session.get(FileRecordORM, fid)
                if not record or record.mime_type not in INLINE:
                    raise InvalidInput("Вставка изображения требует завершённый файл PNG, JPEG или WebP", "guide_image_type")
            walk(node["children"])
    for block in render["blocks"]:
        walk(block["nodes"])


def serialized_model(model):
    """Canonical JSON for a validated immutable tree; never a cached user response."""
    with _cache_lock:
        for parsed, encoded, _, _ in _cache.values():
            if parsed is model:
                return encoded
    return model.model_dump_json(exclude_unset=True).encode("utf-8")


def serialized_content(model):
    """Source and tree are immutable together; ACL and metadata are never cached."""
    with _cache_lock:
        for parsed, _, encoded, _ in _cache.values():
            if parsed is model:
                return encoded
    return None


def detail_response(data):
    """Serialize current metadata while reusing immutable, source-matched content bytes.

    Material authorization and source/policy matching have already run for this
    request. Validate all dynamic DTO fields normally. The tree itself came from
    GuideRender validation, so copying its canonical JSON avoids walking hundreds
    of frozen nodes again for every reader. No source text is interpolated raw.
    """
    from domain_contract import Material
    from fastapi.responses import Response

    renders = {}
    metadata = dict(data)
    for key in ("published_content", "draft_content", "source_content"):
        content = data.get(key)
        if content and isinstance(content.get("render"), (GuideRender, JournalRender)):
            renders[key] = content["render"]
            metadata[key] = {**content, "render": None}
    checked = Material.model_validate(metadata).model_dump(mode="json", exclude_unset=True)
    encode = to_json
    fields = []
    for key, value in checked.items():
        if key in renders and (cached := serialized_content(renders[key])) is not None:
            encoded = cached
        elif key in renders:
            members = [encode(k) + b":" + encode(v) for k, v in value.items() if k != "render"]
            members.append(b'"render":' + serialized_model(renders[key]))
            encoded = b"{" + b",".join(members) + b"}"
        else:
            encoded = encode(value)
        fields.append(encode(key) + b":" + encoded)
    return Response(b"{" + b",".join(fields) + b"}", media_type="application/json")
