import pytest
from database import db
from test_v13_access_contract import REGISTER


def signup(client):
    r = client.post("/api/auth/register", json=REGISTER)
    assert r.status_code == 201
    h = {"Authorization": "Bearer " + r.json()["access_token"]}
    return h, client.get("/api/registrations/me", headers=h).json()


def test_registration_approval_and_contact_preservation(client, superuser):
    h, r = signup(client)
    assert r["attempts_used"] == 1 and r["status"] == "pending"
    assert client.get("/api/registrations", headers=h).status_code == 403
    a = client.post(
        f"/api/registrations/{r['user_id']}/approve",
        headers=superuser.headers,
        json={"expected_revision": r["revision"]},
    )
    assert a.status_code == 200, a.text
    assert a.json()["status"] == "approved"
    assert client.get("/api/session", headers=h).json()["account_state"] == "active"
    p = client.get("/api/profile/me", headers=h).json()
    assert p["phone"] == REGISTER["phone"] and p["in_profcom"] is True
    assert client.get("/api/contacts", headers=h).status_code == 200


def test_registration_resubmissions_limit_and_reset(client, superuser):
    h, r = signup(client)
    uid = r["user_id"]
    for n in range(1, 6):
        assert r["attempts_used"] == n
        r = client.post(
            f"/api/registrations/{uid}/reject",
            headers=superuser.headers,
            json={"expected_revision": r["revision"], "reason": "Уточнить"},
        ).json()
        if n < 5:
            old = r["revision"]
            r = client.post(
                "/api/registrations/me/resubmit",
                headers=h,
                json={"expected_revision": old},
            ).json()
            assert r["total_submissions"] == n + 1
            assert (
                client.post(
                    "/api/registrations/me/resubmit",
                    headers=h,
                    json={"expected_revision": old},
                ).status_code
                == 409
            )
    assert (
        client.post(
            "/api/registrations/me/resubmit",
            headers=h,
            json={"expected_revision": r["revision"]},
        ).status_code
        == 409
    )
    reset = client.post(
        f"/api/registrations/{uid}/reset-attempts",
        headers=superuser.headers,
        json={"expected_revision": r["revision"], "reason": "Исправлена ошибка"},
    ).json()
    assert (
        reset["attempts_used"] == 0
        and reset["total_submissions"] == 5
        and reset["status"] == "rejected"
    )
    assert (
        client.get("/api/session", headers=h).json()["registration_status"]
        == "rejected"
    )


def test_incomplete_application_cannot_be_approved(client, superuser, mock_vk):
    """A VK account starts with an empty group and no study basis chosen (A-ROL-20)."""
    mock_vk(user_id="4242")
    r = client.post("/api/auth/vk", json={"access_token": "vk-token"})
    assert r.status_code == 200, r.text
    h = {"Authorization": "Bearer " + r.json()["access_token"]}
    a = client.get("/api/registrations/me", headers=h).json()
    assert a["fields"]["group_number"] == "" and a["fields"]["funding"] is None
    assert (
        client.post(
            f"/api/registrations/{a['user_id']}/approve",
            headers=superuser.headers,
            json={"expected_revision": a["revision"]},
        ).status_code
        == 422
    )
    assert client.get("/api/session", headers=h).json()["account_state"] == "pending"

def submitted_notices(superuser):
    from database import NotificationORM

    with db._session() as s:
        return s.query(NotificationORM).filter_by(user_id=superuser.user_id, kind="registration_submitted").count()


def vk_applicant(client, mock_vk, vk_id="5151"):
    mock_vk(user_id=vk_id)
    r = client.post("/api/auth/vk", json={"access_token": "vk-token"})
    assert r.status_code == 200, r.text
    h = {"Authorization": "Bearer " + r.json()["access_token"]}
    return h, client.get("/api/registrations/me", headers=h).json()


def filled(application, **changes):
    fields = {**application["fields"], **{k: v for k, v in REGISTER.items() if k in application["fields"] and k != "email"}}
    return {**fields, "email": application["fields"]["email"], "group_number": str(REGISTER["group_number"]), **changes}


