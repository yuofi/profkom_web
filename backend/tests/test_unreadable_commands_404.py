"""A command on an object the caller cannot read answers 404 like its GET; a reader
without the right still gets 403 (GL-24)."""
from test_v13_tracker import work  # noqa: F401


def test_task_comment_assignment_and_upload_commands_hide_unreadable_objects(client, work):
    tid = work["task"]["task_id"]
    aid = work["task"]["assignments"][0]["assignment_id"]
    outside, member, master = work["outside"], work["member"], work["master"]
    assert client.get(f"/api/tasks/{tid}", headers=outside.headers).status_code == 404
    comment = client.post(f"/api/tasks/{tid}/comments", headers=master.headers, json={"content": "Комментарий"})
    assert comment.status_code == 200, comment.text
    cid = comment.json()["comment_id"]
    intent = dict(owner_kind="task", owner_id=tid, purpose="comment", name="a.pdf", mime_type="application/pdf", size_bytes=10)
    calls = [
        ("POST", f"/api/tasks/{tid}/comments", {"content": "Чужой"}),
        ("PATCH", f"/api/comments/{cid}", {"content": "Правка"}),
        ("PATCH", f"/api/tasks/{tid}", {"expected_revision": 1, "title": "Чужая"}),
        ("POST", f"/api/assignments/{aid}/start", {"expected_revision": 1}),
        ("POST", "/api/files/upload-intents", intent),
    ]
    for method, path, body in calls:
        response = client.request(method, path, headers=outside.headers, json=body)
        assert response.status_code == 404, (path, response.status_code, response.text)
    # A reader without the right keeps the explicit refusal.
    assert client.patch(f"/api/tasks/{tid}", headers=member.headers, json={"expected_revision": 1, "title": "x"}).status_code == 403
