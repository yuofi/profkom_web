"""Rehearse additive migration from the committed schema, including import order."""
import io
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile

import pytest


@pytest.mark.parametrize("first", ["main", "database", "access", "auth"])
def test_previous_committed_schema_twice_preserves_accounting(tmp_path, first):
    root = Path(__file__).resolve().parents[2]
    old = tmp_path / "committed-source"
    old.mkdir()
    archived = subprocess.run(["git", "archive", "HEAD", "backend"], cwd=root, capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archived)) as archive:
        archive.extractall(old, filter="data")
    database = tmp_path / "legacy.db"
    env = {**os.environ, "DATABASE_PATH": str(database), "APP_ENV": "test", "ADMIN_NAME": "", "ADMIN_PASSWORD": ""}
    # ORM defaults belong to the OLD committed source, not the working tree.
    seed = '''
import main
from database import db,SeasonORM,TaskORM,TaskTrackerORM,AssignmentORM,ContributionORM,EventORM,ReportSeriesORM
from event_workspace_models import EventWorkspaceMetaORM
from models import User,ContactInfo,Block
u=db.create_user_with_contact(ContactInfo(0,"migration@example.com",name="Synthetic"),User(0,"synthetic-no-login"))
db.create_block(Block(name="Synthetic",master="",master_user_id=u.user_id))
with db._session() as s:
 s.add(SeasonORM(season_id="legacy-season",title="Frozen",sequence_number=1,type="autumn_winter",starts_at="2025-01-01T00:00:00Z",ends_at="2025-12-31T00:00:00Z",state="closed"))
 s.add(ReportSeriesORM(series_id="legacy-series",owner_kind="event",title="Synthetic"));s.flush()
 s.add(EventORM(event_id="legacy-event",season_id="legacy-season",title="Synthetic",report_series_id="legacy-series",starts_at="2025-01-01T00:00:00Z",ends_at="2025-02-01T00:00:00Z"))
 s.add(EventWorkspaceMetaORM(owner_kind="event",owner_id="legacy-event",all_day=False,announcement="Keep announcement"))
 s.add(TaskORM(task_id="legacy-task",season_id="legacy-season",scope_kind="block",scope_id="Synthetic",title="Keep title",description_json='{"format":"markdown","body":"Keep description"}',assigned_at="2025-01-02T00:00:00Z",deadline_at="2025-01-04T00:00:00Z",created_by_user_id=u.user_id,created_at="2025-01-02T00:00:00Z"));s.flush()
 s.query(TaskTrackerORM).filter_by(task_id="legacy-task").one().status="accepted"
 s.add(AssignmentORM(assignment_id="legacy-assignment",task_id="legacy-task",assignee_user_id=u.user_id,status="accepted",hours=4,evaluation=1.5,effective_completed_at="2025-01-03T00:00:00Z",created_at="2025-01-02T00:00:00Z"))
 s.add(ContributionORM(contribution_id="legacy-credit",season_id="legacy-season",participant_id="participant-1",user_id=u.user_id,source_kind="block_task",source_id="Synthetic",source_title="Keep source",score=17.25,calculation_version="task_v1",assignment_id="legacy-assignment",created_at="2025-01-03T00:00:00Z"))
 s.commit()
'''
    initialized = subprocess.run([sys.executable, "-c", seed], cwd=old / "backend", env=env, capture_output=True, text=True)
    assert initialized.returncode == 0, initialized.stderr[-3000:]
    with sqlite3.connect(database) as connection:
        before_assignment = connection.execute("SELECT * FROM assignments WHERE assignment_id='legacy-assignment'").fetchone()
        before_credit = connection.execute("SELECT * FROM contributions WHERE contribution_id='legacy-credit'").fetchone()
        before_task = connection.execute("SELECT * FROM tasks WHERE task_id='legacy-task'").fetchone()
    program = f"import {first}; import main; import database; import access; import auth"
    observed = []
    for _ in range(2):
        imported = subprocess.run([sys.executable, "-c", program], cwd=root / "backend", env=env, capture_output=True, text=True)
        assert imported.returncode == 0, imported.stderr[-4000:]
        with sqlite3.connect(database) as connection:
            assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            assert before_assignment == connection.execute("SELECT * FROM assignments WHERE assignment_id='legacy-assignment'").fetchone()
            assert before_credit == connection.execute("SELECT * FROM contributions WHERE contribution_id='legacy-credit'").fetchone()
            assert before_task == connection.execute("SELECT * FROM tasks WHERE task_id='legacy-task'").fetchone()
            assert connection.execute("SELECT closed_at FROM task_tracker WHERE task_id='legacy-task'").fetchone()[0] is None
            assert connection.execute("SELECT is_closed,closed_at FROM event_workspace_metadata WHERE owner_id='legacy-event'").fetchone() == (0, None)
            for table in ["task_mention_requests", "task_access_grants", "season_coefficients", "kkr_control_epics"]:
                connection.execute("SELECT COUNT(*) FROM " + table).fetchone()
            observed.append({name: connection.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0]
                             for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")})
    assert observed[0] == observed[1]
