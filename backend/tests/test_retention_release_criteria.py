"""Only disposable conftest databases: complete retention and closed accounting."""
from datetime import datetime, timezone
import json
import uuid

import pytest
from sqlalchemy import Column, String, Table

from account_cleanup import purge
from database import (Base, db, UserORM, ContactInfoORM, AssignmentORM, ContributionORM,
    ReportORM, ReportVersionORM, MasterBonusORM, AuditLogORM)
from domain_models import AccountArchiveORM, FormerContactORM, SummaryVersionORM, MaterialORM
from membership import set_membership
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def archive(client, chair, person):
    ok(client.post(f"/api/accounts/{person.user_id}/archive", headers=chair.headers, json={"reason": "Synthetic archive"}))
    with db._session() as session:
        session.get(AccountArchiveORM, person.user_id).archived_at = "2020-01-01T00:00:00+00:00"
        session.commit()


def snapshot():
    with db._session() as session:
        return {table.name: sorted([tuple(row) for row in session.execute(table.select())], key=repr)
                for table in Base.metadata.sorted_tables}


def frozen_numbers():
    """Every numeric accounting value, revision and date survives identity redaction."""
    def numeric(value, path=()):
        if isinstance(value, dict):
            return {key: numeric(item, (*path, key)) for key, item in value.items()
                    if key not in {"user_id", "recipient_user_id", "actor", "actor_user_id", "changed_by_user_id"}}
        if isinstance(value, list):
            return [numeric(item, (*path, index)) for index, item in enumerate(value)]
        return value if isinstance(value, (int, float, bool)) else None
    with db._session() as session:
        result = {}
        for name in ("contributions", "master_bonuses", "season_summaries", "summary_versions", "season_decisions"):
            table = Base.metadata.tables[name]
            rows = []
            for record in session.execute(table.select()).mappings():
                rows.append({key: numeric(json.loads(value)) if key.endswith("_json") else value
                    for key, value in record.items() if key.endswith("_json") or key in {
                        "score", "amount", "eligible_organizer_count", "version", "previous_summary_version",
                        "revision", "created_at", "approved_at", "calculation_version"}})
            result[name] = rows
        return result


