"""Real HTTP: scoped awards, public role facts, atomic avatar/profile and templates."""
from datetime import datetime, timedelta, timezone
import json

import pytest

from database import db, ContributionORM, MeritORM, FileRecordORM
from domain_models import ProfileMetadataORM, ScopeTenureORM
from models import Block
from profile_features_models import AchievementGrantORM, NotificationDeliveryEventORM, KkrTemplateUseORM, KkrTemplateORM


def ok(response):
    assert response.status_code == 200, response.json()
    return response.json()


def request(client, actor, method, path, data=None):
    return getattr(client, method)("/api" + path, headers=actor.headers, **({"json": data} if data is not None else {}))


def definition(client, actor, **extra):
    return ok(request(client, actor, "post", "/achievements", {"title": "Синтетическая награда", "description": "Достоверный вклад", "icon": "workspace_premium", "scope_kind": "global", "scope_id": None, **extra}))


def template(client, actor, **extra):
    return ok(request(client, actor, "post", "/kkr-templates", {"visibility": "personal", "values": dict(title="Шаблон работы", description="Описание", hours=3, evaluation=1, criteria={}), **extra}))


def test_awards_repeat_have_immutable_snapshot_and_revoke_history(client, superuser, make_user):
    recipient, reader = make_user(), make_user()
    award = definition(client, superuser)
    before = db.get_user(recipient.user_id).kkr_score
    body = dict(expected_revision=award["revision"], user_id=recipient.user_id, note="Служебное основание выдачи")
    first, second = [ok(request(client, superuser, "post", f"/achievements/{award['achievement_id']}/grant", body)) for _ in range(2)]
    assert first["grant_id"] != second["grant_id"]
    renamed = ok(request(client, superuser, "patch", f"/achievements/{award['achievement_id']}", dict(expected_revision=award["revision"], title="Новое имя", description="Новая версия", icon="school", archived=False)))
    assert renamed["revision"] == 2
    public = ok(request(client, reader, "get", f"/profiles/{recipient.user_id}/achievements"))["items"]
    assert len(public) == 2 and public[0]["achievement"]["title"] == "Синтетическая награда"
    assert all(row["note"] is None for row in public)
    revoked = ok(request(client, superuser, "post", f"/achievement-grants/{first['grant_id']}/revoke", {"expected_revision": 1, "reason": "Приватное исправление"}))
    assert [event["kind"] for event in revoked["history"]] == ["issued", "revoked"]
    for actor, visible in [(reader, False), (recipient, True), (superuser, True)]:
        result = ok(request(client, actor, "get", f"/profiles/{recipient.user_id}/achievements"))["items"]
        row = next(row for row in result if row["grant_id"] == first["grant_id"])
        assert (row["revoke_reason"] is not None) == visible
        assert row["revoked_at"] and row["revoked_by"]["user_id"] == superuser.user_id
    assert db.get_user(recipient.user_id).kkr_score == before
    with db._session() as session:
        assert session.query(ContributionORM).count() == 0


def test_block_master_awards_only_own_team_including_self_not_deputy(client, superuser, make_user):
    master, member, outsider, deputy = [make_user() for _ in range(4)]
    db.create_block(Block(name="Owned", master="", arr_of_human=[member.user_id]))
    block = db.set_block_leader("Owned", master.user_id)
    card = ok(request(client, superuser, "get", "/blocks/Owned"))
    leader = card["master"]
    ok(request(client, superuser, "put", f"/role-assignments/{leader['role_assignment_id']}/deputies", {"expected_revision": leader["revision"], "user_ids": [deputy.user_id]}))
    award = ok(request(client, master, "post", "/achievements", dict(title="Своей команде", scope_kind="block", scope_id=card["block_id"])))
    for person in [master, member]:
        ok(request(client, master, "post", f"/achievements/{award['achievement_id']}/grant", dict(expected_revision=1, user_id=person.user_id)))
    assert request(client, master, "post", f"/achievements/{award['achievement_id']}/grant", dict(expected_revision=1, user_id=outsider.user_id)).status_code == 422
    assert request(client, deputy, "post", f"/achievements/{award['achievement_id']}/grant", dict(expected_revision=1, user_id=member.user_id)).status_code == 403
    assert request(client, master, "post", "/achievements", dict(title="Нельзя глобально", scope_kind="global")).status_code == 403
    assert request(client, outsider, "post", "/achievements", dict(title="Нельзя самому", scope_kind="global")).status_code == 403


