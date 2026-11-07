"""KKR templates after the owner's edits of 2026-11-08: author and last editor (B2), and the
refusals of a save that name the template rather than the record (B6)."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

from database import db, MeritORM
from models import Block
from profile_features_models import KkrTemplateORM, KkrTemplateUseORM
from test_profile_features import ok, request, template


def test_a_template_names_its_author_and_whoever_saved_it_last(client, superuser, make_user):
    master = make_user()
    db.create_block(Block(name="Authored templates", master=""))
    db.set_block_leader("Authored templates", master.user_id)
    block = ok(request(client, master, "get", "/blocks/Authored templates"))
    created = template(client, master, visibility="team", scope_kind="block", scope_id=block["block_id"])
    assert created["author"]["user_id"] == master.user_id and created["updated_by"]["user_id"] == master.user_id
    assert "created_at" not in created
    changed = ok(request(client, superuser, "patch", f"/kkr-templates/{created['template_id']}",
                         dict(expected_revision=1, values={**created["values"], "hours": 5}, archived=False)))
    assert changed["author"]["user_id"] == master.user_id and changed["updated_by"]["user_id"] == superuser.user_id
    listed = ok(request(client, master, "get", "/kkr-templates"))["items"]
    assert [(row["author"]["user_id"], row["updated_by"]["user_id"]) for row in listed] == [(master.user_id, superuser.user_id)]
    with db._session() as session:
        from profile_features import anonymize
        anonymize(session, superuser.user_id, f"participant-{superuser.user_id}", "anonymous-editor")
        session.commit()
        assert session.get(KkrTemplateORM, created["template_id"]).updated_by_user_id is None
    after = ok(request(client, master, "get", "/kkr-templates"))["items"][0]
    assert after["author"]["user_id"] == master.user_id
    assert after["updated_by"] == {"user_id": None, "display_name": "Бывший участник", "avatar_url": None}


def _season_and_merit(client, superuser, recipient):
    stamp = datetime.now(timezone.utc)
    season = ok(request(client, superuser, "post", "/seasons", dict(title="Сезон шаблонов", type="autumn_winter",
        starts_at=(stamp-timedelta(days=2)).isoformat(), ends_at=(stamp+timedelta(days=20)).isoformat())))
    ok(request(client, superuser, "post", f"/seasons/{season['season_id']}/open", dict(expected_revision=season["revision"])))
    return dict(season_id=season["season_id"], source_kind="chair_merit", title="Работа", description="Текст",
                assigned_at=(stamp-timedelta(days=1)).isoformat(), deadline_at=(stamp+timedelta(days=1)).isoformat(),
                recipients=[dict(user_id=recipient.user_id, hours=3, evaluation=1, completed_at=stamp.isoformat())])


def _code(response):
    return response.status_code, response.json()["detail"]["code"]


def test_a_save_refused_for_its_template_names_the_template_and_saves_nothing(client, superuser, make_user):
    recipient, master = make_user(), make_user()
    data = _season_and_merit(client, superuser, recipient)
    row = template(client, superuser)
    prepared = ok(request(client, superuser, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=1)))
    ok(request(client, superuser, "patch", f"/kkr-templates/{row['template_id']}", dict(expected_revision=1, values={**row["values"], "hours": 9})))
    # Edited after «Подставить»: its own code, not a conflict of the record.
    assert _code(request(client, superuser, "post", "/merits", {**data, "template_selection": prepared["selection"]})) == (409, "template_changed")
    archived = template(client, superuser)
    ok(request(client, superuser, "patch", f"/kkr-templates/{archived['template_id']}", dict(expected_revision=1, values=archived["values"], archived=True)))
    assert _code(request(client, superuser, "post", "/merits", {**data, "template_selection": dict(template_id=archived["template_id"], revision=2)})) == (409, "template_archived")
    db.create_block(Block(name="Foreign template team", master=""))
    db.set_block_leader("Foreign template team", master.user_id)
    block = ok(request(client, master, "get", "/blocks/Foreign template team"))
    personal = template(client, master)
    assert _code(request(client, superuser, "post", "/merits", {**data, "template_selection": dict(template_id=personal["template_id"], revision=1)})) == (404, "template_unavailable")
    team = template(client, master, visibility="team", scope_kind="block", scope_id=block["block_id"])
    assert _code(request(client, superuser, "post", "/merits", {**data, "template_selection": dict(template_id=team["template_id"], revision=1)})) == (422, "template_scope_mismatch")
    with db._session() as session:
        assert session.query(MeritORM).count() == 0 and session.query(KkrTemplateUseORM).count() == 0
    # The same save without the template link goes through.
    merit = ok(request(client, superuser, "post", "/merits", data))
    assert merit["recipients"][0]["hours"] == 3
    # «Подставить» from a stale list stays an ordinary version conflict of the template.
    stale = request(client, superuser, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=1))
    assert _code(stale) == (409, "revision_conflict")


def test_an_old_template_table_gains_its_last_editor_twice(tmp_path):
    path = tmp_path / "old-templates.db"
    root = Path(__file__).resolve().parents[1]
    env = {**__import__("os").environ, "DATABASE_PATH": str(path)}
    subprocess.run([sys.executable, "-c", "import database"], cwd=root, env=env, check=True, capture_output=True)
    with sqlite3.connect(path) as c:
        c.execute("ALTER TABLE kkr_templates DROP COLUMN updated_by_user_id")
        for template_id, owner, revision in (("edited", 7, 2), ("untouched", 8, 1), ("forgotten", 9, 3), ("silent", 10, 1)):
            c.execute("INSERT INTO kkr_templates (template_id, owner_user_id, visibility, title, values_json, revision, archived, created_at) "
                      "VALUES (?, ?, 'personal', 'T', '{}', ?, 0, '2026-10-01T00:00:00+00:00')", (template_id, owner, revision))
        audit = [("edited", 7, "KKR template created"), ("edited", 11, "KKR template changed"), ("untouched", 8, "KKR template created"),
                 ("forgotten", 9, "KKR template created"), ("forgotten", 0, "KKR template changed")]
        for target, actor, reason in audit:
            c.execute("INSERT INTO audit_logs (target_kind, target_id, changed_by_user_id, reason, old_values_json, new_values_json, created_at) "
                      "VALUES ('kkr_template', ?, ?, ?, '{}', '{}', '2026-10-02T00:00:00+00:00')", (target, actor, reason))
    script = ("import json, database; from sqlalchemy import text; c = database.engine.connect(); "
              "rows = dict(c.execute(text('SELECT template_id, updated_by_user_id FROM kkr_templates')).all()); "
              "count = sum(1 for r in c.execute(text('PRAGMA table_info(kkr_templates)')) if r[1] == 'updated_by_user_id'); "
              "c.close(); print(json.dumps([rows, count]))")
    for _ in range(2):
        out = subprocess.run([sys.executable, "-c", script], cwd=root, env=env, check=True, capture_output=True, text=True)
        rows, count = json.loads(out.stdout.strip().splitlines()[-1])
        # The latest audited actor; the author when nothing was audited; unknown when the editor was removed.
        assert count == 1 and rows == {"edited": 11, "untouched": 8, "forgotten": None, "silent": 10}
    with sqlite3.connect(path) as c:
        assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"