def test_twenty_one_identities_reports_namesakes_and_anonymous_bonus_survive_correction(
    client, work, superuser, make_user
):
    # Fixed small IDs intentionally include participant-2 and participant-20/21.
    actors = [make_user(password=None) for _ in range(17)]
    assert work["master"].user_id == 2 and actors[-2].user_id == 20 and actors[-1].user_id == 21
    block_id = work["block"]["block_id"]
    with db.atomic():
        with db._session() as session:
            for actor in actors[-2:]:
                set_membership(session, actor.user_id, block_id, True, superuser.user_id, "Synthetic membership")
                session.flush()
            for actor in [work["master"], *actors[-2:]]:
                contact = session.get(ContactInfoORM, actor.user_id)
                contact.name, contact.surname, contact.kkr_name = "Same", "Namesake", "Same Namesake"
            session.commit()
    accept(client, work)
    tasks = {}
    for actor, hours in zip(actors[-2:], [4, 6]):
        task = ok(client.post("/api/tasks", headers=work["master"].headers,
            json={**work["payload"], "title": f"Work of {actor.user_id}", "assignees": [{"user_id": actor.user_id, "hours": hours}]}))
        accept(client, {"task": task, "master": work["master"], "member": actor})
        tasks[actor.user_id] = task
    sid = work["season"]["season_id"]
    event = ok(client.post("/api/events", headers=superuser.headers,
        json={"season_id": sid, "title": "Retention report", "description": ""}))
    ok(client.put(f"/api/events/{event['event_id']}/leaders", headers=superuser.headers,
        json={"expected_revision": event["revision"], "user_ids": [work["master"].user_id]}))
    body = "# Same Namesake\nKeep participant-2 / participant-20 and contact text verbatim."
    for kind in ["final", "regular"]:
        report = ok(client.post("/api/reports", headers=work["master"].headers, json={
            "owner_kind": "event", "owner_id": event["event_id"], "kind": kind,
            "title": kind, "content": body, "file_ids": []}))
        if kind == "final":
            ok(client.post(f"/api/reports/{report['report_id']}/publish", headers=work["master"].headers,
                json={"expected_revision": report["revision"]}))
    material = ok(client.post("/api/materials", headers=superuser.headers,
        json={"kind": "general", "title": "Independent text", "description": "", "content": {"format": "markdown", "body": body}}))
    frozen = close(client, work, superuser)
    numbers_before = frozen_numbers()
    with db._session() as session:
        reports_before = [(row.report_id, row.content_json, row.draft_content_json) for row in session.query(ReportORM)]
        versions_before = [(row.id, row.content_json) for row in session.query(ReportVersionORM)]
        material_before = session.get(MaterialORM, material["material_id"]).draft_body
        bonus_before = session.query(MasterBonusORM).filter_by(season_id=sid, block_id="IT").one()
        numeric_bonus = (bonus_before.amount, bonus_before.eligible_organizer_count)
    archive(client, superuser, work["master"])
    archive(client, superuser, work["member"])
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 2
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 0
    assert frozen_numbers() == numbers_before
    with db._session() as session:
        master_pid = session.get(AccountArchiveORM, 2).anonymous_participant_id
        member_pid = session.get(AccountArchiveORM, 3).anonymous_participant_id
        assert [(row.report_id, row.content_json, row.draft_content_json) for row in session.query(ReportORM)] == reports_before
        assert [(row.id, row.content_json) for row in session.query(ReportVersionORM)] == versions_before
        assert session.get(MaterialORM, material["material_id"]).draft_body == material_before
        assert session.query(FormerContactORM).filter(FormerContactORM.source_user_id.is_(None)).count() == 2
        assert session.query(ContactInfoORM).filter(ContactInfoORM.user_id.in_([2, 3])).count() == 0
        for version in session.query(SummaryVersionORM).filter_by(season_id=sid):
            rows = json.loads(version.summary_json)["rows"]
            assert {row["participant_id"] for row in rows if row["user"]["user_id"] in (20, 21)} == {"participant-20", "participant-21"}
            assert all(row["user"]["display_name"] == "Namesake Same" for row in rows if row["user"]["user_id"] in (20, 21))
    current = ok(client.get(f"/api/seasons/{sid}/summary", headers=superuser.headers))
    assert next(row for row in current["rows"] if row["participant_id"] == master_pid)["total_score"] == next(
        row for row in frozen["rows"] if row["user"]["user_id"] == 2)["total_score"]
    changed = ok(client.put(f"/api/seasons/{sid}/summary/decisions/21", headers=superuser.headers,
        json={"expected_version": current["version"], "decisions": ["nice"], "reason": "No accounting change"}))
    bonus = ok(client.get(f"/api/seasons/{sid}/master-bonuses", headers=superuser.headers))["items"][0]
    assert (bonus["amount"], bonus["eligible_organizer_count"]) == numeric_bonus
    assert bonus["recipient_participant_id"] == master_pid
    assert any(item["participant_id"] == member_pid and item["included"] for item in bonus["basis"])
    aid = tasks[20]["assignments"][0]["assignment_id"]
    inputs = ok(client.get(f"/api/assignments/{aid}/assessment-inputs", headers=superuser.headers))
    corrected = ok(client.post(f"/api/seasons/{sid}/summary/correct", headers=superuser.headers,
        json={"expected_version": changed["version"], "reason": "Actual hours correction", "changes": [
            {"kind": "assessment_inputs", "id": aid, "expected_revision": inputs["revision"], "values": {"hours": 8}}]}))
    assert any(row["participant_id"] == master_pid for row in corrected["rows"])
    bonus = ok(client.get(f"/api/seasons/{sid}/master-bonuses", headers=superuser.headers))["items"][0]
    assert bonus["eligible_organizer_count"] == 3 and bonus["amount"] > numeric_bonus[0]
    assert any(item["participant_id"] == member_pid and item["included"] for item in bonus["basis"])


def test_cleanup_batch_rolls_back_all_people_after_callback_failure(client, superuser, make_user, monkeypatch):
    people = [make_user(password=None), make_user(password=None)]
    for actor in people:
        archive(client, superuser, actor)
    import profile_features
    original = profile_features.anonymize
    def fail_second(session, uid, old_pid, new_pid):
        original(session, uid, old_pid, new_pid)
        if uid == people[1].user_id:
            raise RuntimeError("Injected retention failure")
    monkeypatch.setattr(profile_features, "anonymize", fail_second)
    before = snapshot()
    with pytest.raises(RuntimeError, match="Injected"):
        purge("2024-01-01T00:00:00+00:00", False)
    assert snapshot() == before


