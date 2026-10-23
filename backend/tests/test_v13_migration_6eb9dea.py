"""Migration of the production schema 6eb9dea (FIX_PLAN 2.18, release 1 step 10).

A synthetic copy in the shape of the production database (legacy_6eb9dea.py) goes the
operator's way: dry-run → candidate mapping → apply → apply again. The report lists what
needs a person (A-DIR-13, A-DIR-17), VK accounts of the old site sign in after the
mapping and not before (MIGRATION-08), categories follow decision 36 (A-DIR-14,
BLOCKS-08), photos are reset by ID (decision 34) and rows without contacts are no
participants (decision 35). The app runs on the copy in its own process.
"""

import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import legacy_6eb9dea as legacy

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PROBE = Path(__file__).with_name("migrated_app_probe.py")
HR = str(uuid.uuid5(uuid.NAMESPACE_URL, "profkom:block:HR"))
APPROVED = [u for u in legacy.user_ids() if u not in legacy.PENDING_IDS]
VK_ACCOUNTS = [u for u in legacy.user_ids() if u not in legacy.PASSWORD_IDS]


def run(*args):
    import os

    # The synthetic photos and files are in the bucket «synthetic» (legacy_6eb9dea.BUCKET).
    return subprocess.run(
        [sys.executable, *map(str, args)], check=True, cwd=ROOT, capture_output=True, text=True,
        env={**os.environ, "S3_BUCKET_NAME": "synthetic"},
    )


def migrate(db, report, mapping=None, apply=True):
    args = [SCRIPTS / "migrate_v13.py", "--database", db, "--report", report]
    if apply:
        args.append("--apply")
    if mapping is not None:
        path = report.with_suffix(".mapping.json")
        path.write_text(json.dumps(mapping))
        args += ["--mapping", path]
    run(*args)
    return json.loads(report.read_text())


def probe(db, steps):
    return json.loads(run(PROBE, db, json.dumps(steps)).stdout.strip().splitlines()[-1])


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    path = tmp_path_factory.mktemp("legacy") / "legacy.db"
    legacy.build(path)
    return path


@pytest.fixture
def copy(source, tmp_path):
    shutil.copy(source, tmp_path / "copy.db")
    return tmp_path / "copy.db"


def test_dry_run_lists_what_needs_the_operator_and_changes_nothing(copy, tmp_path):
    before = sha(copy)
    report = migrate(copy, tmp_path / "dry.json", apply=False)
    assert sha(copy) == before
    u = report["unresolved"]
    assert u["chair_missing"] is True and u["legacy_super_user_ids"] == [1]
    assert u["legacy_admin_ids"] == list(legacy.ADMIN_IDS)
    assert u["hr_block_missing"] is True and u["hr_block_candidates"] == [HR]
    assert [e["user_id"] for e in u["vk_only"]] == VK_ACCOUNTS
    assert Counter(e["evidence"] for e in u["vk_only"]) == {"vk_link": 63, "vk_link_and_email": 12, "none": 4}
    by_user = {e["user_id"]: e for e in u["vk_only"]}
    assert by_user[10] == dict(user_id=10, state="active", vk_user_id="500000010", evidence="vk_link_and_email")
    assert by_user[30]["state"] == "pending" and by_user[82]["vk_user_id"] is None
    assert u["vk_id_shared"] == [] and u["email_case_groups"] == [] and u["incomplete_user_ids"] == []
    blocks = {b["legacy_name"]: b for b in u["unmapped_blocks"]}
    assert len(blocks) == 20 and blocks["HR"]["block_id"] == HR
    assert blocks["Медиа"]["legacy_master"] == "Тимур Тёзкин" and blocks["Медиа"]["candidate_user_ids"] == [40, 41]
    assert blocks["Танцы"]["candidate_user_ids"] == [] and blocks["IT"]["candidate_user_ids"] == [1]
    assert u["ambiguous_vk_copy"] == VK_ACCOUNTS
    assert u["without_documented_participation"] == APPROVED
    assert len(report["guides"]["with_guide"]) == 11 and len(report["guides"]["placeholder"]) == 9
    assert report["categories"] == dict(planned=True, activist=APPROVED, junior=list(legacy.PENDING_IDS))
    # IDs and the legacy master strings only: no address or phone reaches the report.
    text = json.dumps(report, ensure_ascii=False)
    for private in ("@example.com", "@vk.com", "+7000", "vk.com/id"):
        assert private not in text