def test_role_history_is_public_without_revealing_private_team_work(client, superuser, make_user):
    actor, reader, successor = make_user(), make_user(), make_user()
    db.create_block(Block(name="История", master=""))
    db.set_block_leader("История", actor.user_id)
    db.set_block_leader("История", successor.user_id)
    result = ok(request(client, reader, "get", f"/profiles/{actor.user_id}/activity"))["items"]
    previous = next(item for item in result if item["role"] == "master")
    assert previous["scope"]["name"] == "История" and previous["ended_at"] and previous["started_at"]
    assert set(previous) == {"scope", "role", "started_at", "ended_at", "observed", "current"}
    assert request(client, reader, "get", "/profiles/2147483647/activity").status_code == 404


def test_unknown_current_role_date_is_not_invented(client, superuser, make_user):
    actor = make_user()
    db.create_block(Block(name="Legacy", master=""))
    db.set_block_leader("Legacy", actor.user_id)
    with db._session() as session:
        session.query(ScopeTenureORM).filter_by(user_id=actor.user_id).delete()
        session.commit()
    rows = ok(request(client, superuser, "get", f"/profiles/{actor.user_id}/activity"))["items"]
    assert next(row for row in rows if row["role"] == "master")["started_at"] is None


def test_profile_and_avatar_commit_atomically_and_reject_stale_legacy_write(client, make_user):
    actor = make_user(name="До")
    saved = ok(request(client, actor, "get", "/profile/me/editor"))
    data = dict(expected_revision=saved["revision"], expected_fingerprint=saved["fingerprint"], profile={"name": "После"}, avatar={"preset_id": "leaf"})
    result = ok(request(client, actor, "patch", "/profile/me/editor", data))
    assert result["contact"]["name"] == "После" and result["contact"]["photo_url"] == "/avatars/leaf.svg"
    assert result["revision"] == 2
    assert request(client, actor, "patch", "/profile/me/editor", data).status_code == 409
    data = dict(expected_revision=result["revision"], expected_fingerprint=result["fingerprint"], profile={"name": "Не сохранится"}, avatar={"preset_id": "unknown"})
    assert request(client, actor, "patch", "/profile/me/editor", data).status_code == 422
    assert db.get_contact(actor.user_id).name == "После"
    ok(request(client, actor, "patch", f"/profile/{actor.user_id}", {"name": "Чужая вкладка"}))
    data["avatar"] = {"preset_id": "moon"}
    assert request(client, actor, "patch", "/profile/me/editor", data).status_code == 409
    assert db.get_contact(actor.user_id).name == "Чужая вкладка"


def test_preferences_versioning_and_reference_only_idempotent_disabled_delivery(client, make_user):
    actor = make_user()
    settings = ok(request(client, actor, "get", "/profile/me/notification-preferences"))
    assert settings["delivery_status"] == "not_connected"
    assert not any(any(value.values()) for value in settings["preferences"].values())
    settings["preferences"]["tracker"]["email"] = True
    settings["preferences"]["applications"]["telegram"] = True
    updated = ok(request(client, actor, "put", "/profile/me/notification-preferences", dict(expected_revision=1, preferences=settings["preferences"])))
    assert updated["revision"] == 2
    assert request(client, actor, "put", "/profile/me/notification-preferences", dict(expected_revision=1, preferences=settings["preferences"])).status_code == 409
    from profile_features import collect_delivery_event
    with db._session() as session:
        for _ in range(2):
            collect_delivery_event(session, actor.user_id, "task_status_changed", {"task_id": "safe-id", "title": "PRIVATE", "token": "MUST NOT COPY"}, "safe-event")
            session.flush()
        row = session.query(NotificationDeliveryEventORM).one()
        assert row.state == "not_connected" and row.source_id == "safe-id" and row.channel == "email"
        assert "PRIVATE" not in repr(row.__dict__) and "MUST NOT COPY" not in repr(row.__dict__)


