"""The personal home page never expands to all teams for a global administrator."""
from database import db, SeasonORM
from models import Block
from test_v13_tracker import work
from test_be04_reports_dashboard_calendar import test_season, test_event_hierarchy


def test_participation_returns_compact_actual_block_roles(client, work, superuser):
    w = work
    expected = w["block"]["block_id"]
    member = client.get("/api/participation", headers=w["member"].headers)
    assert member.status_code == 200
    assert member.json()["blocks"] == [{"block_id": expected, "name": "IT", "roles": ["member"]}]
    master = client.get("/api/participation", headers=w["master"].headers).json()
    assert master["blocks"][0]["block_id"] == expected
    assert "master" in master["blocks"][0]["roles"]
    assert client.get("/api/participation", headers=w["outside"].headers).json() == {"blocks": [], "events": []}
    # Old global overview is unchanged, but the personal page uses only real membership.
    assert client.get("/api/dashboard", headers=superuser.headers).json()["my_blocks"]
    assert client.get("/api/participation", headers=superuser.headers).json()["blocks"] == []
    db.create_block(Block(name="Личная команда", master="", arr_of_human=[superuser.user_id]))
    own = client.get("/api/participation", headers=superuser.headers).json()["blocks"]
    assert [block["name"] for block in own] == ["Личная команда"]
    assert all(set(block) == {"block_id", "name", "roles"} for block in own)
    left = client.post(f"/api/blocks/{expected}/leave", headers=w["member"].headers, json={})
    assert left.status_code == 200
    assert client.get("/api/participation", headers=w["member"].headers).json()["blocks"] == []


def test_participation_event_roles_and_removal(client, test_event_hierarchy, superuser):
    hierarchy = test_event_hierarchy
    event_id = hierarchy["event_id"]
    for account, role in [("head_org", "event_leader"), ("sub_lead", "subevent_leader"), ("sub_org", "organizer")]:
        result = client.get("/api/participation", headers=hierarchy[account].headers)
        assert result.status_code == 200
        assert len(result.json()["events"]) == 1
        event = result.json()["events"][0]
        assert event["event_id"] == event_id
        assert event["season_id"] == hierarchy["season_id"]
        assert role in event["roles"]
        assert set(event) == {"event_id", "title", "season_id", "roles"}
    for headers in [superuser.headers, hierarchy["outsider"].headers]:
        assert client.get("/api/participation", headers=headers).json()["events"] == []
    sub = client.get(f"/api/subevents/{hierarchy['subevent_id']}", headers=superuser.headers).json()
    result = client.put(f"/api/subevents/{hierarchy['subevent_id']}/organizers", headers=superuser.headers,
                        json={"user_ids": [], "expected_revision": sub["revision"]})
    assert result.status_code == 200
    assert client.get("/api/participation", headers=hierarchy["sub_org"].headers).json()["events"] == []
    # Closed events leave the current participation page; block membership is independent.
    with db._session() as session:
        session.get(SeasonORM, hierarchy["season_id"]).state = "closed"
        session.commit()
    assert client.get("/api/participation", headers=hierarchy["head_org"].headers).json()["events"] == []
