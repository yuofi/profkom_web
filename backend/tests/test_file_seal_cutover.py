import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException
from database import db, FileRecordORM
from file_access import key, sealed_key
from scripts.seal_completed_files import seal_completed
from test_local_file_integrity import upload, PDF_A, PDF_B
from utils.s3_service import s3_client


def test_seal_dry_run_is_read_only_without_runtime_imports(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.executescript("CREATE TABLE file_records(file_id TEXT, state TEXT); INSERT INTO file_records VALUES ('old-id','completed'), ('pending','pending');")
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    script = Path(__file__).resolve().parents[1] / "scripts/seal_completed_files.py"
    result = subprocess.run([sys.executable, str(script), "--database", str(path)], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == dict(mode="dry-run", completed=1, external_calls=False)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_batch_seal_is_repeatable_and_preserves_old_ids(upload, mock_s3):
    with db._session() as session:
        session.get(FileRecordORM, upload["fid"]).state = "completed"
        session.commit()
    assert seal_completed() == 1
    mock_s3["objects"][key(upload["fid"])] = (PDF_B, upload["mime"])
    assert seal_completed() == 1
    assert mock_s3["objects"][sealed_key(upload["fid"])][0] == PDF_A


def test_batch_seal_failure_is_visible_and_can_resume(upload, monkeypatch, mock_s3):
    with db._session() as session:
        session.get(FileRecordORM, upload["fid"]).state = "completed"
        session.commit()
    put = s3_client.put_object
    def unavailable(**kwargs):
        raise ClientError({"Error": {"Code": "ServiceUnavailable"}}, "PutObject")
    monkeypatch.setattr(s3_client, "put_object", unavailable)
    with pytest.raises(HTTPException) as failure:
        seal_completed()
    assert failure.value.status_code == 503
    monkeypatch.setattr(s3_client, "put_object", put)
    assert seal_completed() == 1
    assert mock_s3["objects"][sealed_key(upload["fid"])][0] == PDF_A
