"""Creation has a default provenance note; an accounting correction needs its own reason."""

from datetime import datetime, timedelta, timezone
import json

import pytest

from database import AuditLogORM, ContributionORM, MeritORM, SeasonSummaryORM, db
from domain_models import SummaryVersionORM
from models import Block


DEFAULT_REASON = "Создание записи учёта работы"


def request(client, actor, method, path, payload=None):
    response = client.request(method, "/api" + path, headers=actor.headers, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def merit_context(client, superuser, make_user):
    head, recipient = make_user(password=None), make_user(password=None)
    db.create_block(Block(name="Merit block", master=""))
    block = request(client, superuser, "GET", "/blocks")[0]
    request(client, superuser, "PUT", f"/blocks/{block['block_id']}/leader",
            {"user_id": head.user_id, "expected_revision": block["revision"]})
    now = datetime.now(timezone.utc).replace(microsecond=0)
    season = request(client, superuser, "POST", "/seasons", {
        "title": "Synthetic merits", "type": "autumn_winter",
        "starts_at": (now - timedelta(days=10)).isoformat(),
        "ends_at": (now + timedelta(days=30)).isoformat(),
    })
    season = request(client, superuser, "POST", f"/seasons/{season['season_id']}/open",
                     {"expected_revision": season["revision"]})
    event = request(client, superuser, "POST", "/events", {
        "season_id": season["season_id"], "title": "Synthetic event", "description": "",
    })
    request(client, superuser, "PUT", f"/events/{event['event_id']}/leaders",
            {"user_ids": [head.user_id], "expected_revision": event["revision"]})
    subevent = request(client, superuser, "POST", f"/events/{event['event_id']}/subevents",
                       {"title": "Synthetic team", "description": ""})
    request(client, superuser, "PUT", f"/subevents/{subevent['subevent_id']}/leaders",
            {"user_ids": [head.user_id], "expected_revision": subevent["revision"]})
    return {
        "head": head, "recipient": recipient, "chair": superuser, "season": season,
        "event": event, "subevent": subevent, "block": block,
        "assigned_at": (now - timedelta(days=4)).isoformat(),
        "deadline_at": (now - timedelta(days=1)).isoformat(),
    }


def payload_for(context, source_kind):
    payload = {
        "season_id": context["season"]["season_id"], "source_kind": source_kind,
        "title": "Synthetic accepted work", "description": {"format": "markdown", "body": "Done"},
        "assigned_at": context["assigned_at"], "deadline_at": context["deadline_at"], "criteria": {},
        "recipients": [{"user_id": context["recipient"].user_id, "hours": 2, "evaluation": 1,
                        "completed_at": context["deadline_at"]}],
    }
    if source_kind == "head_merit":
        payload["event_id"] = context["event"]["event_id"]
    elif source_kind.endswith("_volunteer"):
        kind = "block" if source_kind == "block_volunteer" else "subevent"
        payload["scope"] = {"kind": kind, "id": context[kind][kind + "_id"]}
    return payload


def accounting_snapshot():
    with db._session() as session:
        return {
            model.__tablename__: [
                tuple(getattr(row, column.name) for column in model.__table__.columns)
                for row in session.query(model).order_by(*model.__table__.primary_key.columns)
            ]
            for model in (MeritORM, ContributionORM, SeasonSummaryORM, SummaryVersionORM, AuditLogORM)
        }


def close_season(client, context):
    chair, sid = context["chair"], context["season"]["season_id"]
    for kind in ("event", "subevent"):
        report = request(client, context["head"], "POST", "/reports", {
            "owner_kind": kind, "owner_id": context[kind][kind + "_id"], "kind": "final",
            "title": "Synthetic final report", "content": "Completed work", "file_ids": [],
        })
        request(client, context["head"], "POST", f"/reports/{report['report_id']}/publish",
                {"expected_revision": report["revision"]})
    season = request(client, chair, "GET", f"/seasons/{sid}")
    season = request(client, chair, "POST", f"/seasons/{sid}/begin-summary",
                     {"expected_revision": season["revision"]})
    return request(client, chair, "POST", f"/seasons/{sid}/close",
                   {"expected_revision": season["revision"]})["summary"]


@pytest.mark.parametrize("source_kind", ["head_merit", "chair_merit", "block_volunteer", "subevent_volunteer"])
def test_creation_without_reason_saves_provenance_and_exact_contribution(client, merit_context, source_kind):
    context = merit_context
    actor = context["chair"] if source_kind in {"chair_merit", "block_volunteer"} else context["head"]
    payload = payload_for(context, source_kind)
    created = request(client, actor, "POST", "/merits", payload)
    assert created["reason"] == DEFAULT_REASON
    assert created["created_by"]["user_id"] == actor.user_id and created["revision"] == 1
    assert request(client, actor, "GET", f"/merits/{created['merit_id']}") == created
    source_id = {
        "head_merit": context["event"]["event_id"], "chair_merit": "chair-merits:" + context["season"]["season_id"],
        "block_volunteer": context["block"]["name"], "subevent_volunteer": context["subevent"]["subevent_id"],
    }[source_kind]
    with db._session() as session:
        stored = session.get(MeritORM, created["merit_id"])
        assert stored.reason == DEFAULT_REASON and stored.created_by_user_id == actor.user_id
        assert stored.source_kind == source_kind and stored.created_at == created["created_at"]
        assert json.loads(stored.recipients_json) == created["recipients"]
        contribution = session.query(ContributionORM).filter_by(merit_id=stored.merit_id).one()
        assert contribution.user_id == context["recipient"].user_id
        assert contribution.season_id == context["season"]["season_id"]
        assert contribution.source_kind == source_kind and contribution.source_id == source_id
        assert contribution.source_title == payload["title"] and contribution.assignment_id is None
        # Two hours, three available days and on-time work with no extra criteria.
        assert contribution.score == pytest.approx(3.0) and contribution.calculation_version == "kkr_v1"
    ledger = request(client, context["chair"], "GET", f"/assessments?season_id={context['season']['season_id']}")["items"]
    assert len(ledger) == 1
    assert ledger[0]["merit_id"] == created["merit_id"] and ledger[0]["score"] == pytest.approx(3.0)
    assert ledger[0]["user"]["user_id"] == context["recipient"].user_id


@pytest.mark.parametrize("source_kind", ["head_merit", "chair_merit"])
@pytest.mark.parametrize("reason", ["", " \t ", None])
def test_explicit_empty_create_reason_is_not_replaced_by_the_default(client, merit_context, source_kind, reason):
    context = merit_context
    actor = context["chair"] if source_kind in {"chair_merit", "block_volunteer"} else context["head"]
    before = accounting_snapshot()
    response = client.post("/api/merits", headers=actor.headers,
                           json={**payload_for(context, source_kind), "reason": reason})
    assert response.status_code == 422, response.text
    assert accounting_snapshot() == before


@pytest.mark.parametrize("closed", [False, True], ids=["open", "closed"])
def test_patch_requires_a_real_correction_reason_and_keeps_rejected_commands_atomic(client, merit_context, closed):
    context = merit_context
    created = request(client, context["chair"], "POST", "/merits", payload_for(context, "chair_merit"))
    original_summary = close_season(client, context) if closed else None
    before = accounting_snapshot()
    base = {"expected_revision": created["revision"], "title": "Corrected work"}
    for body in [base, {**base, "reason": ""}, {**base, "reason": " \t "}, {**base, "reason": None}]:
        response = client.patch(f"/api/merits/{created['merit_id']}", headers=context["chair"].headers, json=body)
        assert response.status_code == 422, response.text
        assert accounting_snapshot() == before
    reason = "Уточнено название выполненной работы"
    corrected = request(client, context["chair"], "PATCH", f"/merits/{created['merit_id']}", {**base, "reason": reason})
    assert corrected["revision"] == created["revision"] + 1 and corrected["reason"] == reason
    assert corrected["title"] == base["title"]
    if closed:
        summary = request(client, context["chair"], "GET", f"/seasons/{context['season']['season_id']}/summary")
        assert summary["version"] == original_summary["version"] + 1
        with db._session() as session:
            version = session.query(SummaryVersionORM).filter_by(
                season_id=context["season"]["season_id"], version=summary["version"]
            ).one()
            assert version.reason == reason and version.changed_by_user_id == context["chair"].user_id


def test_service_creation_without_reason_uses_the_same_default(client, merit_context):
    context = merit_context
    with db.atomic():
        created = db.create_merit(payload_for(context, "chair_merit"), context["chair"].user_id)
    stored = request(client, context["chair"], "GET", f"/merits/{created.merit_id}")
    assert created.reason == stored["reason"] == DEFAULT_REASON