def test_old_uncompleted_assignment_gaining_hours_after_purge_keeps_anonymous_identity(client, work, superuser):
    aid = work["task"]["assignments"][0]["assignment_id"]
    # Valid old-schema state: not_completed can close with no recorded hours,
    # and therefore has no contribution to update in place after retention.
    with db._session() as session:
        session.get(AssignmentORM, aid).hours = None
        session.commit()
    before = ok(client.get(f"/api/assignments/{aid}/assessment-inputs", headers=superuser.headers))
    ok(client.post(f"/api/assignments/{aid}/not-complete", headers=superuser.headers,
        json={"expected_revision": before["workflow_revision"], "evaluation": -1, "reason": "Observed old incomplete work"}))
    frozen = close(client, work, superuser)
    sid = work["season"]["season_id"]
    with db._session() as session:
        assert session.query(ContributionORM).filter_by(assignment_id=aid).count() == 0
    archive(client, superuser, work["member"])
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 1
    current = ok(client.get(f"/api/assignments/{aid}/assessment-inputs", headers=superuser.headers))
    corrected = ok(client.post(f"/api/seasons/{sid}/summary/correct", headers=superuser.headers,
        json={"expected_version": frozen["version"], "reason": "Documented missing hours", "changes": [
            {"kind": "assessment_inputs", "id": aid, "expected_revision": current["revision"], "values": {"hours": 2}}]}))
    with db._session() as session:
        pid = session.get(AccountArchiveORM, work["member"].user_id).anonymous_participant_id
        contribution = session.query(ContributionORM).filter_by(assignment_id=aid).one()
        assert contribution.participant_id == pid and contribution.score < 0
        assert next(row for row in corrected["rows"] if row["participant_id"] == pid)["total_score"] == contribution.score
        original = session.query(SummaryVersionORM).filter_by(season_id=sid, version=frozen["version"]).one()
        assert next(row for row in json.loads(original.summary_json)["rows"] if row["participant_id"] == pid)["total_score"] == 0


def test_purged_master_zero_bonus_can_become_positive_without_losing_identity(client, work, superuser):
    from datetime import timedelta
    accept(client, work)
    close(client, work, superuser)
    now = datetime.now(timezone.utc)
    season = ok(client.post("/api/seasons", headers=superuser.headers, json={"title": "Zero then positive", "type": "autumn_winter",
        "starts_at": (now-timedelta(days=1)).isoformat(), "ends_at": (now+timedelta(days=10)).isoformat()}))
    sid = season["season_id"]
    ok(client.post(f"/api/seasons/{sid}/open", headers=superuser.headers, json={"expected_revision": 1}))
    task = ok(client.post("/api/tasks", headers=work["master"].headers, json={**work["payload"], "season_id": sid,
        "deadline_at": (now+timedelta(days=9)).isoformat(), "assignees": [{"user_id": work["member"].user_id, "hours": 0}]}))
    second = {**work, "season": season, "task": task}
    accept(client, second)
    frozen = close(client, second, superuser)
    with db._session() as session:
        assert session.query(ContributionORM).filter_by(season_id=sid, source_kind="master_bonus").count() == 0
    archive(client, superuser, work["master"])
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 1
    with db._session() as session:
        pid = session.get(AccountArchiveORM, work["master"].user_id).anonymous_participant_id
    aid = task["assignments"][0]["assignment_id"]
    inputs = ok(client.get(f"/api/assignments/{aid}/assessment-inputs", headers=superuser.headers))
    result = ok(client.post(f"/api/seasons/{sid}/summary/correct", headers=superuser.headers,
        json={"expected_version": frozen["version"], "reason": "Observed missing hours", "changes": [
            {"kind": "assessment_inputs", "id": aid, "expected_revision": inputs["revision"], "values": {"hours": 2}}]}))
    row = next(row for row in result["rows"] if row["participant_id"] == pid)
    with db._session() as session:
        bonus = session.query(MasterBonusORM).filter_by(season_id=sid, block_id="IT").one()
        credit = session.query(ContributionORM).filter_by(bonus_id=bonus.bonus_id).one()
        assert credit.participant_id == bonus.recipient_participant_id == pid
        assert row["total_score"] == credit.score == bonus.amount > 0
        old = session.query(SummaryVersionORM).filter_by(season_id=sid, version=frozen["version"]).one()
        assert next(row for row in json.loads(old.summary_json)["rows"] if row["participant_id"] == pid)["total_score"] == 0


