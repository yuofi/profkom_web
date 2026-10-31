"""PB-04: notification recipients are scanned among access.holders, decided by the ACL.

Several unclosed seasons hold instances of one report series (and of its parent
series), a closed season keeps frozen report editors and readers, and every lead,
organizer and curator kind is present. For each report, meeting owner, block review
stage and the registration review: the candidates contain every reader of a full
users scan, and the recipients equal the full scan's, in its order.
"""
import json
import uuid

import pytest

import access
from database import (db, UserORM, BlockORM, LeadershipORM, RoleAssignmentORM, SeasonORM, EventORM, SubeventORM,
                      ReportSeriesORM, ReportORM, ReportEditorORM)
from event_workspace_models import EventWorkspaceMetaORM
from notifications import recipients_among
from report_access import reader_candidates
from workspace import meeting_read

STAMP = "2026-10-01T00:00:00+00:00"


@pytest.fixture
def world(make_user):
    people = {name: make_user(password=None).user_id for name in (
        "chair", "deputy", "hr_master", "hr_deputy", "master", "block_deputy", "curator",
        "e1_leader", "e1_deputy", "s1_leader", "s1_deputy", "s1_organizer", "s1_hr",
        "e2_leader", "parent_leader", "s2_leader", "closed_leader", "closed_editor", "closed_reader",
        "banned_leader", "plain_1", "plain_2", "plain_3")}
    with db._session() as s:
        s.get(UserORM, people["banned_leader"]).banned = True
        row = s.get(LeadershipORM, 1) or LeadershipORM(id=1)
        row.chair_user_id, row.deputies_json = people["chair"], json.dumps([people["deputy"]])
        s.add(row)
        s.add(BlockORM(name="HR", master="", is_hr=True, master_user_id=people["hr_master"]))
        s.add(BlockORM(name="IT", master="", is_hr=False, master_user_id=people["master"]))

        def role(user, role_name, kind, scope_id):
            s.add(RoleAssignmentORM(role_assignment_id=str(uuid.uuid4()), user_id=people[user], role=role_name,
                                    scope_kind=kind, scope_id=scope_id))
        role("hr_deputy", "deputy_master", "block", "HR")
        role("block_deputy", "deputy_master", "block", "IT")
        for number, (season_id, state) in enumerate([("A", "open"), ("B", "planned"), ("C", "closed"), ("D", "summarizing")]):
            s.add(SeasonORM(season_id=season_id, title=season_id, sequence_number=number + 1, state=state))
        s.add(ReportSeriesORM(series_id="parent", owner_kind="event", title="Родитель"))
        s.add(ReportSeriesORM(series_id="ev", owner_kind="event", title="Событие", parent_series_id="parent"))
        s.add(ReportSeriesORM(series_id="sub", owner_kind="subevent", title="Подсобытие", parent_series_id="ev"))
        for event_id, season_id, series in [("E1", "A", "ev"), ("E2", "B", "ev"), ("EP", "D", "parent"), ("E4", "C", "ev")]:
            s.add(EventORM(event_id=event_id, season_id=season_id, title=event_id, report_series_id=series))
        for sub_id, event_id, organizers in [("S1", "E1", [people["s1_organizer"]]), ("S2", "E2", []), ("S4", "E4", [])]:
            s.add(SubeventORM(subevent_id=sub_id, event_id=event_id, title=sub_id, report_series_id="sub",
                              organizer_user_ids_json=json.dumps(organizers)))
        s.flush()
        s.add(EventWorkspaceMetaORM(owner_kind="subevent", owner_id="S1", hr_user_id=people["s1_hr"]))
        role("e1_leader", "event_leader", "event", "E1")
        role("e1_deputy", "deputy_event_leader", "event", "E1")
        role("banned_leader", "event_leader", "event", "E1")
        role("s1_leader", "subevent_leader", "subevent", "S1")
        role("s1_deputy", "deputy_subevent_leader", "subevent", "S1")
        role("e2_leader", "event_leader", "event", "E2")
        role("parent_leader", "event_leader", "event", "EP")
        role("s2_leader", "subevent_leader", "subevent", "S2")
        role("closed_leader", "event_leader", "event", "E4")
        reports = []
        for report_id, kind, owner, season_id, series, state in [
                ("R1", "event", "E1", "A", "ev", "published"), ("R2", "subevent", "S1", "A", "sub", "published"),
                ("R3", "subevent", "S1", "A", "sub", "draft"), ("R4", "event", "E4", "C", "ev", "published"),
                ("R5", "subevent", "S4", "C", "sub", "published"), ("R6", "event", "E2", "B", "ev", "published")]:
            s.add(ReportORM(report_id=report_id, owner_kind=kind, owner_id=owner, report_series_id=series, season_id=season_id,
                            kind="regular", title=report_id, state=state, published_version=1 if state == "published" else None,
                            created_by_user_id=people["e1_leader"], created_at=STAMP))
            reports.append(report_id)
        for user, owner_kind, owner_id, role_name in [("closed_editor", "event", "E4", "event_leader"),
                                                      ("closed_reader", "subevent", "S4", "reader")]:
            s.add(ReportEditorORM(season_id="C", owner_kind=owner_kind, owner_id=owner_id, report_id=None,
                                  user_id=people[user], role=role_name, created_at=STAMP))
        s.commit()
    return people, reports


