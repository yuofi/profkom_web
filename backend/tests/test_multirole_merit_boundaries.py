"""A member/organizer/subevent-lead has scoped volunteer rights, not global KKR."""
from datetime import datetime, timedelta, timezone
import json

from database import ContributionORM, MeritORM, db
from domain_seed import meta_for
from membership import set_membership


def test_multiple_roles_keep_merits_scoped_and_revocation_atomic(client, superuser, make_user, make_block):
    multi, outsider, replacement = [make_user() for _ in range(3)]
    make_block(name="Scoped membership")
    with db.atomic():
        with db._session() as session:
            block_id = meta_for(session, "Scoped membership").block_id
            set_membership(session, multi.user_id, block_id, True, superuser.user_id, "Synthetic membership")
            session.commit()
    now = datetime.now(timezone.utc)

    def req(method, path, payload=None, actor=superuser):
        response = client.request(method, "/api" + path, json=payload, headers=actor.headers)
        assert response.status_code < 300, (method, path, response.status_code)
        return response.json()

    season = req("POST", "/seasons", {"title": "Scoped merits", "type": "autumn_winter",
        "starts_at": (now - timedelta(days=10)).isoformat(), "ends_at": (now + timedelta(days=30)).isoformat()})
    req("POST", f"/seasons/{season['season_id']}/open", {"expected_revision": season["revision"]})
    event = req("POST", "/events", {"season_id": season["season_id"], "title": "Scope boundary", "description": ""})
    first, second = [req("POST", f"/events/{event['event_id']}/subevents", {"title": title, "description": ""}) for title in ["Organizer only", "Responsible"]]
    first = req("PUT", f"/subevents/{first['subevent_id']}/organizers", {"user_ids": [multi.user_id], "expected_revision": first["revision"]})
    second = req("PUT", f"/subevents/{second['subevent_id']}/leaders", {"user_ids": [multi.user_id], "expected_revision": second["revision"]})
    work = datetime.now(timezone.utc).isoformat()
    base = {"season_id": season["season_id"], "source_kind": "subevent_volunteer",
        "scope": {"kind": "subevent", "id": second["subevent_id"]}, "title": "External volunteer",
        "description": "Synthetic work", "assigned_at": (now - timedelta(days=1)).isoformat(),
        "deadline_at": (now + timedelta(days=1)).isoformat(), "criteria": {}, "reason": "Synthetic acceptance",
        "recipients": [{"user_id": outsider.user_id, "hours": 1, "evaluation": 1, "completed_at": work}]}
    merit = req("POST", "/merits", base, multi)

    def snapshot():
        with db._session() as session:
            contributions = sorted(
                tuple((column.name, json.dumps(getattr(row, column.name), sort_keys=True, default=str))
                      for column in ContributionORM.__table__.columns)
                for row in session.query(ContributionORM).all()
            )
            return (session.query(MeritORM).count(), contributions,
                    req("GET", f"/merits/{merit['merit_id']}"))

    saved = snapshot()
    invalid = {**base, "recipients": [{**base["recipients"][0], "user_id": multi.user_id}]}
    assert client.post("/api/merits", json=invalid, headers=multi.headers).status_code == 422
    assert snapshot() == saved
    forbidden = [
        {**base, "scope": {"kind": "subevent", "id": first["subevent_id"]}},
        {**base, "source_kind": "block_volunteer", "scope": {"kind": "block", "id": block_id}},
        {**{k: v for k, v in base.items() if k != "scope"}, "source_kind": "head_merit", "event_id": event["event_id"]},
        {**{k: v for k, v in base.items() if k != "scope"}, "source_kind": "chair_merit"},
    ]
    for payload in forbidden:
        assert client.post("/api/merits", json=payload, headers=multi.headers).status_code == 403
        assert snapshot() == saved
    for path in [f"/assessments?season_id={season['season_id']}", f"/seasons/{season['season_id']}/summary"]:
        assert client.get("/api" + path, headers=multi.headers).status_code == 403
    req("PUT", f"/subevents/{second['subevent_id']}/leaders", {"user_ids": [replacement.user_id], "expected_revision": second["revision"]})
    after_role_change = snapshot()
    assert client.post("/api/merits", json=base, headers=multi.headers).status_code == 403
    assert client.patch(f"/api/merits/{merit['merit_id']}", json={"expected_revision": merit["revision"], "title": "Denied", "reason": "Revoked"}, headers=multi.headers).status_code in (403, 404)
    assert snapshot() == after_role_change
