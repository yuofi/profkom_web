"""Registration decision metadata comes from the saved transition, never today's roles."""
import json
from datetime import datetime
import pytest
from database import db, UserORM
from domain_models import RegistrationORM
from test_v13_registration import signup


@pytest.mark.parametrize("command,outcome", [("approve", "approved"), ("reject", "rejected")])
def test_decision_actor_time_visible_to_applicant_and_reviewers(client, superuser, command, outcome):
    headers, app = signup(client)
    assert app["decision"] is None
    response = client.post(f"/api/registrations/{app['user_id']}/{command}", headers=superuser.headers,
                           json={"expected_revision": app["revision"], "reason": "Проверено"})
    assert response.status_code == 200, response.text
    decision = response.json()["decision"]
    assert decision["outcome"] == outcome
    assert decision["actor"]["user_id"] == superuser.user_id
    assert decision["actor"]["display_name"]
    assert datetime.fromisoformat(decision["at"]).tzinfo is not None
    assert set(decision) == {"outcome", "actor", "at"}
    assert client.get("/api/registrations/me", headers=headers).json()["decision"] == decision
    rows = client.get("/api/registrations", headers=superuser.headers).json()["items"]
    assert next(row for row in rows if row["user_id"] == app["user_id"])["decision"] == decision
    assert "history_json" not in response.json()


def test_reset_keeps_decision_resubmission_clears_it_and_next_decision_replaces_it(client, superuser):
    headers, app = signup(client)
    path = f"/api/registrations/{app['user_id']}"
    def command(name, reason="Уточните"):
        return client.post(f"{path}/{name}", headers=superuser.headers,
                           json={"expected_revision": app["revision"], "reason": reason}).json()
    app = command("reject")
    old = app["decision"]
    app = command("reset-attempts")
    assert app["decision"] == old
    app = client.post("/api/registrations/me/resubmit", headers=headers, json={"expected_revision": app["revision"]}).json()
    assert app["status"] == "pending" and app["decision"] is None
    app = command("approve")
    assert app["decision"]["outcome"] == "approved"
    assert app["decision"]["at"] != old["at"]


@pytest.mark.parametrize("history", ["broken", "{}", "[]", '[{"action":"approve","actor":true,"at":"bad"}]', '[{"action":"approve","actor":99999999,"at":"2020-01-01"}]'])
def test_legacy_decision_gaps_are_explicit_and_reads_do_not_repair(client, superuser, history):
    headers, app = signup(client)
    with db._session() as s:
        row = s.get(RegistrationORM, app["user_id"])
        row.status = "approved"
        row.history_json = history
        s.commit()
    decision = client.get("/api/registrations/me", headers=headers).json()["decision"]
    assert decision == {"outcome": "approved", "actor": None, "at": None}
    with db._session() as s:
        assert s.get(RegistrationORM, app["user_id"]).history_json == history


def test_purged_reviewer_is_anonymous(client, superuser, make_user):
    headers, app = signup(client)
    reviewer = make_user()
    with db._session() as s:
        row = s.get(RegistrationORM, app["user_id"])
        row.status = "rejected"
        row.history_json = json.dumps([{"action": "reject", "actor": reviewer.user_id, "at": "2026-11-10T08:12:00+00:00"}])
        s.get(UserORM, reviewer.user_id).account_state = "purged"
        s.commit()
    decision = client.get("/api/registrations/me", headers=headers).json()["decision"]
    assert decision["actor"] == {"user_id": None, "display_name": "Обезличенный участник", "avatar_url": None}
