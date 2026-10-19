"""Browser MIME compatibility still requires canonical metadata and real file bytes."""

import pytest
from database import db, FileRecordORM


@pytest.mark.parametrize(
    "name,mime,canonical,content",
    [
        ("a.JPG", "image/jpg", "image/jpeg", b"\xff\xd8\xffsynthetic"),
        ("a.png", "", "image/png", b"\x89PNG\r\n\x1a\nsynthetic"),
        ("a.pdf", "application/octet-stream", "application/pdf", b"%PDF-1.7 synthetic"),
        (
            "a.docx",
            "",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            b"PK\x03\x04synthetic",
        ),
    ],
)
def test_browser_metadata_normalized_before_signing_and_completion(
    client, pgas_admin, mock_s3, name, mime, canonical, content
):
    result = client.post(
        "/api/files/upload-intents",
        headers=pgas_admin.headers,
        json=dict(
            owner_kind="pgas",
            purpose="pgas",
            name=name,
            mime_type=mime,
            size_bytes=len(content),
        ),
    )
    assert result.status_code == 200, result.text
    fid = result.json()["file_id"]
    assert result.json()["headers"]["Content-Type"] == canonical
    mock_s3["objects"]["private/" + fid] = (content, canonical)
    result = client.post(
        "/api/files/" + fid + "/complete", headers=pgas_admin.headers, json={}
    )
    assert result.status_code == 200 and result.json()["mime_type"] == canonical
    with db._session() as session:
        assert session.get(FileRecordORM, fid).mime_type == canonical


@pytest.mark.parametrize(
    "kind,purpose,limit", [("avatar", "avatar", 10), ("pgas", "pgas", 20)]
)
def test_exact_size_limit_and_one_byte_over(client, pgas_admin, kind, purpose, limit):
    payload = dict(
        owner_kind=kind,
        purpose=purpose,
        name="a.png",
        mime_type="",
        size_bytes=limit * 1024 * 1024,
    )
    assert (
        client.post(
            "/api/files/upload-intents", headers=pgas_admin.headers, json=payload
        ).status_code
        == 200
    )
    for size in (0, limit * 1024 * 1024 + 1):
        payload["size_bytes"] = size
        assert (
            client.post(
                "/api/files/upload-intents", headers=pgas_admin.headers, json=payload
            ).status_code
            == 422
        )


@pytest.mark.parametrize(
    "name,mime",
    [
        ("a.gif", "image/gif"),
        ("a.pdf", "text/html"),
        ("a.zip", "application/x-zip-compressed"),
        ("a.xlsx", ""),
    ],
)
def test_pgas_cannot_bypass_context_format_restriction(client, pgas_admin, name, mime):
    r = client.post(
        "/api/files/upload-intents",
        headers=pgas_admin.headers,
        json=dict(
            owner_kind="pgas", purpose="pgas", name=name, mime_type=mime, size_bytes=10
        ),
    )
    assert r.status_code == 422
