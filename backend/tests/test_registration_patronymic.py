"""Registration needs a patronymic or an explicit, persisted absence decision."""
import json

import pytest

from database import ContactInfoORM, db
from domain_models import RegistrationORM
from test_auth_register import body


@pytest.mark.parametrize("value", [None, "", "   ", "\t\n"])
def test_blank_patronymic_requires_explicit_choice(client, value):
    response = client.post("/api/auth/register", json=body(patronymic=value))
    assert response.status_code == 422
    with db._session() as session:
        assert session.query(ContactInfoORM).count() == 0


@pytest.mark.parametrize("value", [None, "", "   "])
def test_explicit_no_patronymic_is_saved_in_application(client, value):
    response = client.post("/api/auth/register", json=body(patronymic=value, no_patronymic=True))
    assert response.status_code == 201
    headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    application = client.get("/api/registrations/me", headers=headers).json()
    assert application["fields"]["no_patronymic"] is True
    assert application["fields"]["patronymic"] is None
    with db._session() as session:
        saved = session.get(RegistrationORM, application["user_id"])
        assert json.loads(saved.fields_json)["no_patronymic"] is True
        assert session.get(ContactInfoORM, application["user_id"]).patronymic == ""


@pytest.mark.parametrize("patch", [
    {"patronymic": "Иванович", "no_patronymic": True},
    {"patronymic": "", "no_patronymic": "true"},
    {"patronymic": "", "no_patronymic": 1},
    {"patronymic": "", "no_patronymic": None},
    {"patronymic": "А" * 101},
])
def test_conflicting_or_unchecked_decisions_are_rejected(client, patch):
    assert client.post("/api/auth/register", json=body(**patch)).status_code == 422


def test_nonempty_patronymic_is_trimmed_without_an_absence_decision(client):
    response = client.post("/api/auth/register", json=body(patronymic="  Иванович  "))
    assert response.status_code == 201
    headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    fields = client.get("/api/registrations/me", headers=headers).json()["fields"]
    assert fields["patronymic"] == "Иванович" and fields["no_patronymic"] is False


def test_vk_application_requires_own_choice_and_can_be_approved_without_patronymic(
    client, superuser, mock_vk
):
    mock_vk(user_id="4242")
    signed = client.post("/api/auth/vk", json={"access_token": "synthetic-vk-token"})
    assert signed.status_code == 200
    headers = {"Authorization": "Bearer " + signed.json()["access_token"]}
    application = client.get("/api/registrations/me", headers=headers).json()
    assert application["fields"]["no_patronymic"] is False
    fields = {key: value for key, value in body(patronymic=None).items() if key != "password"}
    fields["group_number"] = str(fields["group_number"])
    refused = client.patch("/api/registrations/me", headers=headers,
                           json={"expected_revision": application["revision"], "fields": fields})
    assert refused.status_code == 422
    unchanged = client.get("/api/registrations/me", headers=headers).json()
    assert unchanged == application
    fields["no_patronymic"] = True
    saved = client.patch("/api/registrations/me", headers=headers,
                         json={"expected_revision": application["revision"], "fields": fields})
    assert saved.status_code == 200
    approved = client.post(f"/api/registrations/{application['user_id']}/approve", headers=superuser.headers,
                           json={"expected_revision": saved.json()["revision"]})
    assert approved.status_code == 200
    assert approved.json()["fields"]["no_patronymic"] is True
    assert client.get("/api/profile/me", headers=headers).json()["patronymic"] == ""


def test_old_empty_patronymic_does_not_implicitly_check_absence(client, make_user):
    person = make_user(patronymic="")
    application = client.get("/api/registrations/me", headers=person.headers).json()
    assert application["fields"]["no_patronymic"] is False
    assert application["fields"]["patronymic"] is None


def test_legacy_pending_application_without_decision_has_no_approval_capability(client, superuser):
    response = client.post("/api/auth/register", json=body())
    headers = {"Authorization": "Bearer " + response.json()["access_token"]}
    application = client.get("/api/registrations/me", headers=headers).json()
    with db._session() as session:
        row = session.get(RegistrationORM, application["user_id"])
        fields = json.loads(row.fields_json)
        fields.pop("no_patronymic")
        fields["patronymic"] = None
        row.fields_json = json.dumps(fields)
        session.commit()
    reviewed = client.get("/api/registrations", headers=superuser.headers).json()["items"]
    row = next(item for item in reviewed if item["user_id"] == application["user_id"])
    assert "approve_registration" not in row["capabilities"]
    assert row["fields"]["no_patronymic"] is False
    assert client.post(f"/api/registrations/{application['user_id']}/approve", headers=superuser.headers,
                       json={"expected_revision": row["revision"]}).status_code == 422
