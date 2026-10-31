"""Queue catalogue batching, separate task facets and the create-task flag.

The catalogue built inside one clean read UOW must equal the original per-queue
path (a direct call outside a read UOW) for every reader, including pending,
rejected and approved access requests, private queues and an unavailable owner.
"""
import pytest

import task_queues
from database import db, UserORM
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, request_grant, create_in


@pytest.fixture
def queues(client, work, make_user, superuser):
    w = work
    private = make_queue(client, w, key="PRIV", private=True)
    public = make_queue(client, w, key="PUBL")
    asker, approved, outsider_owner = make_user(), make_user(), make_user()
    request_grant(client, private, approved, w["master"])
    path = "/api/task-queues/" + private["queue_id"] + "/access-requests"
    r = client.post(path, headers=asker.headers, json={"message": "Нужен доступ"})
    assert r.status_code == 200, r.text
    r = client.post(path, headers=w["outside"].headers, json={"message": "Тоже нужен"})
    assert r.status_code == 200, r.text
    create_in(client, w, private, title="Закрытая", assignees=[])
    create_in(client, w, public, title="Открытая")
    with db._session() as s:
        # A historic owner who is no longer active keeps owner_unavailable in the list.
        from database import TaskQueueORM
        s.get(TaskQueueORM, public["queue_id"]).owner_user_id = outsider_owner.user_id
        s.get(UserORM, outsider_owner.user_id).account_state = "archived"
        s.commit()
    return dict(w, asker=asker, approved=approved, superuser=superuser, private=private, public=public)


def readers(w):
    return [w["superuser"], w["master"], w["member"], w["outside"], w["asker"], w["approved"]]


def test_catalog_equals_original_per_queue_path(client, queues):
    w = queues
    for actor in readers(w):
        expected = task_queues.catalog(actor.user_id)  # no read UOW: per-queue reads
        r = client.get("/api/task-queues", headers=actor.headers)
        assert r.status_code == 200 and r.json() == expected
    statuses = {item["queue_id"]: item["access_request_status"] for item in
                client.get("/api/task-queues", headers=w["asker"].headers).json()["items"]}
    assert statuses[w["private"]["queue_id"]] == "pending"


def test_create_access_matches_catalog_create_task(client, queues, make_user):
    w = queues
    banned = make_user(banned=True)
    for actor in [*readers(w), banned]:
        items = task_queues.catalog(actor.user_id)["items"]
        expected = any("create_task" in item["capabilities"] for item in items)
        r = client.get("/api/task-queues/create-access", headers=actor.headers)
        if actor is banned:
            assert r.status_code == 403
            assert task_queues.create_access(actor.user_id) == {"can_create_task": expected}
            continue
        assert r.status_code == 200 and r.json() == {"can_create_task": expected}
    assert client.get("/api/task-queues/create-access", headers=w["member"].headers).json()["can_create_task"]


@pytest.mark.parametrize("selection", [{}, {"season": True}, {"scope": True}, {"queue": True}])
def test_facets_are_the_list_facets_of_the_same_selection(client, queues, selection):
    w = queues
    params = {}
    if selection.get("season"):
        params["season_id"] = w["season"]["season_id"]
    if selection.get("scope"):
        params.update(scope_kind="block", scope_id=w["block"]["block_id"])
    if selection.get("queue"):
        params["queue_id"] = w["public"]["queue_id"]
    for actor in readers(w):
        full = client.get("/api/tasks", headers=actor.headers, params={**params, "mine": "true", "limit": 5})
        facets = client.get("/api/tasks/facets", headers=actor.headers, params=params)
        assert facets.status_code == full.status_code
        if full.status_code != 200:
            continue
        body = full.json()
        assert facets.json() == {"scopes": body["scopes"], "assignees": body["assignees"]}
        bare = client.get("/api/tasks", headers=actor.headers, params={**params, "mine": "true", "limit": 5,
                                                                       "include_facets": "false"}).json()
        assert bare == {k: v for k, v in body.items() if k not in ("scopes", "assignees")}