def test_templates_are_private_or_scoped_versioned_and_archive_refuses_preparation(client, superuser, make_user):
    outsider = make_user()
    row = template(client, superuser)
    assert ok(request(client, outsider, "get", "/kkr-templates"))["items"] == []
    assert request(client, outsider, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=1)).status_code == 404
    prepared = ok(request(client, superuser, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=1)))
    assert prepared["values"]["hours"] == 3 and prepared["selection"]["revision"] == 1
    newer = ok(request(client, superuser, "patch", f"/kkr-templates/{row['template_id']}", dict(expected_revision=1, values={**row["values"], "hours": 7}, archived=False)))
    assert newer["revision"] == 2 and prepared["values"]["hours"] == 3
    assert request(client, superuser, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=1)).status_code == 409
    ok(request(client, superuser, "patch", f"/kkr-templates/{row['template_id']}", dict(expected_revision=2, values=newer["values"], archived=True)))
    assert request(client, superuser, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=3)).status_code == 409
    assert request(client, outsider, "post", "/kkr-templates", dict(visibility="personal", values=row["values"])).status_code == 403


def test_template_application_freezes_numeric_copy_and_stale_selection_rolls_back_merit(client, superuser, make_user):
    recipient = make_user()
    stamp = datetime.now(timezone.utc)
    season = ok(request(client, superuser, "post", "/seasons", dict(title="Шаблонный сезон", type="autumn_winter", starts_at=(stamp-timedelta(days=2)).isoformat(), ends_at=(stamp+timedelta(days=20)).isoformat())))
    ok(request(client, superuser, "post", f"/seasons/{season['season_id']}/open", dict(expected_revision=season["revision"])))
    row = template(client, superuser)
    data = dict(season_id=season["season_id"], source_kind="chair_merit", title="Работа из шаблона", description="Текст", assigned_at=(stamp-timedelta(days=1)).isoformat(), deadline_at=(stamp+timedelta(days=1)).isoformat(), recipients=[dict(user_id=recipient.user_id, hours=3, evaluation=1, completed_at=stamp.isoformat())], template_selection=dict(template_id=row["template_id"], revision=1))
    merit = ok(request(client, superuser, "post", "/merits", data))
    with db._session() as session:
        used = session.query(KkrTemplateUseORM).one()
        assert used.target_id == merit["merit_id"] and used.template_revision == 1
        frozen = used.template_snapshot_json
    ok(request(client, superuser, "patch", f"/kkr-templates/{row['template_id']}", dict(expected_revision=1, values={**row["values"], "hours": 30})))
    assert request(client, superuser, "post", "/merits", data).status_code == 409
    with db._session() as session:
        assert session.query(KkrTemplateUseORM).count() == 1
        assert session.query(MeritORM).count() == 1
        assert session.query(KkrTemplateUseORM).one().template_snapshot_json == frozen
    unchanged = ok(request(client, superuser, "get", f"/merits/{merit['merit_id']}"))
    assert unchanged["recipients"][0]["hours"] == 3