def test_candidate_proposes_only_what_the_data_proves(copy, tmp_path):
    with sqlite3.connect(copy) as c:  # two accounts name one VK: neither is proposed
        c.execute("UPDATE contact_info SET vk=(SELECT vk FROM contact_info WHERE user_id=51) WHERE user_id=50")
    before = sha(copy)
    out, review = tmp_path / "candidate.json", tmp_path / "review.json"
    run(SCRIPTS / "mapping_candidate.py", "--database", copy, "--out", out, "--review", review)
    assert sha(copy) == before
    mapping, notes = json.loads(out.read_text()), json.loads(review.read_text())
    assert sorted(mapping) == ["chair_user_id", "hr_block_id", "vk_identities"]
    assert mapping["chair_user_id"] == 1 and mapping["hr_block_id"] == HR
    proposed = {v["user_id"]: v["vk_user_id"] for v in mapping["vk_identities"]}
    assert sorted(proposed) == [u for u in legacy.VK_LINK_IDS if u not in (50, 51)]
    assert all(proposed[u] == legacy.vk_id(u) for u in proposed)
    vk = notes["vk_identities"]
    assert vk["by_evidence"] == {"vk_link_and_email": 12, "vk_link": 61}
    assert vk["without_vk_id"] == list(legacy.MANUAL_IDS) and vk["pending_user_ids"] == [30, 60, 83, 85]
    assert vk["shared"] == [dict(vk_user_id=legacy.vk_id(51), user_ids=[50, 51])]
    assert notes["not_proposed"]["unmapped_blocks"] == 20


def test_apply_with_the_candidate_opens_the_site_to_its_people(copy, tmp_path):
    dry = migrate(copy, tmp_path / "dry.json", apply=False)
    out = tmp_path / "candidate.json"
    run(SCRIPTS / "mapping_candidate.py", "--database", copy, "--out", out, "--review", tmp_path / "review.json")
    mapping = json.loads(out.read_text())
    first = migrate(copy, tmp_path / "apply.json", mapping)
    second = migrate(copy, tmp_path / "again.json", mapping)

    # The first apply found what the dry-run predicted from the old schema.
    assert first["initial_report"]["unresolved"] == dry["unresolved"]
    assert first["applied_mapping"] == mapping
    u = first["unresolved"]
    assert u["chair_missing"] is False and u["hr_block_missing"] is False
    assert [e["user_id"] for e in u["vk_only"]] == list(legacy.MANUAL_IDS)
    assert len(u["unmapped_blocks"]) == 20  # masters are assigned by hand after the release (УВ-1)
    assert u["ambiguous_vk_copy"] == VK_ACCOUNTS and u["without_documented_participation"] == APPROVED
    assert first["schema"] == dict(missing_columns={}, missing_indexes=[])
    assert first["categories"]["activist"] == APPROVED and first["categories"]["junior"] == list(legacy.PENDING_IDS)
    assert first["after"]["integrity"] == "ok"
    # A repeat changes nothing but the record of the repeated mapping.
    for key in ("unresolved", "initial_report", "categories", "guides", "schema"):
        assert second[key] == first[key], key
    counts = lambda r: {k: v for k, v in r["after"]["counts"].items() if k != "audit_logs"}  # noqa: E731
    assert counts(second) == counts(first)
    for table, n in dict(users=85, contact_info=85, guides=12, pgas_entries=42, refresh_tokens=304,
                         external_identities=75, memberships=85).items():
        assert first["after"]["counts"][table] == n, table

    with sqlite3.connect(copy) as c:
        assert c.execute("SELECT chair_user_id FROM leadership").fetchall() == [(1,)]
        assert c.execute("SELECT name FROM block WHERE is_hr").fetchall() == [("HR",)]
        states = dict(c.execute("SELECT account_state || '/' || category, COUNT(*) FROM users GROUP BY 1"))
        assert states == {"active/activist": 80, "pending/junior": 5}
        rows = c.execute("SELECT category, observed_since IS NOT NULL, COUNT(*) FROM memberships GROUP BY 1, 2").fetchall()
        assert rows == [("junior", 0, 5), ("member", 1, 80)]
        assert c.execute(
            "SELECT COUNT(*) FROM audit_logs WHERE target_kind='participant_category'"
        ).fetchone() == (80,)
        assert c.execute("SELECT 1 FROM sqlite_master WHERE name='v13_contact_email_lower'").fetchone()

    it = next(b["block_id"] for b in first["blocks"] if b["legacy_name"] == "IT")
    answers = probe(copy, [
        {"op": "users"},
        {"op": "vk", "vk_id": legacy.vk_id(10)},
        {"op": "vk", "vk_id": legacy.vk_id(30)},
        {"op": "users"},
        {"op": "get", "as": 10, "path": "/api/participants/10/category"},
        {"op": "get", "as": 1, "path": f"/api/blocks/{it}"},
        {"op": "get", "as": 1, "path": "/api/registrations"},
    ])
    assert answers[0] == answers[3] == 85
    assert answers[1] == dict(status=200, user_id=10) and answers[2] == dict(status=200, user_id=30)
    assert answers[4]["json"]["category"] == "activist"
    members = {m["user"]["user_id"]: m["block_category"] for m in answers[5]["json"]["members"]}
    assert members and set(members.values()) == {"member"}
    assert answers[6]["status"] == 200  # the mapped chair reviews registrations


