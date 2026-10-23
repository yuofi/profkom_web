"""Session's access revision includes ordinary scopes, not only leadership."""
from database import db
from test_v13_tracker import work


def test_removal_changes_access_revision_and_blocks_task_comments_files(client, work, mock_s3):
    w = work
    headers = w["member"].headers
    tid = w["task"]["task_id"]
    before = client.get("/api/session", headers=headers).json()
    content = b"%PDF-1.4\nSynthetic"
    intent = client.post("/api/files/upload-intents", headers=headers, json=dict(
        owner_kind="assignment", owner_id=w["task"]["assignments"][0]["assignment_id"], purpose="submission",
        name="result.pdf", mime_type="application/pdf", size_bytes=len(content))).json()
    mock_s3["objects"]["private/" + intent["file_id"]] = (content, "application/pdf")
    assert client.post(f"/api/files/{intent['file_id']}/complete", headers=headers, json={}).status_code == 200
    assert client.get(f"/api/tasks/{tid}", headers=headers).status_code == 200
    assert client.delete(f"/api/blocks/{w['block']['block_id']}/members/{w['member'].user_id}", headers=w["master"].headers).status_code == 200
    after = client.get("/api/session", headers=headers).json()
    assert before["access_revision"] != after["access_revision"]
    assert before["assignments"] == after["assignments"]
    assert before["capabilities"] == after["capabilities"]
    assert client.get(f"/api/tasks/{tid}", headers=headers).status_code == 403
    assert client.get(f"/api/tasks/{tid}/comments", headers=headers).status_code == 403
    assert client.get(f"/api/files/{intent['file_id']}/download", headers=headers).status_code == 404
    assert client.get("/api/session", headers=headers).json()["access_revision"] == after["access_revision"]


def test_leaving_keeps_independent_master_access(client, work):
    w = work
    # The active master also joins as an ordinary member through synchronization.
    from membership import set_membership
    with db._session() as session:
        set_membership(session, w["master"].user_id, w["block"]["block_id"], True, w["master"].user_id, "Synthetic membership")
        session.commit()
    before = client.get("/api/session", headers=w["master"].headers).json()
    assert client.post(f"/api/blocks/{w['block']['block_id']}/leave", headers=w["master"].headers, json={}).status_code == 200
    after = client.get("/api/session", headers=w["master"].headers).json()
    assert after["access_revision"] != before["access_revision"]
    assert after["assignments"] == before["assignments"]
    assert client.get(f"/api/tasks/{w['task']['task_id']}", headers=w["master"].headers).status_code == 200


def test_organizer_roster_changes_also_change_access_revision(client, work, superuser):
    w = work
    event = client.post("/api/events", headers=superuser.headers, json=dict(
        season_id=w["season"]["season_id"], title="Scoped event", description="")).json()
    sub = client.post(f"/api/events/{event['event_id']}/subevents", headers=superuser.headers, json=dict(title="Team", description="")).json()
    sid = sub["subevent_id"]
    response = client.put(f"/api/subevents/{sid}/organizers", headers=superuser.headers, json=dict(expected_revision=sub["revision"], user_ids=[w["member"].user_id]))
    assert response.status_code == 200, response.text
    before = client.get("/api/session", headers=w["member"].headers).json()
    assert db.can_view_scope(w["member"].user_id, "subevent", sid)
    assert client.put(f"/api/subevents/{sid}/organizers", headers=superuser.headers, json=dict(expected_revision=response.json()["revision"], user_ids=[])).status_code == 200
    after = client.get("/api/session", headers=w["member"].headers).json()
    assert before["access_revision"] != after["access_revision"]
    assert not db.can_view_scope(w["member"].user_id, "subevent", sid)


def test_block_rename_keeps_members_access_revision(client, work, superuser):
    w = work
    bid = w["block"]["block_id"]
    before = {u: client.get("/api/session", headers=w[u].headers).json()["access_revision"] for u in ("member", "master")}
    block = client.get(f"/api/blocks/{bid}", headers=superuser.headers).json()
    r = client.patch(f"/api/blocks/{bid}", headers=superuser.headers, json=dict(expected_revision=block["revision"], name="IT-отдел"))
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "IT-отдел"
    assert {u: client.get("/api/session", headers=w[u].headers).json()["access_revision"] for u in ("member", "master")} == before
    assert client.get(f"/api/tasks/{w['task']['task_id']}", headers=w["member"].headers).status_code == 200
