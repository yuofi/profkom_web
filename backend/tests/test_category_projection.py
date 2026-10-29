"""Real in-process HTTP parity and privacy for the bounded category read batch."""
import json
from contextlib import contextmanager

import pytest
from sqlalchemy import event

from database import db, engine, UserORM, ContactInfoORM, LeadershipORM, AuditLogORM
from domain_models import CategoryRevisionORM


def batch(client, viewer, ids):
    return client.get("/api/participants/categories", headers=viewer.headers,
                      params={"user_ids": ",".join(map(str, ids))})


@contextmanager
def sql_calls():
    calls = []
    def count(_connection, _cursor, statement, _parameters, _context, _many):
        calls.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield calls
    finally:
        event.remove(engine, "before_cursor_execute", count)


@pytest.mark.parametrize("editor", [False, True])
def test_batch_matches_exact_single_get_without_creating_missing_revisions(client, make_user, superuser, editor):
    viewer = superuser if editor else make_user(password=None)
    first = make_user(password=None)
    second = make_user(password=None)
    with db._session() as s:
        s.get(UserORM, second.user_id).category = "activist"
        s.add(CategoryRevisionORM(user_id=second.user_id, revision=7))
        s.commit()
        before = (s.query(CategoryRevisionORM).count(), s.query(AuditLogORM).count())
    expected = [client.get(f"/api/participants/{u.user_id}/category", headers=viewer.headers).json()
                for u in (first, second)]
    with sql_calls() as queries:
        response = batch(client, viewer, [second.user_id, first.user_id, second.user_id])
    assert response.status_code == 200
    assert response.json() == {"items": expected}
    assert expected[0]["revision"] == 1 and expected[1]["revision"] == 7
    assert all(item["capabilities"] == (["edit_participant_category"] if editor else []) for item in expected)
    assert all(set(item) == {"user_id", "category", "revision", "capabilities"} for item in response.json()["items"])
    assert all(q.lstrip().upper().startswith("SELECT") for q in queries)
    with db._session() as s:
        assert s.get(CategoryRevisionORM, first.user_id) is None
        assert (s.query(CategoryRevisionORM).count(), s.query(AuditLogORM).count()) == before


def test_batch_omits_exactly_targets_that_single_get_refuses(client, make_user):
    viewer = make_user(password=None)
    active = make_user(password=None)
    banned = make_user(password=None, banned=True)
    pending = make_user(password=None)
    archived = make_user(password=None)
    purged = make_user(password=None)
    with db._session() as s:
        for user, state in ((pending, "pending"), (archived, "archived"), (purged, "purged")):
            s.get(UserORM, user.user_id).account_state = state
        # GET category never required a contact, unlike GET contacts; preserve it.
        s.delete(s.get(ContactInfoORM, active.user_id))
        s.commit()
    excluded = [banned.user_id, pending.user_id, archived.user_id, purged.user_id, 9999999]
    for uid in excluded:
        assert client.get(f"/api/participants/{uid}/category", headers=viewer.headers).status_code == 404
    response = batch(client, viewer, [active.user_id, *excluded])
    assert response.status_code == 200
    assert response.json()["items"] == [client.get(f"/api/participants/{active.user_id}/category", headers=viewer.headers).json()]


@pytest.mark.parametrize("value", ["", "0", "-1", "1,,2", "1.0", "abc", "9223372036854775808", ",".join(map(str, range(1, 202)))])
def test_batch_rejects_invalid_or_oversized_ids(client, user, value):
    response = client.get("/api/participants/categories", headers=user.headers, params={"user_ids": value})
    assert response.status_code == 422
    assert "detail" in response.json()


@pytest.mark.parametrize("state", ["anonymous", "malformed", "pending", "banned"])
def test_batch_keeps_working_content_auth_guard(client, make_user, state):
    viewer = make_user(password=None)
    headers = viewer.headers
    if state == "anonymous": headers = {}
    elif state == "malformed": headers = {"Authorization": "Bearer invalid"}
    else:
        with db._session() as s:
            u = s.get(UserORM, viewer.user_id)
            if state == "banned": u.banned = True
            else: u.account_state = "pending"
            s.commit()
    response = client.get("/api/participants/categories", headers=headers, params={"user_ids": viewer.user_id})
    assert response.status_code == (401 if state in {"anonymous", "malformed"} else 403)


def test_batch_rechecks_editor_role_between_requests_with_same_jwt(client, make_user, superuser):
    deputy = make_user(password=None)
    with db._session() as s:
        s.get(LeadershipORM, 1).deputies_json = json.dumps([deputy.user_id])
        s.commit()
    assert batch(client, deputy, [deputy.user_id]).json()["items"][0]["capabilities"] == ["edit_participant_category"]
    with db._session() as s:
        s.get(LeadershipORM, 1).deputies_json = "[]"
        s.commit()
    assert batch(client, deputy, [deputy.user_id]).json()["items"][0]["capabilities"] == []


def test_batch_projection_query_count_does_not_grow_per_target(client, make_user):
    viewer = make_user(password=None)
    people = [make_user(password=None).user_id for _ in range(20)]
    with sql_calls() as small:
        assert batch(client, viewer, people[:2]).status_code == 200
    with sql_calls() as larger:
        result = batch(client, viewer, people)
    assert result.status_code == 200 and len(result.json()["items"]) == 20
    assert len(small) == len(larger)
    assert sum("category_revisions" in q for q in larger) == 1
