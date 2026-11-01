"""A single directory entry and the profile feature scopes in one pass.

GET /contacts?user_id= is exactly the matching entries of the full filtered list
(an inactive, banned or unknown person yields []). features-context lists the
same award and template scopes as two separate available_scopes passes, and
features-flags is whether those lists are non-empty, for every kind of manager.
"""
import pytest

import profile_features
from database import db, UserORM
from models import Block
from test_event_workspace import ok, setup_event  # noqa: F401


@pytest.fixture
def people(client, setup_event, superuser, make_user):
    w = setup_event
    master = make_user(surname="Мастеров")
    db.create_block(Block(name="IT", master="", is_hr=False))
    block = next(b for b in ok(client.get("/api/blocks", headers=superuser.headers)) if b["name"] == "IT")
    ok(client.put("/api/blocks/" + block["block_id"] + "/leader", headers=superuser.headers,
                  json={"user_id": master.user_id, "expected_revision": block["revision"]}))
    banned, archived = make_user(banned=True), make_user(surname="Архивный")
    with db._session() as s:
        s.get(UserORM, archived.user_id).account_state = "archived"
        s.commit()
    return dict(w, superuser=superuser, master=master, banned=banned, archived=archived)


def test_single_contact_is_the_filtered_list_entry(client, people):
    w = people
    targets = [w["head"], w["lead"], w["outsider"], w["master"], w["banned"], w["archived"], w["superuser"]]
    for actor in (w["superuser"], w["outsider"], w["master"]):
        full = ok(client.get("/api/contacts", headers=actor.headers))
        for target in targets:
            single = ok(client.get("/api/contacts", headers=actor.headers, params={"user_id": target.user_id}))
            assert single == [c for c in full if c["user_id"] == target.user_id]
            searched = ok(client.get("/api/contacts", headers=actor.headers,
                                     params={"user_id": target.user_id, "q": "Мастеров"}))
            assert searched == [c for c in ok(client.get("/api/contacts", headers=actor.headers, params={"q": "Мастеров"}))
                                if c["user_id"] == target.user_id]
        assert ok(client.get("/api/contacts", headers=actor.headers, params={"user_id": 987654})) == []
    assert ok(client.get("/api/contacts", headers=w["outsider"].headers, params={"user_id": w["head"].user_id}))
    assert ok(client.get("/api/contacts", headers=w["outsider"].headers, params={"user_id": w["banned"].user_id})) == []
    assert client.get("/api/contacts", params={"user_id": w["head"].user_id}).status_code == 401


def separate_passes(uid):
    with db._session() as s:
        return (profile_features.available_scopes(s, uid, profile_features.award_manager),
                profile_features.available_scopes(s, uid, profile_features.kkr_manager))


def test_feature_scopes_in_one_pass_equal_the_separate_passes(client, people):
    w = people
    kinds = set()
    for actor in (w["superuser"], w["master"], w["head"], w["lead"], w["organizer"], w["outsider"], w["curator"]):
        awards, templates = separate_passes(actor.user_id)
        context = ok(client.get("/api/profile/me/features-context", headers=actor.headers))
        assert context["award_scopes"] == awards and context["template_scopes"] == templates
        assert context["can_create_personal_template"] == bool(templates)
        flags = ok(client.get("/api/profile/me/features-flags", headers=actor.headers))
        assert flags == {"has_award_scopes": bool(awards), "can_create_personal_template": bool(templates)}
        kinds |= {(name, scope["kind"]) for name, scopes in (("award", awards), ("template", templates)) for scope in scopes}
    assert {("award", "global"), ("award", "block"), ("template", "event"), ("template", "subevent")} <= kinds
    assert client.get("/api/profile/me/features-flags").status_code == 401