def test_registry_refuses_unreviewed_tables_and_malformed_json_before_changes(client, superuser, make_user):
    actor = make_user(password=None)
    archive(client, superuser, actor)
    unknown = Table("unreviewed_retention_test", Base.metadata, Column("id", String, primary_key=True))
    try:
        with pytest.raises(RuntimeError, match="policy missing"):
            purge("2024-01-01T00:00:00+00:00", False)
    finally:
        Base.metadata.remove(unknown)
    with db._session() as session:
        row = AuditLogORM(target_kind="registration", target_id=str(actor.user_id), changed_by_user_id=actor.user_id,
            reason="Broken legacy structured field", old_values_json="not JSON", new_values_json="{}", created_at="2020-01-01T00:00:00+00:00")
        session.add(row); session.commit()
    before = snapshot()
    with pytest.raises(ValueError, match="audit_logs.old_values_json.*primary key"):
        purge("2024-01-01T00:00:00+00:00", False)
    assert snapshot() == before


def test_full_purge_invokes_profile_support_and_scoped_hr_policies(client, work, superuser, make_user):
    from test_profile_features import definition, template
    from profile_features_models import AchievementGrantORM, KkrTemplateORM, KkrTemplateUseORM
    from support_models import FeedbackORM, SupportNoteORM, SupportStaffORM, SupportConfigORM
    from domain_models import BlockMetaORM
    from event_workspace_models import EventWorkspaceMetaORM
    actor = make_user(password=None)
    bid, uid = work["block"]["block_id"], actor.user_id
    card = ok(client.get(f"/api/blocks/{bid}", headers=superuser.headers))
    ok(client.put(f"/api/blocks/{bid}/hr", headers=superuser.headers,
        json={"expected_revision": card["revision"], "user_id": uid}))
    event = ok(client.post("/api/events", headers=superuser.headers,
        json={"season_id": work["season"]["season_id"], "title": "Retention scope", "description": ""}))
    sub = ok(client.post(f"/api/events/{event['event_id']}/subevents", headers=superuser.headers,
        json={"title": "Retention child", "description": ""}))
    ok(client.put(f"/api/subevents/{sub['subevent_id']}/hr", headers=superuser.headers,
        json={"expected_revision": sub["revision"], "user_id": uid}))
    award = definition(client, superuser)
    grant = ok(client.post(f"/api/achievements/{award['achievement_id']}/grant", headers=superuser.headers,
        json={"expected_revision": award["revision"], "user_id": uid}))
    saved_template = template(client, superuser)
    stamp = datetime.now(timezone.utc).isoformat()
    with db._session() as session:
        stored = session.get(KkrTemplateORM, saved_template["template_id"])
        stored.owner_user_id = uid
        session.add(KkrTemplateUseORM(use_id="retention-template-use", template_id=stored.template_id, template_revision=1,
            actor_user_id=uid, target_kind="merit", target_id="historical", template_snapshot_json=stored.values_json,
            saved_values_json=json.dumps({"recipients": [{"user_id": uid, "hours": 3, "evaluation": 1}]}), created_at=stamp))
        session.add(FeedbackORM(report_id="retention-feedback", user_id=uid, kind="bug", title="Preserved report",
            body="Preserved authored work", contact="owned private contact", diagnostics_json='{"private":"diagnostic"}',
            screenshot="owned private screenshot", idempotency_key="retention-feedback-key", request_hash="0"*64,
            created_at=stamp, diagnostics_expires_at=stamp, state="completed", revision=1))
        session.flush()
        session.add(SupportNoteORM(note_id="retention-note", report_id="retention-feedback", author_user_id=uid,
            body="Preserved internal work note", created_at=stamp))
        session.add(SupportStaffORM(user_id=uid, granted_by=superuser.user_id, granted_at=stamp, active=True))
        session.add(SupportConfigORM(config_id=99, system_user_id=uid, revision=1))
        session.commit()
    archive(client, superuser, actor)
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 1
    with db._session() as session:
        pid = session.get(AccountArchiveORM, uid).anonymous_participant_id
        assert session.get(BlockMetaORM, bid).hr_user_id is None
        assert session.get(EventWorkspaceMetaORM, ("subevent", sub["subevent_id"])).hr_user_id is None
        awarded = session.get(AchievementGrantORM, grant["grant_id"])
        assert awarded.user_id is None and awarded.participant_id == pid
        assert session.get(KkrTemplateORM, saved_template["template_id"]).owner_user_id is None
        used = session.get(KkrTemplateUseORM, "retention-template-use")
        assert used.actor_user_id is None
        assert json.loads(used.saved_values_json)["recipients"] == [{"user_id": None, "participant_id": pid, "hours": 3, "evaluation": 1}]
        feedback = session.get(FeedbackORM, "retention-feedback")
        assert (feedback.user_id, feedback.contact, feedback.diagnostics_json, feedback.screenshot) == (None, None, None, None)
        assert feedback.body == "Preserved authored work" and feedback.revision == 1
        note = session.get(SupportNoteORM, "retention-note")
        assert note.author_user_id is None and note.body == "Preserved internal work note"
        assert session.get(SupportStaffORM, uid) is None
        assert session.get(SupportConfigORM, 99).system_user_id is None


