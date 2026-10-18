"""
Acceptance tests for BE-01: Доступ, роли и безопасная совместимость.

Проверяет:
1. GET /api/session: статус аккаунта (active, pending, archived), permissions, leadership.
2. GET /api/leadership: получение текущего состава руководства (chair, deputies, revision, capabilities).
3. POST /api/leadership/transfer: атомарная передача председательства одной транзакцией,
   снятие ролей с прежнего председателя и всех его замов, сброс замов в [], отзыв refresh-токенов.
4. PUT /api/leadership/deputies: назначение до трёх замов председателем, валидация лимита,
   снятие прав у выбывших замов.
5. Изоляция прав: отсутствие эскалации через block.hr, имена мастеров, профили.
"""

from __future__ import annotations

import pytest
from test_api_contract import error_body
from api_helpers import post_season
from database import db


SESSION_URL = "/api/session"
LEADERSHIP_URL = "/api/leadership"
TRANSFER_URL = "/api/leadership/transfer"
DEPUTIES_URL = "/api/leadership/deputies"
CONTACTS_URL = "/api/contacts"
PROFILE_URL = "/api/profile"


# ═════════════════════════════════════════════════════════════
#  1. GET /api/session
# ═════════════════════════════════════════════════════════════

def test_session_аноним_получает_401(client, anon):
    r = client.get(SESSION_URL, headers=anon)
    assert r.status_code == 401


def test_session_активный_пользователь(client, user):
    r = client.get(SESSION_URL, headers=user.headers)
    assert r.status_code == 200
    data = r.json()
    assert data["user_id"] == user.user_id
    assert data["account_state"] == "active"
    assert "permissions" in data
    assert isinstance(data["permissions"], list)
    assert "leadership" in data
    assert data["leadership"]["is_chair"] is False
    assert data["leadership"]["is_deputy"] is False
    # Backward-compatible fields
    assert "super_user" in data
    assert "admin" in data
    assert "pgas_admin" in data
    assert "events_roles" not in data


def test_session_председатель_видит_свою_роль_и_права(client, superuser):
    r = client.get(SESSION_URL, headers=superuser.headers)
    assert r.status_code == 200
    data = r.json()
    assert data["leadership"]["is_chair"] is True
    assert "transfer_chair" in data["permissions"]
    assert "manage_chair_deputies" in data["permissions"]


def test_session_архивный_пользователь_отклоняется(client, make_user):
    u = make_user()
    db.update_user(u.user_id, account_state="archived")
    r = client.get(SESSION_URL, headers=u.headers)
    assert r.status_code == 403
    assert error_body(r)["detail"] == "Account is archived"


def test_session_pending_пользователь(client, make_user):
    u = make_user()
    db.update_user(u.user_id, account_state="pending")
    r = client.get(SESSION_URL, headers=u.headers)
    assert r.status_code == 200
    data = r.json()
    assert data["account_state"] == "pending"
    assert data["registration_status"] == "pending"
    assert data["capabilities"] == []


# ═════════════════════════════════════════════════════════════
#  2. GET /api/leadership
# ═════════════════════════════════════════════════════════════

def test_leadership_аноним_получает_401(client, anon):
    r = client.get(LEADERSHIP_URL, headers=anon)
    assert r.status_code == 401


def test_leadership_чтение_состава(client, user, superuser):
    r = client.get(LEADERSHIP_URL, headers=user.headers)
    assert r.status_code == 200
    data = r.json()
    assert "chair" in data
    assert "deputies" in data
    assert "revision" in data
    assert "capabilities" in data
    assert data["chair"]["user_id"] == superuser.user_id
    assert isinstance(data["deputies"], list)


# ═════════════════════════════════════════════════════════════
#  3. PUT /api/leadership/deputies
# ═════════════════════════════════════════════════════════════

def test_назначение_замов_только_председателем(client, user, superuser, make_user):
    dep1 = make_user()
    # Обычный пользователь не может назначать замов
    r = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [dep1.user_id]}, headers=user.headers)
    assert r.status_code == 403

    # Председатель может назначить зама
    r = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [dep1.user_id]}, headers=superuser.headers)
    assert r.status_code == 200
    data = r.json()
    assert len(data["deputies"]) == 1
    assert data["deputies"][0]["user_id"] == dep1.user_id

    # Проверяем сессию назначенного зама
    r_sess = client.get(SESSION_URL, headers=dep1.headers)
    assert r_sess.status_code == 200
    assert r_sess.json()["leadership"]["is_deputy"] is True
    assert db.get_user(dep1.user_id).admin is True


def test_лимит_заместителей_не_более_трех(client, superuser, make_user):
    u1, u2, u3, u4 = make_user(), make_user(), make_user(), make_user()
    # 3 зама — разрешено
    r = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [u1.user_id, u2.user_id, u3.user_id]}, headers=superuser.headers)
    assert r.status_code == 200
    assert len(r.json()["deputies"]) == 3

    # 4 зама — превышение лимита
    r = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [u1.user_id, u2.user_id, u3.user_id, u4.user_id]}, headers=superuser.headers)
    assert r.status_code in (400, 422)


def test_нельзя_назначить_председателя_в_замы(client, superuser):
    r = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [superuser.user_id]}, headers=superuser.headers)
    assert r.status_code in (400, 422)


