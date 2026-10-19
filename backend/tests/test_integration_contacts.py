import pytest
from test_v13_access_contract import REGISTER


@pytest.mark.parametrize("tg,vk,normalized_tg,normalized_vk", [
    ("@valid_user", "id1", "@valid_user", "id1"),
    ("valid_user", "ivan2", "valid_user", "ivan2"),
    ("https://t.me/valid_user/", "vk.com/id1", "@valid_user", "https://vk.com/id1"),
    ("  valid_user  ", " https://vk.com/u/ ", "valid_user", "https://vk.com/u"),
])
def test_contact_syntax_consistent_across_registration_application_profile(client, superuser, tg, vk, normalized_tg, normalized_vk):
    signup = client.post("/api/auth/register", json={**REGISTER, "tg": tg, "vk": vk, "patronymic": ""})
    assert signup.status_code == 201, signup.text
    headers = {"Authorization": "Bearer " + signup.json()["access_token"]}
    application = client.get("/api/registrations/me", headers=headers).json()
    assert application["fields"]["tg"] == normalized_tg
    assert application["fields"]["vk"] == normalized_vk
    edited = client.patch("/api/registrations/me", headers=headers,
                          json={"expected_revision": application["revision"], "fields": {**application["fields"], "tg": tg, "vk": vk, "patronymic": None}})
    assert edited.status_code == 200, edited.text
    approved = client.post(f"/api/registrations/{application['user_id']}/approve", headers=superuser.headers,
                           json={"expected_revision": edited.json()["revision"]})
    assert approved.status_code == 200, approved.text
    response = client.patch(f"/api/profile/{application['user_id']}", headers=headers,
                            json={"surname": "Исправлена", "tg": tg, "vk": vk, "patronymic": ""})
    assert response.status_code == 200, response.text
    own = client.get("/api/profile/me", headers=headers).json()
    assert (own["tg"], own["vk"], own["patronymic"], own["surname"]) == (normalized_tg, normalized_vk, "", "Исправлена")


@pytest.mark.parametrize("field,value", [("tg", "@ёжик"), ("tg", "https://evil.test/user_name"), ("vk", "javascript:alert(1)"), ("vk", "https://vk.com.evil.test/id1")])
def test_invalid_contacts_refused_without_partial_profile_changes(client, user, field, value):
    assert client.post("/api/auth/register", json={**REGISTER, field: value}).status_code == 422
    own = client.get("/api/profile/me", headers=user.headers).json()
    response = client.patch(f"/api/profile/{user.user_id}", headers=user.headers, json={field: value, "surname": "Must not persist"})
    assert response.status_code == 422
    assert client.get("/api/profile/me", headers=user.headers).json()["surname"] == own["surname"]