def test_vk_login_before_the_mapping_creates_no_second_account(copy, tmp_path):
    migrate(copy, tmp_path / "apply.json")
    answers = probe(copy, [
        {"op": "vk", "vk_id": legacy.vk_id(10)},
        {"op": "vk", "vk_id": legacy.vk_id(30)},
        {"op": "users"},
        {"op": "get", "as": 10, "path": "/api/session"},
    ])
    for refused in answers[:2]:
        assert refused["status"] == 409 and "linked" in refused["detail"]
    assert answers[2] == 85
    assert answers[3]["json"]["registration_status"] == "approved"  # the account itself is intact


def test_photos_are_reset_by_id_and_categories_set_by_mapping(copy, tmp_path):
    first = migrate(copy, tmp_path / "apply.json")
    with sqlite3.connect(copy) as c:  # the files of the old bucket are adopted before the reset of 13
        own = c.execute("SELECT photo_url FROM users WHERE user_id=12").fetchone()[0]
    run(SCRIPTS / "adopt_legacy_files.py", "--database", copy, "--apply")
    mapping = dict(
        reset_avatars=[10, 13],
        categories=[dict(user_id=11, category="junior", reason="Пришёл в этом сезоне")],
    )
    migrate(copy, tmp_path / "mapped.json", mapping)
    again = migrate(copy, tmp_path / "again.json", mapping)
    assert again["applied_mapping"] == dict(reset_avatars=[10, 13], categories=[dict(user_id=11, category="junior")])
    assert "Пришёл" not in json.dumps(again, ensure_ascii=False)
    assert [u for u in first["unresolved"]["ambiguous_vk_copy"] if u not in (10, 13)] == again["unresolved"]["ambiguous_vk_copy"]
    with sqlite3.connect(copy) as c:
        for uid in (10, 13):
            assert c.execute("SELECT photo_url FROM users WHERE user_id=?", (uid,)).fetchone() == (None,)
            assert c.execute("SELECT preset_id, avatar_file_id FROM profile_metadata WHERE user_id=?", (uid,)).fetchone() == ("default", None)
        assert c.execute("SELECT photo_url FROM users WHERE user_id=12").fetchone() == (own,)
        assert c.execute("SELECT category FROM users WHERE user_id=11").fetchone() == ("junior",)
        audits = c.execute(
            "SELECT target_kind, COUNT(*) FROM audit_logs WHERE target_id IN ('10','11','13') AND target_kind IN ('avatar','participant_category') GROUP BY 1"
        ).fetchall()
        assert audits == [("avatar", 2), ("participant_category", 4)]  # 10, 11, 13 by rule, then 11 by mapping
    contacts = probe(copy, [{"op": "get", "as": 1, "path": "/api/contacts"}])[0]["json"]
    avatars = {p["user_id"]: p["photo_url"] for p in contacts}
    assert avatars[10] == avatars[13] == "/avatars/default.svg"
    assert avatars[12].startswith("/api/files/")


def test_rows_the_production_base_lacks_are_reported(tmp_path):
    db = tmp_path / "extra.db"
    legacy.build(db, extra=("orphan", "case"))
    dry = migrate(db, tmp_path / "dry.json", apply=False)
    assert dry["unresolved"]["incomplete_user_ids"] == [900]
    assert dry["unresolved"]["email_case_groups"] == [[20, 21]]
    report = migrate(db, tmp_path / "apply.json", dict(chair_user_id=1))
    assert report["unresolved"]["incomplete_user_ids"] == [900]
    assert report["unresolved"]["email_case_groups"] == [[20, 21]]
    # The index waits until the pair is resolved; the site works meanwhile.
    assert report["schema"]["missing_indexes"] == ["v13_contact_email_lower"]
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT account_state FROM users WHERE user_id=900").fetchone() == ("pending",)
        assert c.execute("SELECT COUNT(*) FROM participation_intervals WHERE user_id=900").fetchone() == (0,)
    answers = probe(db, [{"op": "get", "as": 1, "path": "/api/profile/900"}, {"op": "get", "as": 1, "path": "/api/contacts"}])
    assert answers[0]["status"] == 404
    assert 900 not in {p["user_id"] for p in answers[1]["json"]}


