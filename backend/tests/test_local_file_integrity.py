"""Completed file IDs always address a create-only verified byte snapshot."""
import pytest
from botocore.exceptions import ClientError

from database import db, FileRecordORM
from file_access import key, sealed_key
from test_v13_tracker import work
from test_v13_reports import reports
from utils.s3_service import s3_client

PDF_A = b"%PDF-1.4\nOriginal A"
PDF_B = b"%PDF-1.4\nReplaced B"
PNG_A = b"\x89PNG\r\n\x1a\nOriginal A"
PNG_B = b"\x89PNG\r\n\x1a\nReplaced B"


@pytest.fixture
def upload(request, client, mock_s3):
    kind = getattr(request, "param", "pgas")
    owner_id = None
    if kind == "avatar":
        actor = request.getfixturevalue("user")
    elif kind == "pgas":
        actor = request.getfixturevalue("pgas_admin")
    elif kind == "assignment":
        w = request.getfixturevalue("work")
        actor, owner_id = w["member"], w["task"]["assignments"][0]["assignment_id"]
    elif kind == "report":
        r = request.getfixturevalue("reports")
        actor, owner_id = r["author"], r["rid"]
    else:
        actor = request.getfixturevalue("superuser")
        material = client.post("/api/materials", headers=actor.headers, json=dict(
            kind="general", title="Files", description="", content=dict(format="markdown", body="")))
        assert material.status_code == 200, material.text
        owner_id = material.json()["material_id"]
    mime = "image/png" if kind == "avatar" else "application/pdf"
    original, replacement = (PNG_A, PNG_B) if kind == "avatar" else (PDF_A, PDF_B)
    response = client.post("/api/files/upload-intents", headers=actor.headers, json=dict(
        owner_kind=kind, owner_id=owner_id, purpose="submission" if kind == "assignment" else kind,
        name="file.png" if kind == "avatar" else "file.pdf", mime_type=mime, size_bytes=len(original)))
    assert response.status_code == 200, response.text
    fid = response.json()["file_id"]
    mock_s3["objects"][key(fid)] = (original, mime)
    return dict(actor=actor, fid=fid, original=original, replacement=replacement, mime=mime, owner_id=owner_id)


def complete(client, u):
    return client.post(f"/api/files/{u['fid']}/complete", headers=u["actor"].headers, json={})


@pytest.mark.parametrize("upload", ["avatar", "assignment", "report", "material", "pgas"], indirect=True)
def test_completed_context_never_serves_later_staging_put(client, upload, mock_s3):
    u = upload
    first = complete(client, u)
    assert first.status_code == 200, first.text
    mock_s3["objects"][key(u["fid"])] = (u["replacement"], u["mime"])
    assert complete(client, u).json() == first.json()
    response = client.get(f"/api/files/{u['fid']}/download", headers=u["actor"].headers)
    assert response.status_code == 200, response.text
    assert "/sealed/" in response.json()["download_url"]
    assert mock_s3["objects"][sealed_key(u["fid"])][0] == u["original"]


@pytest.mark.parametrize("upload", ["report"], indirect=True)
def test_old_report_version_keeps_original_file_bytes(client, upload, mock_s3):
    u = upload
    assert complete(client, u).status_code == 200
    rid = u["owner_id"]
    headers = u["actor"].headers
    assert client.patch(f"/api/reports/{rid}", headers=headers, json=dict(expected_revision=2, file_ids=[u["fid"]])).status_code == 200
    assert client.post(f"/api/reports/{rid}/publish", headers=headers, json=dict(expected_revision=3)).status_code == 200
    before = client.get(f"/api/reports/{rid}/versions", headers=headers).json()
    mock_s3["objects"][key(u["fid"])] = (u["replacement"], u["mime"])
    assert client.get(f"/api/reports/{rid}/versions", headers=headers).json() == before
    assert client.get(f"/api/files/{u['fid']}/download", headers=headers).status_code == 200
    assert mock_s3["objects"][sealed_key(u["fid"])][0] == u["original"]


def test_put_between_get_and_seal_cannot_replace_the_verified_snapshot(client, upload, mock_s3, monkeypatch):
    get = s3_client.get_object
    def overwrite_after_snapshot(**kwargs):
        response = get(**kwargs)
        mock_s3["objects"][key(upload["fid"])] = (PDF_B, upload["mime"])
        return response
    monkeypatch.setattr(s3_client, "get_object", overwrite_after_snapshot)
    assert complete(client, upload).status_code == 200
    assert mock_s3["objects"][sealed_key(upload["fid"])][0] == PDF_A


def test_changed_get_metadata_is_validated_not_only_head(client, upload, monkeypatch):
    get = s3_client.get_object
    def changed(**kwargs):
        response = get(**kwargs)
        response["ContentType"] = "text/html"
        return response
    monkeypatch.setattr(s3_client, "get_object", changed)
    assert complete(client, upload).status_code == 422
    with db._session() as session:
        assert session.get(FileRecordORM, upload["fid"]).state == "pending"


def test_storage_failure_does_not_complete_and_retry_recovers(client, upload, monkeypatch):
    put = s3_client.put_object
    def unavailable(**kwargs):
        raise ClientError({"Error": {"Code": "ServiceUnavailable"}}, "PutObject")
    monkeypatch.setattr(s3_client, "put_object", unavailable)
    assert complete(client, upload).status_code == 503
    with db._session() as session:
        assert session.get(FileRecordORM, upload["fid"]).state == "pending"
    monkeypatch.setattr(s3_client, "put_object", put)
    assert complete(client, upload).status_code == 200


def test_legacy_completed_id_is_sealed_on_first_read_without_schema_change(client, upload, mock_s3):
    with db._session() as session:
        session.get(FileRecordORM, upload["fid"]).state = "completed"
        session.commit()
    assert client.get(f"/api/files/{upload['fid']}/download", headers=upload["actor"].headers).status_code == 200
    mock_s3["objects"][key(upload["fid"])] = (PDF_B, upload["mime"])
    assert client.get(f"/api/files/{upload['fid']}/download", headers=upload["actor"].headers).status_code == 200
    assert mock_s3["objects"][sealed_key(upload["fid"])][0] == PDF_A


def test_concurrent_create_only_seal_preserves_the_first_snapshot(client, upload, mock_s3, monkeypatch):
    def other_wins(**kwargs):
        assert kwargs["IfNoneMatch"] == "*"
        mock_s3["objects"][kwargs["Key"]] = (PDF_B, upload["mime"])
        raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
    monkeypatch.setattr(s3_client, "put_object", other_wins)
    assert complete(client, upload).status_code == 200
    assert mock_s3["objects"][sealed_key(upload["fid"])][0] == PDF_B


@pytest.mark.parametrize("upload", ["avatar"], indirect=True)
def test_retention_queues_both_staging_and_sealed_avatar(client, upload, superuser):
    from accounts import archive
    from account_cleanup import purge
    from domain_models import AccountArchiveORM, ObjectDeletionORM
    assert complete(client, upload).status_code == 200
    archive(upload["actor"].user_id, "Leave", superuser.user_id)
    with db._session() as session:
        session.get(AccountArchiveORM, upload["actor"].user_id).archived_at = "2020-01-01T00:00:00+00:00"
        session.commit()
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 1
    with db._session() as session:
        keys = {r.object_key for r in session.query(ObjectDeletionORM)}
        assert {key(upload["fid"]), sealed_key(upload["fid"])} <= keys