def test_retention_callback_preserves_facts_and_numeric_template_snapshots(client, superuser, make_user):
    person = make_user()
    award = definition(client, superuser)
    granted = ok(request(client, superuser, "post", f"/achievements/{award['achievement_id']}/grant", dict(expected_revision=1, user_id=person.user_id)))
    row = template(client, superuser)
    with db._session() as session:
        personal = session.get(KkrTemplateORM, row["template_id"])
        personal.owner_user_id = person.user_id
        session.add(KkrTemplateUseORM(use_id="frozen-use", template_id=personal.template_id, template_revision=1, actor_user_id=person.user_id, target_kind="merit", target_id="preserved", template_snapshot_json=personal.values_json, saved_values_json=json.dumps({"recipients": [{"user_id": person.user_id, "hours": 3, "evaluation": 1}]}), created_at=datetime.now(timezone.utc).isoformat()))
        session.flush()
        from profile_features import anonymize
        anonymize(session, person.user_id, f"participant-{person.user_id}", "anonymous-stable")
        session.flush()
        grant = session.get(AchievementGrantORM, granted["grant_id"])
        assert grant.user_id is None and grant.participant_id == "anonymous-stable"
        session.expire_all()
        personal = session.get(KkrTemplateORM, row["template_id"])
        assert personal.owner_user_id is None and personal.visibility == "personal"
        snapshot = json.loads(session.get(KkrTemplateUseORM, "frozen-use").saved_values_json)
        assert snapshot["recipients"] == [{"user_id": None, "participant_id": "anonymous-stable", "hours": 3, "evaluation": 1}]


def test_avatar_draft_cleanup_is_owned_and_current_avatar_is_never_discarded(client, make_user):
    owner, stranger = make_user(), make_user()
    stamp = datetime.now(timezone.utc).isoformat()
    with db._session() as session:
        for file_id in ["draft-owned", "draft-applied"]:
            session.add(FileRecordORM(file_id=file_id, owner_kind="avatar", owner_id=str(owner.user_id), purpose="avatar", name="synthetic.png", mime_type="image/png", size_bytes=1, uploaded_by_user_id=owner.user_id, state="completed", created_at=stamp, expires_at=stamp))
        session.commit()
    assert request(client, stranger, "delete", "/profile/me/avatar-drafts/draft-owned").status_code == 404
    baseline = ok(request(client, owner, "get", "/profile/me/editor"))
    foreign = dict(expected_revision=baseline["revision"], expected_fingerprint=baseline["fingerprint"], profile={"name": "Не менять"}, avatar={"file_id": "draft-owned"})
    stranger_baseline = ok(request(client, stranger, "get", "/profile/me/editor"))
    assert request(client, stranger, "patch", "/profile/me/editor", {**foreign, "expected_fingerprint": stranger_baseline["fingerprint"]}).status_code == 422
    assert db.get_contact(stranger.user_id).name != "Не менять"
    ok(request(client, owner, "patch", "/profile/me/editor", {**foreign, "profile": {}, "avatar": {"file_id": "draft-applied"}}))
    assert request(client, owner, "delete", "/profile/me/avatar-drafts/draft-applied").status_code == 409
    assert request(client, owner, "delete", "/profile/me/avatar-drafts/draft-owned").status_code == 204
    assert request(client, owner, "delete", "/profile/me/avatar-drafts/draft-owned").status_code == 204
    from domain_models import ObjectDeletionORM
    with db._session() as session:
        assert session.get(FileRecordORM, "draft-owned") is None
        assert session.get(FileRecordORM, "draft-applied") is not None
        assert {row.object_key for row in session.query(ObjectDeletionORM)} == {"private/draft-owned", "sealed/draft-owned"}