def _compare(s, candidates, decide):
    full = [u.user_id for u in s.query(UserORM) if decide(u.user_id)]
    assert candidates is not None and set(full) <= set(candidates), sorted(set(full) - set(candidates or ()))
    assert recipients_among(s, candidates, decide) == full
    return full


def test_holders_contain_every_full_scan_reader(world):
    people, reports = world
    names = {uid: name for name, uid in people.items()}
    with db.atomic(write=True):
        with db._session() as s:
            readers = {}
            for report_id in reports:
                r = s.get(ReportORM, report_id)
                readers[report_id] = {names.get(uid) for uid in _compare(
                    s, reader_candidates(s, r), lambda uid: db.can_read_report(uid, r, s))}
            for kind, owner in [("event", "E1"), ("event", "E2"), ("event", "E4"), ("subevent", "S1"), ("subevent", "S2")]:
                meeting = type("Meeting", (), dict(owner_kind=kind, owner_id=owner))()
                _compare(s, access.holders([f"{kind}.meeting.view"], kind, owner), lambda uid: meeting_read(uid, meeting))
            stages = {}
            for name in ("HR", "IT"):
                for stage, action in (("pending_hr", "block.review_hr_stage"), ("pending_block", "block.review_block_stage")):
                    stages[name, stage] = {names.get(uid) for uid in _compare(
                        s, access.holders([action], "block", name),
                        lambda uid: access.can_review_request(uid, stage, name, False))}
            reviewers = _compare(s, access.holders(["registration.review"]), lambda uid: access.allowed(uid, "registration.review"))
    # The world really exercises the series, parent series, frozen and organizer paths.
    assert {"e2_leader", "parent_leader", "s1_organizer", "s1_leader"} <= readers["R2"] | readers["R1"]
    assert {"closed_editor", "closed_reader"} & (readers["R4"] | readers["R5"])
    assert "banned_leader" not in set().union(*readers.values())
    assert {"hr_master", "hr_deputy"} <= stages["IT", "pending_hr"] and "block_deputy" in stages["IT", "pending_block"]
    assert set(reviewers) == {people["chair"], people["deputy"]}


def test_holders_decline_relations_they_cannot_enumerate():
    assert access.holders(["task.view"], "block", "IT") is None  # block members
    assert access.holders(["queue.view"]) is None  # "leads some queue"
    assert access.holders(["subevent.view"], "subevent", "S1") is not None
