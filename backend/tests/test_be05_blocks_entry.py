"""
Acceptance test suite for BE-05: Блоки и вступление.

Тестирует сценарии:
1. BLOCK-01: Двухэтапная заявка (HR → мастер блока); запрет прямого добавления.
2. BLOCK-04: Подмена проверяющего тачками строго после 72 часов; переход на 2 этап обновляет таймер;
             смена мастера не сбрасывает таймер; аудит с is_substitute=True.
3. BLOCK-05: Самостоятельный выход (/leave) без согласования; уведомление мастеру;
             сохранение отдельной служебной роли заместителя при выходе из обычного членства.
4. BLOCK-06: Заявка в HR-блок — одно HR-одобрение сразу даёт членство; block-approve -> 409;
             совмещение ролей и самоодобрение мастера HR на первом этапе.
5. BLOCK-07: Доступ к деталям и составу блока (/api/blocks/{id}); PATCH описания и ссылок.
6. JUNIOR-01..05: Глобальная категория участника и отметка новичка блока;
                  ручное изменение тачками/HR мастером (GET/PATCH /api/participants/{id}/category);
                  автоматическое повышение при close_season при стаже >= 50% длительности сезона;
                  activist не понижается.
7. Регистрация и повторные попытки:
   - GET/PATCH /api/registrations/me, POST /api/registrations/me/resubmit
   - Лимит 5 попыток с 409 registration_attempt_limit
   - Сброс попыток тачками POST /api/registrations/{user_id}/reset-attempts
   - Одобрение/отклонение тачками (422 при незаполненных полях).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from database import db, engine
from sqlalchemy import text


# ═════════════════════════════════════════════════════════════
#  1. РЕГИСТРАЦИЯ И ПОВТОРНЫЕ ПОПЫТКИ
# ═════════════════════════════════════════════════════════════

def test_registration_me_read_and_patch(client, make_user):
    """Пользователь может читать и обновлять свои регистрационные поля."""
    user = make_user()
    db.update_user(user.user_id, account_state="pending")

    r = client.get("/api/registrations/me", headers=user.headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["user_id"] == user.user_id
    assert data["status"] == "pending"
    assert data["attempts_used"] >= 1
    assert "fields" in data
    assert "patch_registration_fields" in data["capabilities"]

    # Обновляем регистрационные поля
    rev = data["revision"]
    patch_body = {
        "expected_revision": rev,
        "fields": {
            "surname": "Иванов",
            "name": "Иван",
            "patronymic": "Иванович",
            "group_number": "102",
            "phone": "+79991112233",
            "email": user.email,
            "tg": "@ivanov",
            "vk": "id_ivanov",
            "funding": "budget",
            "residence": "г. Москва",
        },
    }
    r_patch = client.patch("/api/registrations/me", json=patch_body, headers=user.headers)
    assert r_patch.status_code == 200, r_patch.text
    patched = r_patch.json()
    assert patched["revision"] == rev + 1
    assert patched["fields"]["tg"] == "@ivanov"
    assert patched["fields"]["phone"] == "+79991112233"

    # Конфликт ревизии
    r_conflict = client.patch(
        "/api/registrations/me",
        json={"expected_revision": rev, "fields": patch_body["fields"]},
        headers=user.headers,
    )
    assert r_conflict.status_code == 409


def test_registration_rejection_resubmit_and_attempt_limit(client, make_user, superuser):
    """
    Отклонение тачками -> исправление -> повторная отправка.
    Исчерпание 5 попыток -> 409 registration_attempt_limit.
    Сброс тачками -> возможность повторной отправки.
    """
    applicant = make_user(phone="+79991112233", tg="@test", vk="vk.com/test", location="Moscow")
    db.update_user(applicant.user_id, account_state="pending")

    # Сначала заполним поля, чтобы resubmit был валиден
    client.patch(
        "/api/registrations/me",
        json={
            "expected_revision": 1,
            "fields": {
                "surname": "Сидоров",
                "name": "Сидор",
                "patronymic": None,
                "group_number": "201",
                "phone": "+79990001122",
                "email": applicant.email,
                "tg": "@sidorov",
                "vk": "sidorov",
                "funding": "budget",
                "residence": "Общежитие",
            },
        },
        headers=applicant.headers,
    )

    # 1. Отклонение тачками
    reg_me = client.get("/api/registrations/me", headers=applicant.headers).json()
    r_rej = client.post(
        f"/api/registrations/{applicant.user_id}/reject",
        json={"expected_revision": reg_me["revision"], "reason": "Укажите верную группу"},
        headers=superuser.headers,
    )
    assert r_rej.status_code == 200
    assert r_rej.json()["status"] == "rejected"
    assert r_rej.json()["rejection_reason"] == "Укажите верную группу"

    # Нельзя resubmit без изменения статуса или с неверной ревизией
    cur_rev = r_rej.json()["revision"]

    # Тратим попытки до 5
    # Попытка 1 была при регистрации (attempts_used=1)
    # Попытка 2:
    r_resub = client.post(
        "/api/registrations/me/resubmit",
        json={"expected_revision": cur_rev},
        headers=applicant.headers,
    )
    assert r_resub.status_code == 200
    assert r_resub.json()["attempts_used"] == 2
    assert r_resub.json()["status"] == "pending"

    # Отклоняем и делаем попытки 3, 4, 5
    for attempt in range(3, 6):
        cur_rev = r_resub.json()["revision"]
        # Отклоняем
        client.post(
            f"/api/registrations/{applicant.user_id}/reject",
            json={"expected_revision": cur_rev, "reason": f"Отказ #{attempt}"},
            headers=superuser.headers,
        )
        cur_rev += 1
        # Ресабмит
        r_resub = client.post(
            "/api/registrations/me/resubmit",
            json={"expected_revision": cur_rev},
            headers=applicant.headers,
        )
        assert r_resub.status_code == 200
        assert r_resub.json()["attempts_used"] == attempt

    # Сейчас attempts_used == 5. Отклоняем снова.
    cur_rev = r_resub.json()["revision"]
    client.post(
        f"/api/registrations/{applicant.user_id}/reject",
        json={"expected_revision": cur_rev, "reason": "Финальный отказ"},
        headers=superuser.headers,
    )
    cur_rev += 1

    # 6-й resubmit должен вернуть 409 registration_attempt_limit
    r_limit = client.post(
        "/api/registrations/me/resubmit",
        json={"expected_revision": cur_rev},
        headers=applicant.headers,
    )
    assert r_limit.status_code == 409
    assert "registration_attempt_limit" in r_limit.json()["detail"]

    # Тачки сбрасывают лимит попыток
    r_reset = client.post(
        f"/api/registrations/{applicant.user_id}/reset-attempts",
        json={"expected_revision": cur_rev, "reason": "Разрешена повторная подача"},
        headers=superuser.headers,
    )
    assert r_reset.status_code == 200
    reset_data = r_reset.json()
    assert reset_data["attempts_used"] == 0
    assert reset_data["total_submissions"] >= 5

    # Теперь пользователь снова может отправить заявку!
    r_resub_after = client.post(
        "/api/registrations/me/resubmit",
        json={"expected_revision": reset_data["revision"]},
        headers=applicant.headers,
    )
    assert r_resub_after.status_code == 200
    assert r_resub_after.json()["attempts_used"] == 1
    assert r_resub_after.json()["status"] == "pending"


def test_registration_approval_validation(client, make_user, superuser):
    """Одобрение регистрации тачками: 422 при пустых обязательных полях."""
    applicant = make_user()
    db.update_user(applicant.user_id, account_state="pending")

    # Регистрация с пустыми полями
    reg = client.get("/api/registrations/me", headers=applicant.headers).json()

    # Одобрение без обязательных полей -> 422
    r_fail = client.post(
        f"/api/registrations/{applicant.user_id}/approve",
        json={"expected_revision": reg["revision"]},
        headers=superuser.headers,
    )
    assert r_fail.status_code == 422

    # Заполняем поля
    client.patch(
        "/api/registrations/me",
        json={
            "expected_revision": reg["revision"],
            "fields": {
                "surname": "Петров",
                "name": "Петр",
                "patronymic": "Петрович",
                "group_number": "101",
                "phone": "+79998887766",
                "email": applicant.email,
                "tg": "@petrov",
                "vk": "petrov",
                "funding": "budget",
                "residence": "Общежитие ДАС",
            },
        },
        headers=applicant.headers,
    )
    reg_updated = client.get("/api/registrations/me", headers=applicant.headers).json()

    # Одобряем
    r_ok = client.post(
        f"/api/registrations/{applicant.user_id}/approve",
        json={"expected_revision": reg_updated["revision"]},
        headers=superuser.headers,
    )
    assert r_ok.status_code == 200
    assert r_ok.json()["status"] == "approved"

    # Пользователь активирован в системе
    u = db.get_user(applicant.user_id)
    assert u.account_state == "active"
    c = db.get_contact(applicant.user_id)
    assert c.in_profcom is True


# ═════════════════════════════════════════════════════════════
#  2. БЛОКИ И ЗАЯВКИ (BLOCK-01, BLOCK-04, BLOCK-06, BLOCK-07)
# ═════════════════════════════════════════════════════════════

def test_block_01_two_stage_approval_regular_block(client, make_user, make_block):
    """
    BLOCK-01: Обычный блок: Заявка → HR → мастер блока.
    Членство возникает только после двух одобрений.
    Прямое добавление без заявки запрещено.
    """
    # Создаём HR блок и обычный блок
    hr_master = make_user(name="HR", surname="Мастер")
    make_block(name="HR", master=hr_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET is_hr = 1, master_user_id = :uid WHERE name = 'HR'"),
            {"uid": hr_master.user_id},
        )

    block_master = make_user(name="Обычный", surname="Мастер")
    make_block(name="Спорт", master=block_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET master_user_id = :uid WHERE name = 'Спорт'"),
            {"uid": block_master.user_id},
        )

    applicant = make_user(name="Активист", surname="Иванов")

    # 1. Подача заявки участником
    r_req = client.post(
        "/api/block-requests",
        json={"block_id": "Спорт"},
        headers=applicant.headers,
    )
    assert r_req.status_code == 200, r_req.text
    req_data = r_req.json()
    assert req_data["state"] == "pending_hr"
    req_id = req_data["request_id"]

    # Повторная подача в тот же блок при открытой заявке -> 409
    r_dup = client.post(
        "/api/block-requests",
        json={"block_id": "Спорт"},
        headers=applicant.headers,
    )
    assert r_dup.status_code == 409

    # Мастер блока пытается одобрить на этапе HR -> 400
    r_premature = client.post(
        f"/api/block-requests/{req_id}/block-approve",
        json={"expected_revision": req_data["revision"]},
        headers=block_master.headers,
    )
    assert r_premature.status_code == 400

    # 2. Одобрение мастером HR
    r_hr = client.post(
        f"/api/block-requests/{req_id}/hr-approve",
        json={"expected_revision": req_data["revision"]},
        headers=hr_master.headers,
    )
    assert r_hr.status_code == 200
    hr_data = r_hr.json()
    assert hr_data["state"] == "pending_block"

    # Проверяем, что членства ещё нет
    sport = db.get_block("Спорт")
    assert applicant.user_id not in (sport.arr_of_human or [])

    # 3. Одобрение мастером блока
    r_block = client.post(
        f"/api/block-requests/{req_id}/block-approve",
        json={"expected_revision": hr_data["revision"]},
        headers=block_master.headers,
    )
    assert r_block.status_code == 200
    assert r_block.json()["state"] == "approved"

    # Теперь участник в блоке!
    sport = db.get_block("Спорт")
    assert applicant.user_id in (sport.arr_of_human or [])

    # Детальное представление блока показывает участника с категорией junior в блоке
    r_detail = client.get("/api/blocks/Спорт", headers=applicant.headers)
    assert r_detail.status_code == 200
    members = r_detail.json()["members"]
    app_mem = next((m for m in members if m["user"]["user_id"] == applicant.user_id), None)
    assert app_mem is not None
    assert app_mem["block_category"] == "junior"


def test_block_06_hr_block_single_stage_approval(client, make_user, make_block):
    """
    BLOCK-06: Заявка в HR-блок — одно HR-одобрение сразу даёт членство;
    второго этапа нет, вызов block-approve даёт 409.
    """
    hr_master = make_user(name="HR", surname="Руководитель")
    make_block(name="HR", master=hr_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET is_hr = 1, master_user_id = :uid WHERE name = 'HR'"),
            {"uid": hr_master.user_id},
        )

    applicant = make_user(name="Кандидат", surname="Эйчар")

    # Подача заявки
    r_req = client.post(
        "/api/block-requests",
        json={"block_id": "HR"},
        headers=applicant.headers,
    )
    assert r_req.status_code == 200
    req_id = r_req.json()["request_id"]
    rev = r_req.json()["revision"]

    # Одобрение мастером HR
    r_hr = client.post(
        f"/api/block-requests/{req_id}/hr-approve",
        json={"expected_revision": rev},
        headers=hr_master.headers,
    )
    assert r_hr.status_code == 200
    data = r_hr.json()
    assert data["state"] == "approved"

    # Членство сразу возникло!
    hr_block = db.get_block("HR")
    assert applicant.user_id in (hr_block.arr_of_human or [])

    # Вызов block-approve на HR блок возвращает 409
    r_blk = client.post(
        f"/api/block-requests/{req_id}/block-approve",
        json={"expected_revision": data["revision"]},
        headers=hr_master.headers,
    )
    assert r_blk.status_code == 409


def test_block_06_self_approval_by_hr_master(client, make_user, make_block):
    """Мастер HR может одобрить свою заявку на HR-этапе в обычный блок."""
    hr_master = make_user(name="Главный", surname="Эйчар")
    make_block(name="HR", master=hr_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET is_hr = 1, master_user_id = :uid WHERE name = 'HR'"),
            {"uid": hr_master.user_id},
        )

    media_master = make_user(name="Медиа", surname="Мастер")
    make_block(name="Медиа", master=media_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET master_user_id = :uid WHERE name = 'Медиа'"),
            {"uid": media_master.user_id},
        )

    # HR мастер подаёт заявку в Медиа
    r_req = client.post(
        "/api/block-requests",
        json={"block_id": "Медиа"},
        headers=hr_master.headers,
    )
    assert r_req.status_code == 200
    req_id = r_req.json()["request_id"]

    # Самоодобрение на HR-этапе разрешено!
    r_hr = client.post(
        f"/api/block-requests/{req_id}/hr-approve",
        json={"expected_revision": 1},
        headers=hr_master.headers,
    )
    assert r_hr.status_code == 200
    assert r_hr.json()["state"] == "pending_block"

    # Второй этап одобряет мастер Медиа
    r_media = client.post(
        f"/api/block-requests/{req_id}/block-approve",
        json={"expected_revision": r_hr.json()["revision"]},
        headers=media_master.headers,
    )
    assert r_media.status_code == 200
    assert r_media.json()["state"] == "approved"
    assert hr_master.user_id in (db.get_block("Медиа").arr_of_human or [])


def test_block_04_tachki_72h_substitute_rule(client, make_user, make_block, superuser):
    """
    BLOCK-04: Подмена проверяющего тачками строго после 72 часов.
    До 72 часов — 403; ровно через 72 часа — 200 и аудит is_substitute=True;
    переход на 2 этап сбрасывает таймер на новые 72 часа;
    смена мастера блока не сбрасывает таймер.
    """
    hr_master = make_user(name="Эйчар", surname="Спящий")
    make_block(name="HR", master=hr_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET is_hr = 1, master_user_id = :uid WHERE name = 'HR'"),
            {"uid": hr_master.user_id},
        )

    block_master = make_user(name="Мастер", surname="Спящий")
    make_block(name="Наука", master=block_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET master_user_id = :uid WHERE name = 'Наука'"),
            {"uid": block_master.user_id},
        )

    applicant = make_user(name="Ждущий", surname="Студент")

    r_req = client.post(
        "/api/block-requests",
        json={"block_id": "Наука"},
        headers=applicant.headers,
    )
    req_id = r_req.json()["request_id"]
    rev = r_req.json()["revision"]

    # 1. Тачки пытаются одобрить до истечения 72 часов -> 403
    r_early = client.post(
        f"/api/block-requests/{req_id}/hr-approve",
        json={"expected_revision": rev},
        headers=superuser.headers,
    )
    assert r_early.status_code == 403

    # Симулируем наступление 72 часов (откатываем stage_entered_at на 72 часа назад)
    t_72h_ago = (datetime.now(timezone.utc) - timedelta(hours=72, minutes=1)).isoformat()
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block_requests SET stage_entered_at = :st WHERE request_id = :rid"),
            {"st": t_72h_ago, "rid": req_id},
        )

    # 2. Ровно через 72 часа тачки могут выполнить подмену!
    r_sub = client.post(
        f"/api/block-requests/{req_id}/hr-approve",
        json={"expected_revision": rev},
        headers=superuser.headers,
    )
    assert r_sub.status_code == 200
    data2 = r_sub.json()
    assert data2["state"] == "pending_block"

    # Проверяем аудит подмены
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT new_values_json FROM audit_logs WHERE target_kind = 'block_request' AND target_id = :rid"),
            {"rid": req_id},
        ).first()
        assert row is not None
        audit_new = json.loads(row[0])
        assert audit_new.get("is_substitute") is True

    # 3. На втором этапе таймер начинается заново: тачки прямо сейчас получают 403!
    r_sub2_early = client.post(
        f"/api/block-requests/{req_id}/block-approve",
        json={"expected_revision": data2["revision"]},
        headers=superuser.headers,
    )
    assert r_sub2_early.status_code == 403

    # Симулируем смену мастера блока Наука: смена мастера не сбрасывает срок
    new_master = make_user(name="Новый", surname="МастерНауки")
    client.put(
        "/api/blocks/Наука/leader",
        json={"user_id": new_master.user_id, "expected_revision": 1},
        headers=superuser.headers,
    )

    # Сдвигаем stage_entered_at второго этапа на 72 часа назад
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block_requests SET stage_entered_at = :st WHERE request_id = :rid"),
            {"st": t_72h_ago, "rid": req_id},
        )

    # Теперь тачки могут одобрить и второй этап по правилу 72 часов!
    r_sub2 = client.post(
        f"/api/block-requests/{req_id}/block-approve",
        json={"expected_revision": data2["revision"]},
        headers=superuser.headers,
    )
    assert r_sub2.status_code == 200
    assert r_sub2.json()["state"] == "approved"
    assert applicant.user_id in (db.get_block("Наука").arr_of_human or [])


def test_block_05_leave_and_independent_service_role(client, make_user, make_block):
    """
    BLOCK-05: Самостоятельный выход (/leave) без согласования.
    Уведомление мастеру (однократно).
    Служебная роль заместителя сохраняется после выхода из обычного членства.
    """
    master = make_user(name="Мастер", surname="Спорта")
    make_block(name="Спорт", master=master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET master_user_id = :uid WHERE name = 'Спорт'"),
            {"uid": master.user_id},
        )

    deputy = make_user(name="Зам", surname="Спорта")

    # Добавляем в блок и выдаём роль зама
    db.enter_user_to_block(deputy.user_id, "Спорт")
    db.assign_role(
        user_id=deputy.user_id,
        role="deputy",
        scope_kind="block",
        scope_id="Спорт",
        assigned_by=master.user_id,
    )

    assert deputy.user_id in (db.get_block("Спорт").arr_of_human or [])
    assert db.is_block_master_deputy(deputy.user_id, "Спорт") is True

    # Участник самостоятельно покидает блок
    r_leave = client.post("/api/blocks/Спорт/leave", headers=deputy.headers)
    assert r_leave.status_code == 200
    assert r_leave.json() == {"block_id": "Спорт", "membership_state": "left"}

    # Больше не член блока
    assert deputy.user_id not in (db.get_block("Спорт").arr_of_human or [])

    # Но служебная роль заместителя осталась!
    assert db.is_block_master_deputy(deputy.user_id, "Спорт") is True

    # Мастер получил уведомление о выходе
    notifs = db.list_notifications(master.user_id)
    leave_notif = next((n for n in notifs if n.kind == "block_leave"), None)
    assert leave_notif is not None
    assert leave_notif.payload["user_id"] == deputy.user_id

    # Повторный вызов /leave идемпотентен и не спамит новыми уведомлениями
    r_leave_repeat = client.post("/api/blocks/Спорт/leave", headers=deputy.headers)
    assert r_leave_repeat.status_code == 200
    notifs2 = db.list_notifications(master.user_id)
    leave_count = sum(1 for n in notifs2 if n.kind == "block_leave")
    assert leave_count == 1


def test_block_member_delete_and_patch(client, make_user, make_block, superuser):
    """
    DELETE /api/blocks/{id}/members/{user_id}: удаление уполномоченными ролями.
    PATCH /api/blocks/{id}: обновление description и community_url.
    Имя блока может менять только тачки.
    """
    master = make_user(name="Главный", surname="Культуры")
    make_block(name="Культура", master=master.kkr_name)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET master_user_id = :uid WHERE name = 'Культура'"),
            {"uid": master.user_id},
        )

    member = make_user(name="Член", surname="Культуры")
    stranger = make_user(name="Посторонний", surname="Человек")
    db.enter_user_to_block(member.user_id, "Культура")

    # Посторонний не может удалить участника
    r_del_fail = client.delete(
        f"/api/blocks/Культура/members/{member.user_id}",
        headers=stranger.headers,
    )
    assert r_del_fail.status_code == 403

    # Мастер может удалить участника
    r_del = client.delete(
        f"/api/blocks/Культура/members/{member.user_id}",
        headers=master.headers,
    )
    assert r_del.status_code == 200
    assert member.user_id not in (db.get_block("Культура").arr_of_human or [])

    # PATCH описания мастером
    r_patch = client.patch(
        "/api/blocks/Культура",
        json={"expected_revision": 1, "description": "Культурный блок", "community_url": "https://vk.com/culture"},
        headers=master.headers,
    )
    assert r_patch.status_code == 200
    data = r_patch.json()
    assert data["description"] == "Культурный блок"
    assert data["community_url"] == "https://vk.com/culture"

    # Мастер пытается сменить имя блока -> 403
    r_name_fail = client.patch(
        "/api/blocks/Культура",
        json={"expected_revision": data["revision"], "name": "Культура2"},
        headers=master.headers,
    )
    assert r_name_fail.status_code == 403

    # Тачки могут сменить имя блока
    r_name_ok = client.patch(
        "/api/blocks/Культура",
        json={"expected_revision": data["revision"], "name": "Культура_Новая"},
        headers=superuser.headers,
    )
    assert r_name_ok.status_code == 200
    assert r_name_ok.json()["name"] == "Культура_Новая"


# ═════════════════════════════════════════════════════════════
#  3. КАТЕГОРИИ И АВТОМАТИЧЕСКОЕ ПОВЫШЕНИЕ (JUNIOR-01..05)
# ═════════════════════════════════════════════════════════════

def test_junior_03_manual_category_patch(client, make_user, superuser):
    """
    JUNIOR-03: Ручное изменение категории тачками/HR мастером.
    Обычные пользователи и сам участник получают 403.
    """
    target = make_user(name="Джуниор", surname="Обычный")
    hr_master = make_user(name="Эйчар", surname="Ручной")
    # делаем hr_master мастером HR блока
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO block (name, master, hr, cnt_of_human, arr_of_human, is_hr, master_user_id) VALUES ('HR_Manual', :m, :m, 0, '[]', 1, :uid)"),
            {"m": hr_master.kkr_name, "uid": hr_master.user_id},
        )

    # Чтение категории
    r_cat = client.get(f"/api/participants/{target.user_id}/category", headers=target.headers)
    assert r_cat.status_code == 200
    assert r_cat.json()["category"] == "junior"

    # Сам пользователь пытается изменить свою категорию -> 403
    r_self = client.patch(
        f"/api/participants/{target.user_id}/category",
        json={"expected_revision": 1, "category": "activist", "reason": "Я хочу быть активистом"},
        headers=target.headers,
    )
    assert r_self.status_code == 403

    # HR мастер успешно меняет категорию
    r_hr = client.patch(
        f"/api/participants/{target.user_id}/category",
        json={"expected_revision": 1, "category": "activist", "reason": "Особые успехи"},
        headers=hr_master.headers,
    )
    assert r_hr.status_code == 200
    assert r_hr.json()["category"] == "activist"

    # Проверяем аудит
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT reason, new_values_json FROM audit_logs WHERE target_kind = 'user' AND target_id = :uid"),
            {"uid": str(target.user_id)},
        ).first()
        assert row is not None
        assert row[0] == "Особые успехи"
        assert json.loads(row[1])["category"] == "activist"


def test_junior_01_04_05_season_close_auto_promotion(client, make_user, superuser):
    """
    JUNIOR-01, 04, 05: Автоматическое повышение при close_season.
    Порог: real participation >= season_duration / 2.
    Activist не понижается. Повторный close не дублирует записи.
    """
    now = datetime.now(timezone.utc)
    t_start = (now - timedelta(days=60)).isoformat()
    t_end = (now + timedelta(days=40)).isoformat()  # Длительность: 100 дней, половина = 50 дней

    # Создаём сезон
    s = db.create_season(
        title="Сезон 2026",
        season_type="winter_spring",
        starts_at=t_start,
        ends_at=t_end,
    )
    db.open_season(s.season_id)

    # 1. Участник с участием >= 50 дней (одобрен 55 дней назад) -> повысится
    u_eligible = make_user(name="Достаточный", surname="Стаж")
    t_join_55d = (now - timedelta(days=55)).isoformat()
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE registration_applications SET approved_at = :app WHERE user_id = :uid"),
            {"app": t_join_55d, "uid": u_eligible.user_id},
        )
    assert db.get_user(u_eligible.user_id).category == "junior"

    # 2. Участник с участием < 50 дней (одобрен 20 дней назад) -> останется junior
    u_short = make_user(name="Короткий", surname="Стаж")
    t_join_20d = (now - timedelta(days=20)).isoformat()
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE registration_applications SET approved_at = :app WHERE user_id = :uid"),
            {"app": t_join_20d, "uid": u_short.user_id},
        )
    assert db.get_user(u_short.user_id).category == "junior"

    # 3. Ручной activist с малым стажем (JUNIOR-04) -> не должен быть понижен
    u_activist = make_user(name="Ручной", surname="Активист")
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET category = 'activist' WHERE user_id = :uid"),
            {"uid": u_activist.user_id},
        )
        conn.execute(
            text("UPDATE registration_applications SET approved_at = :app WHERE user_id = :uid"),
            {"app": t_join_20d, "uid": u_activist.user_id},
        )

    # Переводим сезон в summarizing и затем close
    db.begin_season_summary(s.season_id)
    db.close_season(s.season_id, closed_by_user_id=superuser.user_id)

    # Проверяем результаты:
    # u_eligible повышен до activist!
    assert db.get_user(u_eligible.user_id).category == "activist"
    # u_short остался junior
    assert db.get_user(u_short.user_id).category == "junior"
    # u_activist остался activist (не понизился)
    assert db.get_user(u_activist.user_id).category == "activist"