@pytest.mark.parametrize("operation", ["replace", "discard"])
@pytest.mark.parametrize("shared_by", ["file_record", "legacy_photo_url", "profile_metadata", "unshared_legacy", "unshared_modern"])
def test_avatar_retirement_preserves_live_references_and_reclaims_only_unshared_objects(client, make_user, monkeypatch, operation, shared_by):
    """Synthetic HTTP only: neither replacement nor draft discard may retire shared bytes."""
    from database import UserORM
    from domain_models import ObjectDeletionORM
    from legacy_files import canonical_url
    from utils.s3_service import s3_client

    def no_storage(*_args, **_kwargs):
        raise AssertionError("Avatar retirement must not call storage")

    for method in ("head_object", "get_object", "put_object", "delete_object"):
        monkeypatch.setattr(s3_client, method, no_storage)
    owner, other = make_user(), make_user()
    stamp = datetime.now(timezone.utc).isoformat()
    own_id, other_id = "file-retired-avatar", "file-shared-avatar"
    object_key = "avatars/shared-profile-features.png" if shared_by not in {"profile_metadata", "unshared_modern"} else None
    with db._session() as session:
        def file(file_id, person):
            session.add(FileRecordORM(file_id=file_id, owner_kind="avatar", owner_id=str(person.user_id), purpose="avatar", name="synthetic.png", mime_type="image/png", size_bytes=1, uploaded_by_user_id=person.user_id, state="completed", storage_key=object_key, created_at=stamp, expires_at=stamp))

        def bind(person, file_id):
            row = session.get(ProfileMetadataORM, person.user_id)
            if row is None:
                row = ProfileMetadataORM(user_id=person.user_id)
                session.add(row)
            row.preset_id, row.avatar_file_id = None, file_id

        file(own_id, owner)
        if operation == "replace":
            bind(owner, own_id)
        if shared_by == "file_record":
            file(other_id, other)
            bind(other, other_id)
        elif shared_by == "legacy_photo_url":
            session.get(UserORM, other.user_id).photo_url = canonical_url(object_key)
        elif shared_by == "profile_metadata":
            bind(other, own_id)
        session.commit()
    other_before = ok(request(client, other, "get", "/profile/me/editor"))["contact"]["photo_url"]
    if operation == "replace":
        saved = ok(request(client, owner, "get", "/profile/me/editor"))
        result = ok(request(client, owner, "patch", "/profile/me/editor", dict(expected_revision=saved["revision"], expected_fingerprint=saved["fingerprint"], profile={}, avatar={"preset_id": "leaf"})))
        assert result["contact"]["photo_url"] == "/avatars/leaf.svg"
    else:
        assert request(client, owner, "delete", "/profile/me/avatar-drafts/" + own_id).status_code == 204
    with db._session() as session:
        expected = ({object_key} if object_key else {"private/" + own_id, "sealed/" + own_id}) if shared_by.startswith("unshared_") else set()
        assert {row.object_key for row in session.query(ObjectDeletionORM)} == expected
        assert (session.get(FileRecordORM, own_id) is not None) == (shared_by == "profile_metadata")
        if shared_by == "file_record":
            assert session.get(FileRecordORM, other_id).storage_key == object_key
        if shared_by == "profile_metadata":
            assert session.get(ProfileMetadataORM, other.user_id).avatar_file_id == own_id
    assert ok(request(client, other, "get", "/profile/me/editor"))["contact"]["photo_url"] == other_before


def test_team_templates_lose_access_with_role_without_becoming_public(client, superuser, make_user):
    master, successor, member = make_user(), make_user(), make_user()
    db.create_block(Block(name="Template team", master="", arr_of_human=[member.user_id]))
    db.set_block_leader("Template team", master.user_id)
    block = ok(request(client, master, "get", "/blocks/Template team"))
    row = template(client, master, visibility="team", scope_kind="block", scope_id=block["block_id"])
    assert len(ok(request(client, master, "get", "/kkr-templates"))["items"]) == 1
    assert ok(request(client, member, "get", "/kkr-templates"))["items"] == []
    db.set_block_leader("Template team", successor.user_id)
    assert ok(request(client, master, "get", "/kkr-templates"))["items"] == []
    assert request(client, master, "post", f"/kkr-templates/{row['template_id']}/prepare", dict(expected_revision=1)).status_code == 404
    assert len(ok(request(client, successor, "get", "/kkr-templates"))["items"]) == 1