def test_a_database_migrated_before_observed_since_takes_it_from_the_report(copy, tmp_path):
    """A copy migrated by the code before step 10 has no column: startup adds it and moves
    the observation of the migration report onto the rows (A-DIR-18)."""
    migrate(copy, tmp_path / "apply.json")
    with sqlite3.connect(copy) as c:
        observed = json.loads(c.execute(
            "SELECT report_json FROM domain_migrations WHERE version='v13-observed-participation'"
        ).fetchone()[0])["memberships_observed_since"]
        c.execute("ALTER TABLE memberships DROP COLUMN observed_since")
    again = migrate(copy, tmp_path / "again.json")
    assert again["schema"] == dict(missing_columns={}, missing_indexes=[])
    with sqlite3.connect(copy) as c:
        rows = dict(c.execute("SELECT membership_id, observed_since FROM memberships WHERE observed_since IS NOT NULL"))
    assert rows == observed and len(rows) == 80


def test_schema_check_names_what_a_database_lacks(source):
    sys.path.insert(0, str(SCRIPTS))
    import migrate_v13

    gaps = migrate_v13.schema_gaps(source)
    assert {"account_state", "category", "must_change_password", "session_version"} <= set(gaps["missing_columns"]["users"])
    assert {"sealed_at", "storage_key"} <= set(gaps["missing_columns"]["file_records"])
    assert "observed_since" in gaps["missing_columns"]["memberships"]
    assert "v13_contact_email_lower" in gaps["missing_indexes"]


def test_a_roster_row_is_observed_from_the_approval_and_counts_block_tenure(client, superuser, make_block):
    """A-DIR-18: a legacy applicant in a roster, approved after the migration, earns block
    tenure like everyone else (MIGRATION-10: block_days 0.0 before)."""
    from database import db
    from domain_models import MembershipORM
    from membership import block_id_for
    from participation import participation_seconds
    from test_v13_registration import signup

    h, application = signup(client)
    uid = application["user_id"]
    name = f"Наблюдение {uuid.uuid4().hex[:6]}"
    make_block(name=name, arr_of_human=[uid], cnt_of_human=1)
    bid = block_id_for(name)
    assert client.get(f"/api/blocks/{bid}", headers=superuser.headers).status_code == 200
    with db._session() as s:
        row = s.query(MembershipORM).filter_by(user_id=uid, block_id=bid).one()
        assert (row.category, row.joined_at, row.observed_since) == ("junior", None, None)
    approved = client.post(f"/api/registrations/{uid}/approve", headers=superuser.headers,
                           json={"expected_revision": application["revision"]})
    assert approved.status_code == 200, approved.text
    now = datetime.now(timezone.utc)
    window = ((now - timedelta(days=1)).isoformat(), (now + timedelta(days=30)).isoformat(), (now + timedelta(days=30)).isoformat())
    with db._session() as s:
        row = s.query(MembershipORM).filter_by(user_id=uid, block_id=bid).one()
        assert row.observed_since is not None and row.joined_at is None
        observed_since = row.observed_since
    # Reading the block seeds the roster again; the row and its start stay.
    assert client.get(f"/api/blocks/{bid}", headers=superuser.headers).status_code == 200
    with db._session() as s:
        row = s.query(MembershipORM).filter_by(user_id=uid, block_id=bid).one()
        assert row.observed_since == observed_since
        overall = participation_seconds(s, f"participant-{uid}", *window)
        in_block = participation_seconds(s, f"participant-{uid}", *window, block_id=bid)
    assert overall > 29 * 86400 and in_block == pytest.approx(overall, abs=5)


def test_a_roster_row_added_after_the_migration_is_observed_from_now(client, superuser, make_user, make_block):
    from database import db
    from domain_models import MembershipORM
    from membership import block_id_for

    member = make_user()
    name = f"Состав {uuid.uuid4().hex[:6]}"
    make_block(name=name, arr_of_human=[member.user_id], cnt_of_human=1)
    bid = block_id_for(name)
    before = datetime.now(timezone.utc)
    assert client.get(f"/api/blocks/{bid}", headers=superuser.headers).status_code == 200
    with db._session() as s:
        row = s.query(MembershipORM).filter_by(user_id=member.user_id, block_id=bid).one()
        assert row.category == "junior" and row.joined_at is None
        assert datetime.fromisoformat(row.observed_since) >= before
