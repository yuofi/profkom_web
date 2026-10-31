"""GET /blocks batches its cards; catalogue and request filters are narrow projections.

The reference for every card is the original per-block path (a direct call outside
a read UOW). Legacy roster seeding, a missing metadata row and tied guide
candidates keep their original repair/ordering queries.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

import api_contract
import membership
from database import db, BlockORM, UserORM
from domain_models import BlockApplicationORM, BlockMetaORM, MaterialORM, MembershipORM
from models import Block


@pytest.fixture
def org(client, superuser, make_user):
    people = {name: make_user(password=None, name=name) for name in (
        "HR master", "IT master", "Media master", "Applicant", "Second", "Third", "Legacy", "Stranger")}
    for name, is_hr in (("HR", True), ("IT", False), ("Медиа", False), ("Пустой", False)):
        db.create_block(Block(name=name, master="", is_hr=is_hr))
    blocks = {row["name"]: row for row in client.get("/api/blocks", headers=superuser.headers).json()}
    for name, label in (("HR", "HR master"), ("IT", "IT master"), ("Медиа", "Media master")):
        r = client.put(f"/api/blocks/{blocks[name]['block_id']}/leader", headers=superuser.headers,
                       json={"user_id": people[label].user_id, "expected_revision": blocks[name]["revision"]})
        assert r.status_code == 200, r.text
    requests = []
    for applicant in ("Applicant", "Second", "Third"):
        for name in ("IT", "Медиа"):
            r = client.post("/api/block-requests", headers=people[applicant].headers,
                            json={"block_id": blocks[name]["block_id"]})
            assert r.status_code == 200, r.text
            requests.append(r.json())
    first = requests[0]
    r = client.post(f"/api/block-requests/{first['request_id']}/hr-approve", headers=people["HR master"].headers,
                    json={"expected_revision": first["revision"], "reason": ""})
    assert r.status_code == 200, r.text
    second = requests[1]
    r = client.post(f"/api/block-requests/{second['request_id']}/withdraw", headers=people["Applicant"].headers,
                    json={"expected_revision": second["revision"], "reason": ""})
    assert r.status_code == 200, r.text
    with db._session() as s:
        old = (datetime.now(timezone.utc) - timedelta(hours=80)).isoformat()
        # One request waits beyond the 72-hour substitution window; two share created_at.
        rows = s.query(BlockApplicationORM).order_by(BlockApplicationORM.created_at).all()
        rows[2].stage_entered_at = old
        rows[3].created_at = rows[4].created_at
        s.commit()
    return dict(people=people, blocks=blocks, superuser=superuser)


def cards_by_direct_path(uid):
    # No read UOW: every card uses the original per-block queries.
    return json.loads(json.dumps(membership.blocks_for(uid)))


def test_batched_cards_equal_original_per_block_path(client, org):
    w = org
    with db._session() as s:
        it = s.query(BlockMetaORM).filter_by(legacy_name="IT").one()
        media = s.query(BlockMetaORM).filter_by(legacy_name="Медиа").one()
        stamp = "2026-10-01T00:00:00+00:00"
        # Two equally ranked live guides: the original query keeps SQLite's tie order.
        for n in range(2):
            s.add(MaterialORM(material_id=f"tie-guide-{n}", kind="guide", owner_block_id=media.block_id, title="Гайд",
                              description="", published_body="Текст", has_draft=False, revision=1, placeholder=False,
                              deleted=False, created_at=stamp))
        s.add(MaterialORM(material_id="it-draft-guide", kind="guide", owner_block_id=it.block_id, title="Черновик",
                          description="", published_body=None, has_draft=True, revision=1, placeholder=False,
                          deleted=False, created_at=stamp))
        s.commit()
    readers = [w["superuser"], *w["people"].values()]
    for actor in readers:
        expected = cards_by_direct_path(actor.user_id)
        r = client.get("/api/blocks", headers=actor.headers)
        assert r.status_code == 200 and r.json() == expected


def test_legacy_roster_and_missing_metadata_keep_their_repairs(client, org):
    w = org
    legacy = w["people"]["Legacy"].user_id
    with db._session() as s:
        s.get(BlockORM, "IT").arr_of_human = json.dumps([legacy])
        s.add(BlockORM(name="Без метаданных", master="", hr="", cnt_of_human=0, arr_of_human="[]", is_hr=False))
        s.commit()
    r = client.get("/api/blocks", headers=w["people"]["Stranger"].headers)
    assert r.status_code == 200, r.text
    cards = {card["name"]: card for card in r.json()}
    assert legacy in [m["user"]["user_id"] for m in cards["IT"]["members"]]
    assert cards["Без метаданных"]["block_id"]
    with db._session() as s:
        assert s.query(MembershipORM).filter_by(user_id=legacy, left_at=None).count() == 1
        assert s.query(BlockMetaORM).filter_by(legacy_name="Без метаданных").count() == 1
    assert client.get("/api/blocks", headers=w["people"]["Stranger"].headers).json() == \
        cards_by_direct_path(w["people"]["Stranger"].user_id)


def test_catalog_is_the_cards_identity_projection(client, org):
    w = org
    for actor in (w["superuser"], w["people"]["Stranger"], w["people"]["IT master"]):
        cards = client.get("/api/blocks", headers=actor.headers).json()
        r = client.get("/api/blocks/catalog", headers=actor.headers)
        assert r.status_code == 200, r.text
        assert r.json() == {"next_cursor": None, "items": [
            dict(block_id=c["block_id"], name=c["name"], is_hr=c["is_hr"], avatar_url=c["avatar_url"],
                 master=dict(user=c["master"]["user"]) if c["master"] else None) for c in cards]}
    assert client.get("/api/blocks/catalog").status_code == 401


def test_request_filters_and_pages_narrow_the_visible_list(client, org, monkeypatch):
    w = org
    it = w["blocks"]["IT"]["block_id"]
    for actor in (w["superuser"], w["people"]["HR master"], w["people"]["IT master"], w["people"]["Media master"],
                  w["people"]["Applicant"], w["people"]["Stranger"]):
        full = client.get("/api/block-requests", headers=actor.headers).json()
        assert full["next_cursor"] is None
        items = full["items"]
        assert client.get("/api/block-requests", headers=actor.headers, params={"block_id": it}).json()["items"] == \
            [r for r in items if r["block_id"] == it]
        assert client.get("/api/block-requests", headers=actor.headers, params={"mine": "true"}).json()["items"] == \
            [r for r in items if r["user"]["user_id"] == actor.user_id]
        pending = client.get("/api/block-requests", headers=actor.headers,
                             params=[("state", "pending_hr"), ("state", "pending_block")]).json()["items"]
        assert pending == [r for r in items if r["state"] in ("pending_hr", "pending_block")]
        monkeypatch.setattr(api_contract, "PAGE_SIZE", 2)
        pages, cursor = [], None
        while True:
            params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
            page = client.get("/api/block-requests", headers=actor.headers, params=params).json()
            pages += page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                break
        monkeypatch.setattr(api_contract, "PAGE_SIZE", 100)
        assert pages == sorted(items, key=lambda r: (r["created_at"], r["request_id"]))
    assert client.get("/api/block-requests", headers=w["superuser"].headers, params={"state": "unknown"}).status_code == 422


def test_home_counts_the_same_reviewable_requests(client, org):
    w = org
    def check():
        result = {}
        for label in ("HR master", "IT master", "Media master", "Applicant", "Stranger", None):
            actor = w["people"][label] if label else w["superuser"]
            items = client.get("/api/block-requests", headers=actor.headers).json()["items"]
            expected = sum(1 for r in items if {"hr_review_request", "block_review_request"} & set(r["capabilities"]))
            home = client.get("/api/workspace/home", headers=actor.headers).json()
            counts = [a["count"] for a in home["approvals"] if a["kind"] == "block_requests"]
            assert counts == ([expected] if expected else [])
            assert membership.reviewable_request_count(actor.user_id) == expected
            result[label] = expected
        return result
    substituted = check()
    with db._session() as s:
        for row in s.query(BlockApplicationORM):
            row.stage_entered_at = datetime.now(timezone.utc).isoformat()
        s.commit()
    # Without the expired 72-hour stage the chair loses the substitute review.
    assert check()[None] == substituted[None] - 1
