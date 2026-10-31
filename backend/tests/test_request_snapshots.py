"""Request-scoped ACL/identity snapshots answer exactly like the per-object queries.

One synthetic organisation is evaluated twice: by direct calls (no read UOW, the
original per-object path) and inside one clean read UOW (whole-table facts, batched
people/leaders, remembered absent rows). Every relation, capability input, leader,
user reference, avatar, block identity and historical report reader must match.
A write or dirty state inside the UOW returns to the original path at once.
"""
import json
from contextlib import contextmanager
from dataclasses import asdict

import pytest
from fastapi import HTTPException
from sqlalchemy import event, update

import access
import membership
import report_access
from database import (db, engine, _user_to_ref_dc, BlockORM, FileRecordORM, LeadershipORM,
                      RoleAssignmentORM, SubeventORM, UserORM, ReportSeriesORM)
from directory import avatar_url, contact_data
from domain_models import BlockMetaORM, ProfileMetadataORM
from event_workspace_models import EventWorkspaceMetaORM


@contextmanager
def sql_calls():
    statements = []
    def count(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", count)


def _role(s, rid, uid, role, kind, scope_id, principal=None):
    s.add(RoleAssignmentORM(role_assignment_id=rid, user_id=uid, role=role, scope_kind=kind,
                            scope_id=scope_id, principal_assignment_id=principal, revision=1))


@pytest.fixture
def org(make_user, make_block):
    from domain_seed import meta_for
    p = {label: make_user(password=None, surname=label.capitalize()) for label in (
        "chair", "deputy", "hrmaster", "hrdeputy", "master", "mdeputy", "member", "curator",
        "head", "headdep", "resp", "respdep", "org", "subhr", "pgas", "banned", "outsider",
        "preset", "photo")}
    uid = {label: actor.user_id for label, actor in p.items()}
    make_block(name="Кадры")
    make_block(name="ИТ", arr_of_human=[uid["member"], uid["org"]])
    make_block(name="Пустой")
    make_block(name="Сломанный")
    current = db.create_season("Snapshot current", "autumn_winter",
                               "2026-09-01T00:00:00+00:00", "2027-02-01T00:00:00+00:00")
    ev = db.create_event(current.season_id, "Snapshot event", "")
    other = db.create_event(current.season_id, "Snapshot other", "")
    sub = db.create_subevent(ev.event_id, "Snapshot team", "")
    sub2 = db.create_subevent(ev.event_id, "Snapshot second", "")
    with db._session() as s:
        lead = s.get(LeadershipORM, 1) or LeadershipORM(id=1, deputies_json="[]", revision=1)
        s.add(lead)
        lead.chair_user_id = uid["chair"]
        lead.deputies_json = json.dumps([uid["deputy"]])
        hr = s.get(BlockORM, "Кадры")
        hr.is_hr, hr.master_user_id = True, uid["hrmaster"]
        s.get(BlockORM, "ИТ").master_user_id = uid["master"]
        s.get(BlockORM, "Сломанный").arr_of_human = "not json"
        for name in ("Кадры", "ИТ", "Пустой", "Сломанный"):
            meta_for(s, name)
        s.query(BlockMetaORM).filter_by(legacy_name="ИТ").one().hr_user_id = uid["curator"]
        _role(s, "snap-hrdep", uid["hrdeputy"], "deputy_master", "block", "Кадры")
        _role(s, "snap-mdep", uid["mdeputy"], "deputy_master", "block", "ИТ")
        _role(s, "snap-head", uid["head"], "event_leader", "event", ev.event_id)
        _role(s, "snap-head-other", uid["head"], "event_leader", "event", other.event_id)
        _role(s, "snap-headdep", uid["headdep"], "deputy_event_leader", "event", ev.event_id, "snap-head")
        _role(s, "snap-resp", uid["resp"], "subevent_leader", "subevent", sub.subevent_id)
        _role(s, "snap-respdep", uid["respdep"], "deputy_subevent_leader", "subevent", sub.subevent_id, "snap-resp")
        _role(s, "snap-resp2", uid["respdep"], "subevent_leader", "subevent", sub2.subevent_id)
        s.get(SubeventORM, sub.subevent_id).organizer_user_ids_json = json.dumps([uid["org"], uid["member"]])
        s.get(SubeventORM, sub2.subevent_id).organizer_user_ids_json = "{broken"
        s.get(EventWorkspaceMetaORM, ("subevent", sub.subevent_id)).hr_user_id = uid["subhr"]
        s.get(UserORM, uid["pgas"]).pgas_admin = True
        s.get(UserORM, uid["banned"]).banned = True
        s.add(ProfileMetadataORM(user_id=uid["preset"], participation_periods_json='[{"from_year": 2020, "to_year": 2021}]',
                                 preset_id="moon"))
        s.add(FileRecordORM(file_id="snap-avatar", owner_kind="avatar", owner_id=str(uid["photo"]), purpose="avatar",
                            name="a.png", mime_type="image/png", size_bytes=10, uploaded_by_user_id=uid["photo"],
                            state="completed", created_at="2026-10-01T00:00:00+00:00",
                            expires_at="2026-10-02T00:00:00+00:00"))
        s.add(ProfileMetadataORM(user_id=uid["photo"], participation_periods_json="[]", avatar_file_id="snap-avatar"))
        s.commit()
        metas = {m.legacy_name: m.block_id for m in s.query(BlockMetaORM)}
        series = [r.series_id for r in s.query(ReportSeriesORM)]
    return dict(uid=uid, metas=metas, events=[ev.event_id, other.event_id], subs=[sub.subevent_id, sub2.subevent_id],
                season=current.season_id, series=series)


def _attempt(function, *args):
    try:
        return ("ok", function(*args))
    except HTTPException as error:
        return ("http", error.status_code)


def projection(o):
    users = sorted(o["uid"].values()) + [999999]
    blocks = sorted(o["metas"]) + sorted(o["metas"].values()) + ["Нет такого", "missing-id"]
    scopes = ([("block", b) for b in blocks] + [("event", e) for e in o["events"] + ["missing-event"]]
              + [("subevent", s) for s in o["subs"] + ["missing-sub"]] + [(None, None), ("chair", "chair")])
    out = {}
    for user in users:
        out[("global", user)] = sorted(access._global(user)), access.all_queue_reader(user)
        for kind, scope_id in scopes:
            out[("relations", user, kind, scope_id)] = sorted(access.relations(user, kind, scope_id))
            if kind in access.SCOPES:
                out[("scope", user, kind, scope_id)] = sorted(access.scope_relations(user, kind, scope_id))
        for series_id in o["series"] + ["missing-series"]:
            for other_than in (None, o["season"]):
                with db._session() as s:
                    out[("history", user, series_id, other_than)] = report_access.historical_reader(s, series_id, user, other_than)
    for name in blocks:
        out[("block_name", name)] = access.block_name(name)
        out[("legacy_name", name)] = _attempt(membership.legacy_name, name)
        out[("display", name)] = membership.scope_display({"kind": "block", "id": name})
    for name in sorted(o["metas"]):
        out[("block_id_for", name)] = membership.block_id_for(name)
    for sid in o["subs"] + ["missing-sub"]:
        out[("display", sid)] = membership.scope_display({"kind": "subevent", "id": sid})
    for eid in o["events"] + ["missing-event"]:
        out[("children", eid)] = sorted(access.subevent_ids(eid))
        out[("closed", eid)] = access._closed_scope("event", eid)
        event_dc = db.get_event(eid)
        out[("event", eid)] = asdict(event_dc) if event_dc else None
        for leader in (event_dc.leaders if event_dc else []):
            for user in users:
                out[("leader_caps", leader.role_assignment_id, user)] = access.leader_caps(leader, user)
    for sid in o["subs"]:
        out[("closed", sid)] = access._closed_scope("subevent", sid)
        out[("subevent", sid)] = asdict(db.get_subevent(sid))
    with db._session() as s:
        for user in users:
            ref = _user_to_ref_dc(s.get(UserORM, user))
            out[("ref", user)] = asdict(ref) if ref else None
            out[("avatar", user)] = avatar_url(user)
            contact = db.get_contact(user)
            out[("contact", user)] = contact_data(contact) if contact else None
    return out


def test_snapshot_projection_matches_per_object_queries(org, record_property):
    with sql_calls() as plain:
        expected = projection(org)
    with db.atomic(write=False):
        with sql_calls() as optimized:
            actual = projection(org)
    assert actual.keys() == expected.keys()
    assert [k for k in expected if actual[k] != expected[k]] == []
    assert any(v for k, v in expected.items() if k[0] == "history")  # leaders read their own series
    assert all(q.lstrip().upper().startswith("SELECT") for q in optimized)
    assert len(optimized) < len(plain) / 10, (len(plain), len(optimized))
    record_property("per_object_sql", len(plain))
    record_property("snapshot_sql", len(optimized))


def test_relations_for_many_scopes_and_users_use_constant_sql(org):
    def evaluate(users):
        for user in users:
            for eid in org["events"]:
                access.relations(user, "event", eid)
            for sid in org["subs"]:
                access.relations(user, "subevent", sid)
            for block_id in org["metas"].values():
                access.relations(user, "block", block_id)
            access.all_queue_reader(user)
    users = sorted(org["uid"].values())
    counts = []
    for selection in (users[:6], users):
        with db.atomic(write=False):
            with sql_calls() as statements:
                evaluate(selection)
        counts.append(len(statements))
    # Roles, blocks, block metadata, subevents, subevent HR, leadership and one people
    # batch: the same statements for six people as for every person and scope.
    assert counts[0] == counts[1] <= 16, counts


def test_dirty_or_flushed_change_in_read_uow_leaves_the_snapshot(org):
    uid = org["uid"]
    it = org["metas"]["ИТ"]
    sub = org["subs"][0]
    with db.atomic(write=False):
        assert access.BLOCK_MEMBER in access.relations(uid["member"], "block", it)
        assert access.ORGANIZER in access.relations(uid["org"], "subevent", sub)
        with db._session() as s:
            # Unflushed attribute change: the facts are no longer usable.
            s.get(BlockORM, "ИТ").arr_of_human = "[]"
            assert access.BLOCK_MEMBER not in access.scope_relations(uid["member"], "block", it)
            s.get(SubeventORM, sub).organizer_user_ids_json = "[]"
            assert access.ORGANIZER not in access.scope_relations(uid["org"], "subevent", sub)
            s.add(RoleAssignmentORM(role_assignment_id="snap-new", user_id=uid["outsider"], role="subevent_leader",
                                    scope_kind="subevent", scope_id=sub, revision=1))
            s.flush()
            assert access.SUB_LEADER in access.relations(uid["outsider"], "subevent", sub)
            assert [l.user.user_id for l in db.get_subevent(sub).leaders].count(uid["outsider"]) == 1
            s.rollback()


@pytest.mark.parametrize("target", ["block", "subevent_hr", "role", "leadership"])
def test_core_command_in_read_uow_leaves_the_snapshot(org, target):
    uid = org["uid"]
    it = org["metas"]["ИТ"]
    sub = org["subs"][0]
    with db.atomic(write=False):
        assert access.BLOCK_MASTER in access.relations(uid["master"], "block", it)
        assert access.SUBEVENT_HR in access.relations(uid["subhr"], "subevent", sub)
        assert access.CHAIR in access.relations(uid["chair"])
        assert access.HR_DEPUTY in access.relations(uid["hrdeputy"])
        with db._session() as s:
            if target == "block":
                s.connection().execute(update(BlockORM).where(BlockORM.name == "ИТ").values(master_user_id=None))
                assert access.BLOCK_MASTER not in access.relations(uid["master"], "block", it)
            elif target == "subevent_hr":
                s.connection().exec_driver_sql("UPDATE event_workspace_metadata SET hr_user_id=NULL WHERE owner_id=?", (sub,))
                assert access.SUBEVENT_HR not in access.relations(uid["subhr"], "subevent", sub)
            elif target == "role":
                s.connection().exec_driver_sql("DELETE FROM role_assignments WHERE role_assignment_id='snap-hrdep'")
                assert access.HR_DEPUTY not in access.relations(uid["hrdeputy"])
            else:
                s.connection().execute(update(LeadershipORM).values(chair_user_id=None))
                assert access.CHAIR not in access.relations(uid["chair"])
            s.rollback()


def test_missing_block_metadata_keeps_the_read_repair_path(org, make_block):
    make_block(name="Без метаданных")
    with db._session() as s:
        s.query(BlockMetaORM).filter_by(legacy_name="Без метаданных").delete()
        s.commit()
    with db.atomic(write=False):
        assert access.block_facts() is not None
        block_id = membership.block_id_for("Без метаданных")
        # The original path created the stable identity, which also ends the facts.
        assert access.block_facts() is None
    with db._session() as s:
        assert s.query(BlockMetaORM).filter_by(legacy_name="Без метаданных").one().block_id == block_id


def test_people_batch_reuses_absent_metadata_and_identical_refs(org):
    users = sorted(org["uid"].values())
    with db._session() as s:
        expected = [(asdict(_user_to_ref_dc(s.get(UserORM, user))), avatar_url(user)) for user in users]
    with db.atomic(write=False):
        with db._session() as s:
            with sql_calls() as first:
                actual = [(asdict(_user_to_ref_dc(s.get(UserORM, user))), avatar_url(user)) for user in users]
            with sql_calls() as repeated:
                assert [avatar_url(user) for user in users] == [a for _, a in actual]
    assert actual == expected
    assert any(a.startswith("/api/files/") for _, a in actual) and "/avatars/moon.svg" in [a for _, a in actual]
    assert len(first) <= 20, len(first)
    assert not repeated


def test_report_series_can_be_narrowed_to_one_series(client, org):
    from auth import create_access_token
    uid = org["uid"]
    for who in ("head", "outsider", "chair"):
        headers = {"Authorization": "Bearer " + create_access_token(uid[who])}
        full = client.get("/api/report-series", headers=headers)
        assert full.status_code == 200
        readable = {item["series_id"] for item in full.json()["items"]}
        for series_id in org["series"] + ["missing-series"]:
            one = client.get("/api/report-series", params={"series_id": series_id}, headers=headers)
            assert one.status_code == 200
            assert [item["series_id"] for item in one.json()["items"]] == ([series_id] if series_id in readable else [])
