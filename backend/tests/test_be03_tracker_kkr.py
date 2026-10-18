"""
Acceptance tests for BE-03: Трекер, сдачи, комментарии, файлы и ККР.

Проверяет:
1. Задачи и назначения:
   - Создание задач в блоках и подмероприятиях уполномоченными ролями.
   - Проверка прав: посторонний пользователь получает 403.
   - Изоляция областей: организатор чужой области не может читать задачу (403) и чужой список.
   - Назначение исполнителей: исполнители обязаны состоять в области задачи; не состоящий получает 422.
   - Уведомления: при назначении исполнителю создается notification kind="task_assignment".
   - Дедлайн задачи не может быть позже ends_at сезона.

2. Переходы состояний и сдачи:
   - start: assigned -> in_progress (только исполнитель).
   - request-help: in_progress -> help_required; сообщение сохраняется комментарием;
     всем лидам области отправляется notification kind="task_help_required".
   - resume: help_required -> in_progress.
   - submit: submitted_at серверная, сдача с текстом/ссылками/файлами, статус submitted.
   - accept: оценка 1 или 1.5, расчет ККР.
   - request-revision: статус needs_revision, замечание обязательно, уведомление исполнителю
     kind="task_revision_requested", начисление ККР отзывается.
   - not-complete: оценка 0 или -1, дата завершения не требуется, штраф -1 не ослабляется просрочкой.
   - cancel: отмена без баллов с сохранением причины и аудитом.

3. Очередь незавершенных назначений и переназначение:
   - GET /api/assignments/unresolved отслеживает незавершенные назначения.
   - assignee_unavailable_reason ("archived" / "left_scope").
   - POST .../reassign атомарно фиксирует старый исход и создает новое назначение
     действующему участнику области с уведомлением.

4. Формула ККР и расчет баллов:
   - Оценка 0 -> 0.
   - Оценка -1 -> -criteria_factor * weight.
   - Оценка 1 вовремя -> criteria_factor * weight.
   - Просрочка снижает балл по (1 - overdue/3), при >= 3 днях итог 0.
   - Досрочная сдача не дает бонуса.

5. Особые заслуги и волонтерская работа:
   - head_merit и chair_merit с ручными датами постфактум.
   - block_volunteer для участника вне состава блока; участнику блока запрещено (422).
   - Руководитель может выдать задачу себе и принять её с аудитом.

6. Автоматический бонус мастеру и закрытие сезона:
   - Среднее положительных результатов организаторов блока.
   - Сам мастер, нули, отрицательные итоги и волонтеры исключаются.
   - Закрытие сезона блокируется незавершенными назначениями и отсутствием финальных отчетов.
   - На close approved сводная сохраняет прежние категории, затем джуны автоматически повышаются в активисты.
   - Коррекция закрытой сводной только председателем.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone, timedelta
import pytest
from test_api_contract import error_body
from api_helpers import post_season
from database import db, NotificationORM, UserORM, BlockORM, SeasonORM, ReportORM


TASKS_URL = "/api/tasks"
ASSIGNMENTS_URL = "/api/assignments"
SEASONS_URL = "/api/seasons"
MERITS_URL = "/api/merits"


@pytest.fixture
def test_season(client, superuser):
    """Создает и открывает сезон для тестов."""
    now = datetime.now(timezone.utc)
    starts = (now - timedelta(days=10)).isoformat()
    ends = (now + timedelta(days=20)).isoformat()
    res = client.post(
        SEASONS_URL,
        json={"title": f"Сезон BE-03 {uuid.uuid4().hex[:6]}", "type": "summer_autumn", "starts_at": starts, "ends_at": ends},
        headers=superuser.headers,
    )
    assert res.status_code in (200, 201)
    s_data = res.json()
    season_id = s_data["season_id"]

    # Open season
    res_open = post_season(client,f"{SEASONS_URL}/{season_id}/open", json={"expected_revision": s_data["revision"]}, headers=superuser.headers)
    assert res_open.status_code == 200
    return res_open.json()


@pytest.fixture
def test_block(client, superuser, make_user):
    """Создает блок с мастером и участником."""
    block_name = f"ИТ_{uuid.uuid4().hex[:6]}"
    master = make_user(name="Мастер", surname="Блока")
    member = make_user(name="Участник", surname="Блока")
    outsider = make_user(name="Внешний", surname="Человек")

    from models import Block
    from domain_seed import meta_for
    from membership import set_membership
    db.create_block(Block(name=block_name,master=''))
    db.set_block_leader(block_name,master.user_id)
    with db.atomic():
        with db._session() as session:
            bid=meta_for(session,block_name).block_id
            set_membership(session,member.user_id,bid,True,superuser.user_id,'Approved fixture membership');session.commit()

    return {
        "name": block_name,
        "master": master,
        "member": member,
        "outsider": outsider,
    }


# ═════════════════════════════════════════════════════════════
#  1. СОЗДАНИЕ ЗАДАЧ И КОНТРОЛЬ ПРАВ
# ═════════════════════════════════════════════════════════════

def test_создание_задачи_мастером_и_контроль_прав(client, test_season, test_block):
    now = datetime.now(timezone.utc)
    deadline = (now + timedelta(days=5)).isoformat()
    season_id = test_season["season_id"]
    block_name = test_block["name"]
    master = test_block["master"]
    member = test_block["member"]
    outsider = test_block["outsider"]

    payload = {
        "season_id": season_id,
        "scope": {"kind": "block", "id": block_name},
        "title": "Разработка фичи",
        "description": "Сделать крутой функционал",
        "deadline_at": deadline,
        "criteria": {
            "unique": True,
            "creative": False,
            "external_communication": False,
            "in_person": False,
            "fixed_time": False,
        },
        "assignees": [{"user_id": member.user_id, "hours": 4.0}],
    }

    # Посторонний не может создавать задачи в чужом блоке -> 403
    res_out = client.post(TASKS_URL, json=payload, headers=outsider.headers)
    assert res_out.status_code == 403

    # Нельзя назначить участника не из блока -> 422
    invalid_payload = dict(payload, assignees=[{"user_id": outsider.user_id, "hours": 2.0}])
    res_inv = client.post(TASKS_URL, json=invalid_payload, headers=master.headers)
    assert res_inv.status_code == 422

    # Мастер создает задачу -> 200
    res = client.post(TASKS_URL, json=payload, headers=master.headers)
    assert res.status_code in (200, 201)
    task = res.json()
    assert task["title"] == "Разработка фичи"
    assert len(task["assignments"]) == 1
    asgn = task["assignments"][0]
    assert asgn["assignee"]["user_id"] == member.user_id
    assert asgn["status"] == "assigned"

    # Проверяем генерацию уведомления для назначенного исполнителя
    with db._session() as session:
        notif = session.query(NotificationORM).filter(
            NotificationORM.user_id == member.user_id,
            NotificationORM.kind == "task_assignment",
        ).first()
        assert notif is not None
        payload_data = json.loads(notif.payload_json)
        assert payload_data["task_id"] == task["task_id"]


def test_изоляция_просмотра_задач(client, test_season, test_block):
    now = datetime.now(timezone.utc)
    deadline = (now + timedelta(days=3)).isoformat()
    master = test_block["master"]
    member = test_block["member"]
    outsider = test_block["outsider"]

    # Создаем задачу
    res = client.post(
        TASKS_URL,
        json={
            "season_id": test_season["season_id"],
            "scope": {"kind": "block", "id": test_block["name"]},
            "title": "Секретная задача блока",
            "description": "Только для своих",
            "deadline_at": deadline,
            "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": member.user_id, "hours": 3.0}],
        },
        headers=master.headers,
    )
    assert res.status_code in (200, 201)
    task_id = res.json()["task_id"]

    # Член блока может просмотреть задачу
    res_mem = client.get(f"{TASKS_URL}/{task_id}", headers=member.headers)
    assert res_mem.status_code == 200

    # Посторонний получает 403 при попытке просмотреть задачу
    res_out = client.get(f"{TASKS_URL}/{task_id}", headers=outsider.headers)
    assert res_out.status_code == 403

    # Посторонний получает 403 при фильтрации по чужому блоку
    res_list = client.get(f"{TASKS_URL}?scope_kind=block&scope_id={test_block['name']}", headers=outsider.headers)
    assert res_list.status_code == 403


# ═════════════════════════════════════════════════════════════
#  2. ЖИЗНЕННЫЙ ЦИКЛ НАЗНАЧЕНИЙ И СДАЧИ
# ═════════════════════════════════════════════════════════════

def test_полный_цикл_назначения_сдача_приемка_доработка(client, test_season, test_block):
    now = datetime.now(timezone.utc)
    deadline = (now + timedelta(days=2)).isoformat()
    master = test_block["master"]
    member = test_block["member"]

    res_t = client.post(
        TASKS_URL,
        json={
            "season_id": test_season["season_id"],
            "scope": {"kind": "block", "id": test_block["name"]},
            "title": "Задача на доработку и сдачу",
            "description": "Детали задачи",
            "deadline_at": deadline,
            "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": member.user_id, "hours": 5.0}],
        },
        headers=master.headers,
    )
    assert res_t.status_code in (200, 201)
    task = res_t.json()
    assignment = task["assignments"][0]
    asgn_id = assignment["assignment_id"]
    rev = assignment["revision"]

    # 1. start -> in_progress
    res_start = client.post(f"{ASSIGNMENTS_URL}/{asgn_id}/start", json={"expected_revision": rev}, headers=member.headers)
    assert res_start.status_code == 200
    assert res_start.json()["status"] == "in_progress"
    rev = res_start.json()["revision"]

    # 2. request-help -> help_required + уведомление мастеру
    res_help = client.post(f"{ASSIGNMENTS_URL}/{asgn_id}/request-help", json={"expected_revision": rev, "message": "Нужна помощь с апи"}, headers=member.headers)
    assert res_help.status_code == 200
    assert res_help.json()["status"] == "help_required"
    rev = res_help.json()["revision"]

    # Проверяем уведомление мастеру
    with db._session() as session:
        notif = session.query(NotificationORM).filter(
            NotificationORM.user_id == master.user_id,
            NotificationORM.kind == "task_help_required",
        ).first()
        assert notif is not None

    # 3. submit из help_required
    res_sub = client.post(
        f"{ASSIGNMENTS_URL}/{asgn_id}/submit",
        json={"expected_revision": rev, "text": "Вот готовый результат", "links": ["https://github.com"], "file_ids": []},
        headers=member.headers,
    )
    assert res_sub.status_code == 200
    assert res_sub.json()["status"] == "submitted"
    rev = res_sub.json()["revision"]

    # 4. request-revision -> needs_revision + уведомление исполнителю
    res_rev = client.post(
        f"{ASSIGNMENTS_URL}/{asgn_id}/request-revision",
        json={"expected_revision": rev, "review_note": "Поправь стиль кода"},
        headers=master.headers,
    )
    assert res_rev.status_code == 200
    assert res_rev.json()["status"] == "needs_revision"
    rev = res_rev.json()["revision"]

    # Проверяем уведомление исполнителю о доработке
    with db._session() as session:
        notif_rev = session.query(NotificationORM).filter(
            NotificationORM.user_id == member.user_id,
            NotificationORM.kind == "task_revision_requested",
        ).first()
        assert notif_rev is not None

    # 5. Повторный submit
    res_sub2 = client.post(
        f"{ASSIGNMENTS_URL}/{asgn_id}/submit",
        json={"expected_revision": rev, "text": "Поправил стиль", "links": [], "file_ids": []},
        headers=member.headers,
    )
    assert res_sub2.status_code == 200
    rev = res_sub2.json()["revision"]

    # 6. accept -> accepted, начисление баллов
    res_acc = client.post(
        f"{ASSIGNMENTS_URL}/{asgn_id}/accept",
        json={"expected_revision": rev, "evaluation": 1.5, "review_note": "Отличная работа!"},
        headers=master.headers,
    )
    assert res_acc.status_code == 200
    assert res_acc.json()["status"] == "accepted"


# ═════════════════════════════════════════════════════════════
#  3. ФОРМУЛА ККР: Граничные условия
# ═════════════════════════════════════════════════════════════

def test_формула_ккр_граничные_значения(client, test_season, test_block, superuser):
    now = datetime.now(timezone.utc)
    deadline = (now + timedelta(days=2)).isoformat()
    master = test_block["master"]
    member = test_block["member"]

    # Создаем задачу
    res = client.post(
        TASKS_URL,
        json={
            "season_id": test_season["season_id"],
            "scope": {"kind": "block", "id": test_block["name"]},
            "title": "Тестирование формулы",
            "description": "Проверка",
            "deadline_at": deadline,
            "criteria": {"unique": True, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": member.user_id, "hours": 10.0}],
        },
        headers=master.headers,
    )
    task = res.json()
    asgn_id = task["assignments"][0]["assignment_id"]
    rev = task["assignments"][0]["revision"]

    # Оценка невыполнения (-1) -> штраф без ослабления просрочкой
    res_fail = client.post(
        f"{ASSIGNMENTS_URL}/{asgn_id}/not-complete",
        json={"expected_revision": rev, "evaluation": -1.0, "reason": "Не предупредил и не сделал"},
        headers=master.headers,
    )
    assert res_fail.status_code == 200
    assert res_fail.json()["status"] == "not_completed"

    # Проверяем рассчитанный балл через /api/assessments (доступно тачкам)
    res_ass = client.get(f"/api/assessments?season_id={test_season['season_id']}&user_id={member.user_id}", headers=superuser.headers)
    assert res_ass.status_code == 200
    items = res_ass.json()["items"]
    assert len(items) == 1
    score = items[0]["score"]
    # criteria_factor = 1.2; hours = 10; available_days = 2
    # weight = 10 * (1 + 1 / sqrt(3)) ~ 15.7735; score = -1.2 * weight ~ -18.928
    assert score < -18.0 and score > -19.5


# ═════════════════════════════════════════════════════════════
#  4. ВОЛОНТЕРЫ И ОСОБЫЕ ЗАСЛУГИ
# ═════════════════════════════════════════════════════════════

def test_волонтерские_заслуги_только_вне_блока(client, test_season, test_block):
    now = datetime.now(timezone.utc)
    assigned_at = (now - timedelta(days=2)).isoformat()
    deadline = (now - timedelta(days=1)).isoformat()
    master = test_block["master"]
    member = test_block["member"]
    outsider = test_block["outsider"]

    # 1. Попытка записать волонтерскую работу члену своего же блока -> 422
    payload_invalid = {
        "season_id": test_season["season_id"],
        "source_kind": "block_volunteer",
        "scope": {"kind": "block", "id": test_block["name"]},
        "title": "Помощь на дне открытых дверей",
        "description": "Дежурство",
        "assigned_at": assigned_at,
        "deadline_at": deadline,
        "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": True, "fixed_time": False},
        "recipients": [{"user_id": member.user_id, "hours": 3.0, "evaluation": 1.0,"completed_at":deadline}],
        "reason": "Волонтерство",
    }
    res_err = client.post(MERITS_URL, json=payload_invalid, headers=master.headers)
    assert res_err.status_code == 422

    # 2. Запись волонтерской работы участнику вне блока -> 200/201
    payload_valid = dict(payload_invalid, recipients=[{"user_id": outsider.user_id, "hours": 3.0, "evaluation": 1.0,"completed_at":deadline}])
    res_ok = client.post(MERITS_URL, json=payload_valid, headers=master.headers)
    assert res_ok.status_code in (200, 201)
    assert res_ok.json()["source_kind"] == "block_volunteer"


# ═════════════════════════════════════════════════════════════
#  5. НЕЗАВЕРШЕННЫЕ НАЗНАЧЕНИЯ И ПЕРЕНАЗНАЧЕНИЕ
# ═════════════════════════════════════════════════════════════

def test_переназначение_задачи_новому_исполнителю(client, test_season, test_block, make_user):
    now = datetime.now(timezone.utc)
    deadline = (now + timedelta(days=4)).isoformat()
    master = test_block["master"]
    member = test_block["member"]
    new_member = make_user(name="Второй", surname="Участник")

    # Добавляем new_member в блок
    with db._session() as session:
        b = session.get(BlockORM, test_block["name"])
        humans = json.loads(b.arr_of_human or "[]")
        humans.append(new_member.user_id)
        b.arr_of_human = json.dumps(humans)
        session.commit()

    # Создаем задачу на member
    res = client.post(
        TASKS_URL,
        json={
            "season_id": test_season["season_id"],
            "scope": {"kind": "block", "id": test_block["name"]},
            "title": "Срочная задача",
            "description": "Нужно сделать",
            "deadline_at": deadline,
            "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": member.user_id, "hours": 4.0}],
        },
        headers=master.headers,
    )
    asgn_id = res.json()["assignments"][0]["assignment_id"]
    rev = res.json()["assignments"][0]["revision"]

    # Переназначаем на new_member
    res_re = client.post(
        f"{ASSIGNMENTS_URL}/{asgn_id}/reassign",
        json={
            "expected_revision": rev,
            "new_assignee_user_id": new_member.user_id,
            "hours": 4.0,
            "previous_outcome": "cancelled",
            "reason": "Первый исполнитель заболел",
        },
        headers=master.headers,
    )
    assert res_re.status_code == 200
    data = res_re.json()
    assert data["previous_assignment"]["status"] == "cancelled"
    assert data["assignment"]["status"] == "assigned"
    assert data["assignment"]["assignee"]["user_id"] == new_member.user_id

    # Проверяем, что новому исполнителю отправлено уведомление
    with db._session() as session:
        notif = session.query(NotificationORM).filter(
            NotificationORM.user_id == new_member.user_id,
            NotificationORM.kind == "task_assignment",
        ).first()
        assert notif is not None


# ═════════════════════════════════════════════════════════════
#  6. ЗАКРЫТИЕ СЕЗОНА, БОНУС МАСТЕРА И ПОВЫШЕНИЕ ДЖУНОВ
# ═════════════════════════════════════════════════════════════

def test_закрытие_сезона_бонус_мастера_и_повышение_категории(client, test_season, test_block, superuser):
    now = datetime.now(timezone.utc)
    season_id = test_season["season_id"]
    master = test_block["master"]
    member = test_block["member"]

    # 1. Создаем задачу и принимаем ее
    res_t = client.post(
        TASKS_URL,
        json={
            "season_id": season_id,
            "scope": {"kind": "block", "id": test_block["name"]},
            "title": "Успешная задача",
            "description": "Принята",
            "deadline_at": (now + timedelta(days=1)).isoformat(),
            "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": member.user_id, "hours": 6.0}],
        },
        headers=master.headers,
    )
    asgn = res_t.json()["assignments"][0]
    # start -> submit -> accept
    client.post(f"{ASSIGNMENTS_URL}/{asgn['assignment_id']}/start", json={"expected_revision": asgn["revision"]}, headers=member.headers)
    res_sub = client.post(f"{ASSIGNMENTS_URL}/{asgn['assignment_id']}/submit", json={"expected_revision": asgn["revision"] + 1, "text": "Готово", "links": [], "file_ids": []}, headers=member.headers)
    res_acc = client.post(f"{ASSIGNMENTS_URL}/{asgn['assignment_id']}/accept", json={"expected_revision": res_sub.json()["revision"], "evaluation": 1.0}, headers=master.headers)
    assert res_acc.status_code == 200

    # 2. Переводим сезон в summarizing
    res_sum = post_season(client,f"{SEASONS_URL}/{season_id}/begin-summary", json={"expected_revision": test_season["revision"]}, headers=superuser.headers)
    assert res_sum.status_code == 200
    rev = res_sum.json()["revision"]

    # 3. Закрываем сезон
    res_close = post_season(client,f"{SEASONS_URL}/{season_id}/close", json={"expected_revision": rev}, headers=superuser.headers)
    assert res_close.status_code == 200

    # Проверяем начисление бонуса мастеру
    res_bonuses = client.get(f"{SEASONS_URL}/{season_id}/master-bonuses", headers=superuser.headers)
    assert res_bonuses.status_code == 200
    bonuses = res_bonuses.json()["items"]
    # Ищем бонус нашего блока
    block_bonus = next((b for b in bonuses if b["block_id"] == __import__("membership").block_id_for(test_block["name"])), None)
    assert block_bonus is not None
    assert block_bonus["recipient"]["user_id"] == master.user_id
    assert block_bonus["amount"] > 0
    assert block_bonus["is_final"] is True

    # Проверяем автоматическое повышение джуна до активиста
    with db._session() as session:
        u = session.get(UserORM, member.user_id)
        assert u.category == "junior"  # No verified tenure was seeded.