def test_avatar_queue_owns_only_unshared_objects_and_partial_storage_retry_is_idempotent(client, superuser, make_user, monkeypatch):
    from database import FileRecordORM
    from domain_models import ObjectDeletionORM
    from account_cleanup import delete_pending_objects
    from utils.s3_service import s3_client
    owner = make_user(password=None, photo_url="https://global.s3.cloud.ru/test-bucket/avatars/shared-photo.png")
    other = make_user(password=None, photo_url="https://global.s3.cloud.ru/test-bucket/avatars/shared-photo.png")
    stamp = datetime.now(timezone.utc).isoformat()
    with db._session() as session:
        for fid, kind, identity, storage in [
            ("retention-own", "avatar", str(owner.user_id), None),
            ("retention-adopted", "avatar", str(owner.user_id), "avatars/adopted.png"),
            ("retention-shared", "avatar", str(owner.user_id), "avatars/shared.png"),
            ("retention-other", "task", "contextual-work", "avatars/shared.png"),
            ("retention-context", "report", "contextual-report", "avatars/context.png"),
        ]:
            session.add(FileRecordORM(file_id=fid, owner_kind=kind, owner_id=identity, purpose="avatar" if kind == "avatar" else "attachment",
                name="Synthetic file.png", mime_type="image/png", size_bytes=20, uploaded_by_user_id=owner.user_id,
                state="completed", created_at=stamp, expires_at=stamp, storage_key=storage))
        session.commit()
    archive(client, superuser, owner)
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 1
    with db._session() as session:
        pending = {row.object_key for row in session.query(ObjectDeletionORM).filter_by(completed_at=None)}
        assert pending == {"private/retention-own", "sealed/retention-own", "avatars/adopted.png"}
        assert {row.file_id for row in session.query(FileRecordORM)} == {"retention-other", "retention-context"}
        assert session.get(UserORM, other.user_id).photo_url.endswith("avatars/shared-photo.png")
    calls = []
    def fail_second(**kwargs):
        calls.append(kwargs["Key"])
        if len(calls) == 2:
            raise RuntimeError("Synthetic partial storage outage")
    monkeypatch.setattr(s3_client, "delete_object", fail_second)
    with pytest.raises(RuntimeError, match="partial"):
        delete_pending_objects()
    with db._session() as session:
        assert session.query(ObjectDeletionORM).filter(ObjectDeletionORM.completed_at.isnot(None)).count() == 1
    retried = []
    monkeypatch.setattr(s3_client, "delete_object", lambda **kw: retried.append(kw["Key"]))
    assert delete_pending_objects() == 2 and set(retried) == pending - {calls[0]}
    assert delete_pending_objects() == 0
    assert purge("2023-01-01T00:00:00+00:00", False)["purged_count"] == 0