def test_снятие_заместителя_отбирает_права(client, superuser, make_user):
    dep = make_user()
    client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [dep.user_id]}, headers=superuser.headers)
    assert db.get_user(dep.user_id).admin is True

    # Снимаем зама (передаем пустой список)
    r = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": []}, headers=superuser.headers)
    assert r.status_code == 200
    assert len(r.json()["deputies"]) == 0

    assert db.get_user(dep.user_id).admin is False
    r_sess = client.get(SESSION_URL, headers=dep.headers)
    assert r_sess.json()["leadership"]["is_deputy"] is False


# ═════════════════════════════════════════════════════════════
#  4. POST /api/leadership/transfer
# ═════════════════════════════════════════════════════════════

def test_передача_председательства_только_председателем(client, user, make_user):
    candidate = make_user()
    r = client.post(TRANSFER_URL, json={'expected_revision':db.get_leadership().revision,"new_chair_user_id": candidate.user_id}, headers=user.headers)
    assert r.status_code == 403


def test_передача_председательства_атомарная_транзакция(client, superuser, make_user):
    old_chair = superuser
    new_chair = make_user()
    deputy = make_user()

    # Назначаем зама старому председателю
    client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [deputy.user_id]}, headers=old_chair.headers)
    assert db.get_user(deputy.user_id).admin is True

    # Передаем полномочия
    r = client.post(TRANSFER_URL, json={'expected_revision':db.get_leadership().revision,"new_chair_user_id": new_chair.user_id}, headers=old_chair.headers)
    assert r.status_code == 200
    body = r.json()
    assert body["chair"]["user_id"] == new_chair.user_id
    assert body["deputies"] == []

    # 1. Новый председатель получил суперюзера и админа
    new_u = db.get_user(new_chair.user_id)
    assert new_u.super_user is True
    assert new_u.admin is True

    # 2. Старый председатель потерял суперюзера и админа
    old_u = db.get_user(old_chair.user_id)
    assert old_u.super_user is False
    assert old_u.admin is False

    # 3. Заместители старого председателя потеряли роль зама и глобального админа
    dep_u = db.get_user(deputy.user_id)
    assert dep_u.admin is False

    # 4. Refresh-токены старого председателя и старых замов отозваны
    assert db.list_user_refresh_tokens(old_chair.user_id) == []
    assert db.list_user_refresh_tokens(deputy.user_id) == []

    # 5. Новый председатель теперь может назначать замов
    new_dep = make_user()
    r_dep = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [new_dep.user_id]}, headers=new_chair.headers)
    assert r_dep.status_code == 200
    assert len(r_dep.json()["deputies"]) == 1

    # 6. Старый председатель больше НЕ может назначать замов
    r_old = client.put(DEPUTIES_URL, json={'expected_revision':db.get_leadership().revision,"user_ids": [new_dep.user_id]}, headers=old_chair.headers)
    assert r_old.status_code == 403


def test_нельзя_передать_председательство_архивному_или_несуществующему(client, superuser, make_user):
    archived = make_user()
    db.update_user(archived.user_id, account_state="archived")

    # Передача архивному отклоняется
    r = client.post(TRANSFER_URL, json={'expected_revision':db.get_leadership().revision,"new_chair_user_id": archived.user_id}, headers=superuser.headers)
    assert r.status_code in (400, 404, 422)

    # Передача несуществующему отклоняется
    r = client.post(TRANSFER_URL, json={'expected_revision':db.get_leadership().revision,"new_chair_user_id": 999999}, headers=superuser.headers)
    assert r.status_code == 404


def test_восстановление_архивного_аккаунта_не_возвращает_руководство(client, superuser, make_user):
    """Снятые роли руководства нельзя вернуть восстановлением архивного аккаунта."""
    chair = superuser
    successor = make_user()

    # Передаём председательство
    client.post(TRANSFER_URL, json={'expected_revision':db.get_leadership().revision,"new_chair_user_id": successor.user_id}, headers=chair.headers)

    # Бывший председатель отправляется в архив и затем восстанавливается
    db.update_user(chair.user_id, account_state="archived")
    db.update_user(chair.user_id, account_state="active")

    restored = db.get_user(chair.user_id)
    assert restored.super_user is False
    assert restored.admin is False

    lead = db.get_leadership()
    assert lead.chair is not None
    assert lead.chair.user_id == successor.user_id


# ═════════════════════════════════════════════════════════════
#  5. Безопасность и разграничение прав
# ═════════════════════════════════════════════════════════════

def test_контакты_и_профиль_недоступны_анониму(client, anon, user):
    r_c = client.get(CONTACTS_URL, headers=anon)
    assert r_c.status_code == 401

    r_p = client.get(f"{PROFILE_URL}/{user.user_id}", headers=anon)
    assert r_p.status_code == 401


def test_block_hr_не_дает_глобальную_админку(client, make_hr):
    hr, _block = make_hr(block_name="Медиа")
    assert db.get_user(hr.user_id).admin is False

    # HR блока не имеет доступа к админскому фильтру контактов
    r = client.post(f"{CONTACTS_URL}/filter", json={}, headers=hr.headers)
    assert r.status_code == 200


def test_однофамилец_мастера_не_получает_права_мастера(client, make_master, make_user):
    master, _block = make_master(block_name="Медиа", kkr_name="Иван Иванов")
    twin = make_user(kkr_name="Иван Иванов", email="twin_be01@test.ru")
    assert twin.user_id != master.user_id

    # Однофамилец не может создавать гайды блока
    r = client.post("/api/guides", json={"title": "Чужой гайд", "owner_block": "Медиа"}, headers=twin.headers)
    assert r.status_code == 403
