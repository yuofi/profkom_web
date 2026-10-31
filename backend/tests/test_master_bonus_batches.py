"""GET /seasons/{id}/master-bonuses of an unclosed season reads its inputs once.

The reference is the former per-block calculation (no prepared inputs) converted
by the same DTO function and cursor page. Every reader with KKR access must get
exactly that body: a master excluded from its own basis, positive/zero/negative
member scores, a purged participant's anonymous id, a legacy roster id without
an account, a former member and a block whose master is only a role assignment.
"""
import json
from datetime import datetime, timezone

import pytest

import api_contract
import main
from database import db, BlockORM, ContributionORM, UserORM, _calculate_master_bonuses_for_session
from domain_models import AccountArchiveORM
from membership import set_membership
from models import Block
from test_v13_tracker import work  # noqa: F401


def reference(season_id):
    with db._session() as s:
        items = _calculate_master_bonuses_for_session(s, season_id)
        page = api_contract.cursor_page(items, lambda b: (b.block_id, b.bonus_id), None)
        return json.loads(json.dumps({"items": [main._to_master_bonus_out(b).model_dump(mode="json") for b in page.items],
                                      "next_cursor": page.next_cursor}))


@pytest.fixture
def bonuses(client, work, superuser, make_user):
    w = work
    sid = w["season"]["season_id"]
    people = [make_user() for _ in range(4)]
    second_master = make_user()
    db.create_block(Block(name="Медиа", master=""))
    media = next(b for b in client.get("/api/blocks", headers=superuser.headers).json() if b["name"] == "Медиа")
    r = client.put(f"/api/blocks/{media['block_id']}/leader", headers=superuser.headers,
                   json={"user_id": second_master.user_id, "expected_revision": media["revision"]})
    assert r.status_code == 200, r.text
    for person in people[:3]:
        with db.atomic():
            with db._session() as s:
                set_membership(s, person.user_id, w["block"]["block_id"], True, superuser.user_id, "Synthetic")
    with db.atomic():
        with db._session() as s:
            set_membership(s, people[2].user_id, w["block"]["block_id"], False, superuser.user_id, "Left")
    stamp = datetime.now(timezone.utc).isoformat()
    with db._session() as s:
        rows = [("IT", w["member"].user_id, 4.5), ("IT", people[0].user_id, 2.25), ("IT", people[0].user_id, 1.0),
                ("IT", people[1].user_id, 0.0), ("IT", people[2].user_id, -1.0), ("IT", w["master"].user_id, 7.0),
                ("Медиа", people[3].user_id, 3.0)]
        for n, (block, uid, score) in enumerate(rows):
            s.add(ContributionORM(contribution_id=f"bonus-input-{n}", season_id=sid, participant_id=f"participant-{uid}",
                                  user_id=uid, source_kind="block_task", source_id=block, source_title="Работа",
                                  score=score, created_at=stamp))
        # A purged participant keeps only the anonymous accounting id.
        s.add(AccountArchiveORM(user_id=people[1].user_id, archived_at=stamp, reason="Synthetic", snapshot_json="{}",
                                purged_at=stamp, anonymous_participant_id="anon-bonus-1"))
        s.get(UserORM, people[1].user_id).account_state = "purged"
        # The second block's master is only its role assignment.
        s.get(BlockORM, "Медиа").master_user_id = None
        # A legacy roster entry without an account is still listed by id.
        s.get(BlockORM, "Медиа").arr_of_human = json.dumps([people[3].user_id, 987654])
        s.commit()
    return dict(w, superuser=superuser, people=people)


def test_bonuses_equal_the_per_block_calculation(client, bonuses, make_hr):
    w = bonuses
    hr, _ = make_hr(block_name="HR")
    sid = w["season"]["season_id"]
    expected = reference(sid)
    assert {b["block_id"] for b in expected["items"]} >= {w["block"]["block_id"]}
    basis = {item["participant_id"]: item for b in expected["items"] for item in b["basis"]}
    assert "anon-bonus-1" in basis and basis["participant-987654"]["user"]["display_name"] == "Участник 987654"
    assert {item["exclusion"] for item in basis.values()} >= {"master", "non_positive", None}
    for actor in (w["superuser"], hr):
        r = client.get(f"/api/seasons/{sid}/master-bonuses", headers=actor.headers)
        assert r.status_code == 200 and r.json() == expected
        only = client.get(f"/api/seasons/{sid}/master-bonuses", headers=actor.headers, params={"block_id": "IT"})
        assert only.json()["items"] == [b for b in expected["items"] if b["block_id"] == w["block"]["block_id"]]
    for actor in (w["master"], w["member"]):
        assert client.get(f"/api/seasons/{sid}/master-bonuses", headers=actor.headers).status_code == 403