@pytest.mark.parametrize("group", ["ВМК-3курс", "ABC", "0", "99999", "99", "701", ""])
def test_application_group_is_a_number_from_100_to_700(client, group):
    """A-ROL-17: the same rule as the sign-up and the profile; a bad group is 422."""
    h, a = signup(client)
    r = client.patch("/api/registrations/me", headers=h,
                     json={"expected_revision": a["revision"], "fields": filled(a, group_number=group)})
    assert r.status_code == 422, r.text
    ok = client.patch("/api/registrations/me", headers=h,
                      json={"expected_revision": a["revision"], "fields": filled(a, group_number=" 305 ")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["fields"]["group_number"] == "305"


def test_vk_application_reaches_reviewers_once_complete(client, superuser, mock_vk):
    """A-ROL-20: a VK account starts incomplete and silent; the first complete save notifies."""
    before = submitted_notices(superuser)
    h, a = vk_applicant(client, mock_vk)
    assert a["status"] == "pending" and a["fields"]["funding"] is None
    assert submitted_notices(superuser) == before
    saved = client.patch("/api/registrations/me", headers=h,
                         json={"expected_revision": a["revision"], "fields": filled(a, funding="contract")})
    assert saved.status_code == 200, saved.text
    assert submitted_notices(superuser) == before + 1
    again = client.patch("/api/registrations/me", headers=h,
                         json={"expected_revision": saved.json()["revision"], "fields": filled(saved.json(), residence="Москва, ДАС", funding="contract")})
    assert again.status_code == 200 and submitted_notices(superuser) == before + 1
    approved = client.post(f"/api/registrations/{a['user_id']}/approve", headers=superuser.headers,
                           json={"expected_revision": again.json()["revision"]})
    assert approved.status_code == 200, approved.text
    assert db.get_contact(a["user_id"]).budget is False


def test_application_email_is_unique_regardless_of_case(client):
    """A-ROL-16: another account's address in other letters is still taken."""
    signup(client)
    other = client.post("/api/auth/register", json={**REGISTER, "email": "second@example.com", "tg": "second_tg"})
    assert other.status_code == 201, other.text
    h = {"Authorization": "Bearer " + other.json()["access_token"]}
    a = client.get("/api/registrations/me", headers=h).json()
    taken = client.patch("/api/registrations/me", headers=h,
                         json={"expected_revision": a["revision"], "fields": {**a["fields"], "email": REGISTER["email"].upper()}})
    assert taken.status_code == 409, taken.text
    assert client.post("/api/auth/register", json={**REGISTER, "email": REGISTER["email"].title()}).status_code == 409


def test_queue_puts_waiting_first_and_filters_by_status(client, superuser):
    """A-ROL-21: pending, then rejected, then approved; a status shows only its own."""
    ids = []
    for n in range(3):
        r = client.post("/api/auth/register", json={**REGISTER, "email": f"queue{n}@example.com", "tg": f"queue_tg{n}"})
        assert r.status_code == 201, r.text
        h = {"Authorization": "Bearer " + r.json()["access_token"]}
        ids.append(client.get("/api/registrations/me", headers=h).json())
    approved, rejected, pending = ids
    client.post(f"/api/registrations/{approved['user_id']}/approve", headers=superuser.headers,
                json={"expected_revision": approved["revision"]})
    client.post(f"/api/registrations/{rejected['user_id']}/reject", headers=superuser.headers,
                json={"expected_revision": rejected["revision"], "reason": "Уточните группу"})
    queue = client.get("/api/registrations", headers=superuser.headers).json()["items"]
    states = [r["status"] for r in queue]
    assert states == sorted(states, key=["pending", "rejected", "approved"].index)
    mine = [r["user_id"] for r in queue if r["user_id"] in {x["user_id"] for x in ids}]
    assert mine == [pending["user_id"], rejected["user_id"], approved["user_id"]]
    only = client.get("/api/registrations", params={"status": "rejected"}, headers=superuser.headers).json()["items"]
    assert {r["status"] for r in only} == {"rejected"} and rejected["user_id"] in {r["user_id"] for r in only}
    assert client.get("/api/registrations", params={"status": "lost"}, headers=superuser.headers).status_code == 422


def test_dashboard_counts_waiting_registrations_for_reviewers(client, superuser, user):
    signup(client)
    waiting = client.get("/api/registrations", params={"status": "pending"}, headers=superuser.headers).json()["items"]
    assert client.get("/api/dashboard", headers=superuser.headers).json()["pending_registration_count"] == len(waiting) > 0
    assert client.get("/api/dashboard", headers=user.headers).json()["pending_registration_count"] == 0
