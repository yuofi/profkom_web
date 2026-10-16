"""
Acceptance tests for BE-04: Отчёты, рабочая страница, календарь, уведомления.

Проверяет:
1. REPORT-01: Регулярный и финальный отчёты, черновики, публикация версий, соавторы.
2. REPORT-02 & REPORT-03: Матрица прав — главорг не правит чужой отчёт подмероприятия (только своя область);
   орг читает опубликованный отчёт своего подмероприятия, чужой отчёт закрыт (403).
3. REPORT-04: История отчётов (GET /report-history) — главорг видит главную и дочерние серии,
   ответственный видит только свою серию; черновики скрыты.
4. REPORT-05 & REPORT-06: Фиксация редакторов при close_season; прежние авторы/руководители правят старые отчёты,
   руководитель следующего года только читает; сохранение версий, защита от дублей.
5. MEETING-01 & CALENDAR-01: Созвоны и календарь — орг не видит главный созвон, видит свой;
   календарь объединяет дедлайны задач и разрешённые созвоны.
6. DASHBOARD: Агрегат рабочей страницы (GET /dashboard) — задачи, созвоны, блоки, мероприятия.
7. NOTIFY-01: Уведомления (GET /notifications, read, read-all), сокрытие объекта при утрате доступа.
8. SEASON-04: Блокировка закрытия сезона без опубликованного финального отчёта.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from database import db
from database import NotificationORM, TaskORM, AssignmentORM, BlockORM, SubeventORM, EventORM, ReportORM, ReportVersionORM, ReportEditorORM


SEASONS_URL = "/api/seasons"
EVENTS_URL = "/api/events"
REPORTS_URL = "/api/reports"
REPORT_HISTORY_URL = "/api/report-history"
DASHBOARD_URL = "/api/dashboard"
CALENDAR_URL = "/api/calendar"
NOTIFICATIONS_URL = "/api/notifications"
TASKS_URL = "/api/tasks"


@pytest.fixture
def test_season(client, superuser):
    """Создает и открывает тестовый сезон."""
    now = datetime.now(timezone.utc)
    starts = (now - timedelta(days=10)).isoformat()
    ends = (now + timedelta(days=30)).isoformat()
    res = client.post(
        SEASONS_URL,
        json={"title": f"Сезон BE-04 {uuid.uuid4().hex[:6]}", "type": "autumn", "starts_at": starts, "ends_at": ends},
        headers=superuser.headers,
    )
    assert res.status_code in (200, 201)
    s_data = res.json()
    season_id = s_data["season_id"]

    res_open = client.post(f"{SEASONS_URL}/{season_id}/open", json={"expected_revision": s_data["revision"]}, headers=superuser.headers)
    assert res_open.status_code == 200
    return res_open.json()


@pytest.fixture
def test_event_hierarchy(client, superuser, make_user, test_season):
    """
    Создает мероприятие с главоргом и подмероприятие с ответственным и обычным оргом.
    """
    season_id = test_season["season_id"]
    head_org = make_user(name="Главный", surname="Организатор")
    sub_lead = make_user(name="Ответственный", surname="Подмероприятия")
    sub_org = make_user(name="Рядовой", surname="Организатор")
    outsider = make_user(name="Посторонний", surname="Человек")

    # 1. Создаем главное мероприятие
    res_ev = client.post(
        EVENTS_URL,
        json={"season_id": season_id, "title": f"Фестиваль {uuid.uuid4().hex[:6]}", "description": "Описание"},
        headers=superuser.headers,
    )
    assert res_ev.status_code == 200
    ev = res_ev.json()
    event_id = ev["event_id"]
    event_series_id = ev["report_series_id"]

    # Назначаем главорга
    res_l = client.put(f"{EVENTS_URL}/{event_id}/leaders", json={"user_ids": [head_org.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert res_l.status_code == 200

    # 2. Создаем подмероприятие
    res_sub = client.post(
        f"{EVENTS_URL}/{event_id}/subevents",
        json={"title": "Квест", "description": "Квестовая часть"},
        headers=superuser.headers,
    )
    assert res_sub.status_code == 200
    sub = res_sub.json()
    subevent_id = sub["subevent_id"]
    subevent_series_id = sub["report_series_id"]

    # Назначаем ответственного и организатора
    res_sl = client.put(f"/api/subevents/{subevent_id}/leaders", json={"user_ids": [sub_lead.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert res_sl.status_code == 200
    res_so = client.put(f"/api/subevents/{subevent_id}/organizers", json={"user_ids": [sub_org.user_id], "expected_revision": res_sl.json()["revision"]}, headers=superuser.headers)
    assert res_so.status_code == 200

    return {
        "season_id": season_id,
        "event_id": event_id,
        "event_series_id": event_series_id,
        "subevent_id": subevent_id,
        "subevent_series_id": subevent_series_id,
        "head_org": head_org,
        "sub_lead": sub_lead,
        "sub_org": sub_org,
        "outsider": outsider,
    }


# ═════════════════════════════════════════════════════════════
#  1. REPORT-01: Регулярный и финальный отчёты, черновики, публикации
# ═════════════════════════════════════════════════════════════

def test_report_regular_and_final_draft_publish_and_versions(client, test_event_hierarchy):
    ev = test_event_hierarchy
    head_org = ev["head_org"]
    outsider = ev["outsider"]

    # 1. Главорг создает черновик регулярного отчета
    res_reg = client.post(
        REPORTS_URL,
        json={
            "owner_kind": "event",
            "owner_id": ev["event_id"],
            "kind": "regular",
            "title": "Промежуточный отчет 1",
            "content": "Текст черновика",
            "file_ids": [],
        },
        headers=head_org.headers,
    )
    assert res_reg.status_code == 200
    reg = res_reg.json()
    assert reg["state"] == "draft"
    assert reg["title"] == "Промежуточный отчет 1"
    assert reg["draft_title"] == "Промежуточный отчет 1"
    assert "edit_report" in reg["capabilities"]
    reg_id = reg["report_id"]

    # Посторонний не видит черновик -> 403
    res_chk = client.get(f"{REPORTS_URL}/{reg_id}", headers=outsider.headers)
    assert res_chk.status_code == 403

    # 2. Главорг создает черновик финального отчета
    res_fin = client.post(
        REPORTS_URL,
        json={
            "owner_kind": "event",
            "owner_id": ev["event_id"],
            "kind": "final",
            "title": "Итоговый отчет мероприятия",
            "content": "Итоги",
            "file_ids": [],
        },
        headers=head_org.headers,
    )
    assert res_fin.status_code == 200
    fin_id = res_fin.json()["report_id"]

    # Попытка создать второй final отчет для того же экземпляра -> 409 Conflict
    res_fin2 = client.post(
        REPORTS_URL,
        json={
            "owner_kind": "event",
            "owner_id": ev["event_id"],
            "kind": "final",
            "title": "Второй финальный отчет",
            "content": "Дубликат",
            "file_ids": [],
        },
        headers=head_org.headers,
    )
    assert res_fin2.status_code == 409

    # 3. Главорг публикует регулярный отчет (POST /reports/{id}/publish)
    res_pub = client.post(
        f"{REPORTS_URL}/{reg_id}/publish",
        json={"expected_revision": reg["revision"]},
        headers=head_org.headers,
    )
    assert res_pub.status_code == 200
    pub_data = res_pub.json()
    assert pub_data["state"] == "published"
    assert pub_data["published_version"] == 1

    # Повторная публикация без правок идемпотентна (не создает версию 2)
    res_pub_repeat = client.post(
        f"{REPORTS_URL}/{reg_id}/publish",
        json={"expected_revision": pub_data["revision"]},
        headers=head_org.headers,
    )
    assert res_pub_repeat.status_code == 200
    assert res_pub_repeat.json()["published_version"] == 1

    # 4. Редактирование опубликованного отчета: создается черновик следующей версии
    res_patch = client.patch(
        f"{REPORTS_URL}/{reg_id}",
        json={"expected_revision": pub_data["revision"], "title": "Обновленное название (черновик)", "content": "Новый текст"},
        headers=head_org.headers,
    )
    assert res_patch.status_code == 200
    patched = res_patch.json()
    assert patched["state"] == "published"
    assert patched["title"] == "Промежуточный отчет 1"  # опубликованное название прежнее
    assert patched["draft_title"] == "Обновленное название (черновик)"  # в черновике новое

    # Публикация второй версии
    res_pub2 = client.post(
        f"{REPORTS_URL}/{reg_id}/publish",
        json={"expected_revision": patched["revision"]},
        headers=head_org.headers,
    )
    assert res_pub2.status_code == 200
    assert res_pub2.json()["published_version"] == 2
    assert res_pub2.json()["title"] == "Обновленное название (черновик)"

    # Проверяем список версий
    res_vers = client.get(f"{REPORTS_URL}/{reg_id}/versions", headers=head_org.headers)
    assert res_vers.status_code == 200
    vers = res_vers.json()
    assert len(vers) == 2
    assert vers[0]["version"] == 1
    assert vers[1]["version"] == 2


# ═════════════════════════════════════════════════════════════
#  2. REPORT-02 & REPORT-03: Матрица прав и изоляция отчетов
# ═════════════════════════════════════════════════════════════

def test_report_acl_subevent_and_isolation(client, test_event_hierarchy):
    ev = test_event_hierarchy
    head_org = ev["head_org"]
    sub_lead = ev["sub_lead"]
    sub_org = ev["sub_org"]
    outsider = ev["outsider"]

    # REPORT-02: Главорг не может писать отчет в подмероприятии (только ответственный/замы)
    res_forb = client.post(
        REPORTS_URL,
        json={
            "owner_kind": "subevent",
            "owner_id": ev["subevent_id"],
            "kind": "regular",
            "title": "Попытка главорга написать в подмероприятие",
            "content": "Текст",
            "file_ids": [],
        },
        headers=head_org.headers,
    )
    assert res_forb.status_code == 403

    # Ответственный подмероприятия создает отчет подмероприятия -> 200
    res_sub_rep = client.post(
        REPORTS_URL,
        json={
            "owner_kind": "subevent",
            "owner_id": ev["subevent_id"],
            "kind": "regular",
            "title": "Отчет по квесту",
            "content": "Квест прошел отлично",
            "file_ids": [],
        },
        headers=sub_lead.headers,
    )
    assert res_sub_rep.status_code == 200
    sub_rep_id = res_sub_rep.json()["report_id"]

    # Публикуем отчет подмероприятия
    client.post(f"{REPORTS_URL}/{sub_rep_id}/publish", json={"expected_revision": 1}, headers=sub_lead.headers)

    # REPORT-03: Орг подмероприятия читает опубликованный отчет своего подмероприятия -> 200
    res_rd = client.get(f"{REPORTS_URL}/{sub_rep_id}", headers=sub_org.headers)
    assert res_rd.status_code == 200
    assert res_rd.json()["title"] == "Отчет по квесту"
    # Обычный читатель не видит прав на редактирование
    assert "edit_report" not in res_rd.json()["capabilities"]

    # Посторонний получает 403
    res_out = client.get(f"{REPORTS_URL}/{sub_rep_id}", headers=outsider.headers)
    assert res_out.status_code == 403


# ═════════════════════════════════════════════════════════════
#  3. REPORT-04: История отчётов (GET /report-history)
# ═════════════════════════════════════════════════════════════

def test_report_history_and_series(client, test_event_hierarchy, superuser):
    ev = test_event_hierarchy
    head_org = ev["head_org"]
    sub_lead = ev["sub_lead"]
    outsider = ev["outsider"]

    # Создаем и публикуем отчет главного мероприятия
    r_ev = client.post(
        REPORTS_URL,
        json={"owner_kind": "event", "owner_id": ev["event_id"], "kind": "regular", "title": "Главный фестиваль", "content": "Текст", "file_ids": []},
        headers=head_org.headers,
    )
    client.post(f"{REPORTS_URL}/{r_ev.json()['report_id']}/publish", json={"expected_revision": 1}, headers=head_org.headers)

    # Создаем и публикуем отчет подмероприятия
    r_sub = client.post(
        REPORTS_URL,
        json={"owner_kind": "subevent", "owner_id": ev["subevent_id"], "kind": "regular", "title": "Подмероприятие Квест", "content": "Текст", "file_ids": []},
        headers=sub_lead.headers,
    )
    client.post(f"{REPORTS_URL}/{r_sub.json()['report_id']}/publish", json={"expected_revision": 1}, headers=sub_lead.headers)

    # 1. Главорг читает историю главной серии -> видит главный отчет
    res_h1 = client.get(f"{REPORT_HISTORY_URL}?series_id={ev['event_series_id']}", headers=head_org.headers)
    assert res_h1.status_code == 200
    assert len(res_h1.json()) >= 1

    # 2. Главорг читает историю дочерней серии подмероприятия -> видит отчет подмероприятия
    res_h2 = client.get(f"{REPORT_HISTORY_URL}?series_id={ev['subevent_series_id']}", headers=head_org.headers)
    assert res_h2.status_code == 200
    assert len(res_h2.json()) >= 1

    # 3. Ответственный подмероприятия видит только свою серию
    res_h3 = client.get(f"{REPORT_HISTORY_URL}?series_id={ev['subevent_series_id']}", headers=sub_lead.headers)
    assert res_h3.status_code == 200

    # 4. Посторонний получает 403 при попытке чтения чужой серии
    res_fail = client.get(f"{REPORT_HISTORY_URL}?series_id={ev['event_series_id']}", headers=outsider.headers)
    assert res_fail.status_code == 403


# ═════════════════════════════════════════════════════════════
#  4. REPORT-05 & REPORT-06: Сохранение редакторов после close_season
# ═════════════════════════════════════════════════════════════

def test_historical_editors_post_close_season(client, test_event_hierarchy, superuser, make_user):
    ev = test_event_hierarchy
    head_org = ev["head_org"]
    sub_lead = ev["sub_lead"]
    season_id = ev["season_id"]

    # 1. Создаем и публикуем финальные отчеты для всех (чтобы сезон мог закрыться)
    r_efin = client.post(
        REPORTS_URL,
        json={"owner_kind": "event", "owner_id": ev["event_id"], "kind": "final", "title": "Финал Event", "content": "Конец", "file_ids": []},
        headers=head_org.headers,
    )
    client.post(f"{REPORTS_URL}/{r_efin.json()['report_id']}/publish", json={"expected_revision": 1}, headers=head_org.headers)

    r_sfin = client.post(
        REPORTS_URL,
        json={"owner_kind": "subevent", "owner_id": ev["subevent_id"], "kind": "final", "title": "Финал Subevent", "content": "Конец", "file_ids": []},
        headers=sub_lead.headers,
    )
    client.post(f"{REPORTS_URL}/{r_sfin.json()['report_id']}/publish", json={"expected_revision": 1}, headers=sub_lead.headers)

    # Регулярный отчет главорга
    r_reg = client.post(
        REPORTS_URL,
        json={"owner_kind": "event", "owner_id": ev["event_id"], "kind": "regular", "title": "Исторический отчет", "content": "Исходный", "file_ids": []},
        headers=head_org.headers,
    )
    reg_id = r_reg.json()["report_id"]
    client.post(f"{REPORTS_URL}/{reg_id}/publish", json={"expected_revision": 1}, headers=head_org.headers)

    # 2. Переводим сезон в summarizing и закрываем его
    res_sum = client.post(f"{SEASONS_URL}/{season_id}/begin-summary", headers=superuser.headers)
    assert res_sum.status_code == 200

    res_close = client.post(f"{SEASONS_URL}/{season_id}/close", headers=superuser.headers)
    assert res_close.status_code == 200
    assert res_close.json()["season"]["state"] == "closed"

    # 3. REPORT-05: Прежний руководитель (сохраненный редактор) может править старый отчет закрытого сезона
    res_patch = client.patch(
        f"{REPORTS_URL}/{reg_id}",
        json={"expected_revision": 2, "title": "Исторический отчет (правка)", "content": "Исправленный текст"},
        headers=head_org.headers,
    )
    assert res_patch.status_code == 200

    # Прежний редактор публикует исправленную версию
    res_pub = client.post(f"{REPORTS_URL}/{reg_id}/publish", json={"expected_revision": 3}, headers=head_org.headers)
    assert res_pub.status_code == 200
    assert res_pub.json()["published_version"] == 2

    # Новый пользователь следующего года не может править старый отчет
    new_leader = make_user(name="Новый", surname="Лидер")
    res_patch_fail = client.patch(
        f"{REPORTS_URL}/{reg_id}",
        json={"expected_revision": 4, "title": "Попытка нового лидера"},
        headers=new_leader.headers,
    )
    assert res_patch_fail.status_code == 403


# ═════════════════════════════════════════════════════════════
#  5. MEETING-01 & CALENDAR-01: Созвоны и календарь
# ═════════════════════════════════════════════════════════════

def test_meeting_and_calendar_isolation(client, test_event_hierarchy, make_user):
    ev = test_event_hierarchy
    head_org = ev["head_org"]
    sub_lead = ev["sub_lead"]
    sub_org = ev["sub_org"]
    outsider = ev["outsider"]

    now = datetime.now(timezone.utc)
    meeting_time = (now + timedelta(days=2)).isoformat()
    task_deadline = (now + timedelta(days=3)).isoformat()

    # 1. Главорг назначает главный созвон мероприятия
    client.put(
        f"/api/events/{ev['event_id']}/meeting",
        json={"title": "Главный созвон мероприятия", "starts_at": meeting_time, "join_url": "https://meet.profkom/main"},
        headers=head_org.headers,
    )

    # 2. Ответственный назначает созвон подмероприятия
    client.put(
        f"/api/subevents/{ev['subevent_id']}/meeting",
        json={"title": "Созвон квеста", "starts_at": meeting_time, "join_url": "https://meet.profkom/sub"},
        headers=sub_lead.headers,
    )

    # MEETING-01:
    # Ответственный видит главный созвон -> 200
    res_m1 = client.get(f"/api/events/{ev['event_id']}/meeting", headers=sub_lead.headers)
    assert res_m1.status_code == 200

    # Рядовой орг подмероприятия НЕ видит главный созвон -> 403
    res_m_fail = client.get(f"/api/events/{ev['event_id']}/meeting", headers=sub_org.headers)
    assert res_m_fail.status_code == 403

    # Рядовой орг подмероприятия видит созвон своего подмероприятия -> 200
    res_m_sub = client.get(f"/api/subevents/{ev['subevent_id']}/meeting", headers=sub_org.headers)
    assert res_m_sub.status_code == 200

    # 3. Назначаем рядовому оргу задачу с дедлайном
    client.post(
        TASKS_URL,
        json={
            "season_id": ev["season_id"],
            "scope": {"kind": "subevent", "id": ev["subevent_id"]},
            "title": "Задача для календаря",
            "description": "Сделать",
            "deadline_at": task_deadline,
            "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": sub_org.user_id, "hours": 4.0}],
        },
        headers=sub_lead.headers,
    )

    # CALENDAR-01:
    # Рядовой орг запрашивает календарь: видит созвон квеста и свою задачу, но НЕ главный созвон
    res_cal = client.get(CALENDAR_URL, headers=sub_org.headers)
    assert res_cal.status_code == 200
    items = res_cal.json()
    titles = [it["title"] for it in items]
    assert "Созвон квеста" in titles
    assert "Задача для календаря" in titles
    assert "Главный созвон мероприятия" not in titles


# ═════════════════════════════════════════════════════════════
#  6. DASHBOARD & NOTIFICATIONS: Рабочий стол и уведомления
# ═════════════════════════════════════════════════════════════

def test_dashboard_and_notifications(client, test_event_hierarchy):
    ev = test_event_hierarchy
    sub_lead = ev["sub_lead"]
    sub_org = ev["sub_org"]
    outsider = ev["outsider"]

    # 1. Назначаем задачу оргу
    res_t = client.post(
        TASKS_URL,
        json={
            "season_id": ev["season_id"],
            "scope": {"kind": "subevent", "id": ev["subevent_id"]},
            "title": "Задача для дашборда",
            "description": "Срочно",
            "deadline_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            "criteria": {"unique": False, "creative": False, "external_communication": False, "in_person": False, "fixed_time": False},
            "assignees": [{"user_id": sub_org.user_id, "hours": 2.0}],
        },
        headers=sub_lead.headers,
    )
    assert res_t.status_code == 200

    # 2. Проверяем рабочий стол орга (GET /dashboard)
    res_dash = client.get(DASHBOARD_URL, headers=sub_org.headers)
    assert res_dash.status_code == 200
    dash = res_dash.json()
    assert len(dash["my_tasks"]) >= 1
    assert any(t["title"] == "Задача для дашборда" for t in dash["my_tasks"])
    assert any(e["subevent_id"] == ev["subevent_id"] for e in dash["my_events"])

    # 3. Проверяем уведомления орга (GET /notifications)
    res_notif = client.get(NOTIFICATIONS_URL, headers=sub_org.headers)
    assert res_notif.status_code == 200
    notifs = res_notif.json()
    assert len(notifs) >= 1
    target_notif = notifs[0]
    nid = target_notif["notification_id"]
    assert target_notif["is_read"] is False

    # Посторонний не может пометить чужое уведомление прочитанным -> 403
    res_fail = client.post(f"{NOTIFICATIONS_URL}/{nid}/read", headers=outsider.headers)
    assert res_fail.status_code == 403

    # Орг помечает уведомление прочитанным -> 200
    res_read = client.post(f"{NOTIFICATIONS_URL}/{nid}/read", headers=sub_org.headers)
    assert res_read.status_code == 200

    # Проверяем read-all
    res_read_all = client.post(f"{NOTIFICATIONS_URL}/read-all", headers=sub_org.headers)
    assert res_read_all.status_code == 200


# ═════════════════════════════════════════════════════════════
#  7. SEASON-04: Блокировка закрытия сезона без final отчёта
# ═════════════════════════════════════════════════════════════

def test_season_close_blocker_missing_final_report(client, superuser, test_event_hierarchy):
    ev = test_event_hierarchy
    head_org = ev["head_org"]
    sub_lead = ev["sub_lead"]
    season_id = ev["season_id"]

    # Переводим сезон в summarizing
    res_sum = client.post(f"{SEASONS_URL}/{season_id}/begin-summary", headers=superuser.headers)
    assert res_sum.status_code == 200

    # 1. Попытка закрыть сезон без финальных отчетов -> 409 SeasonNotReadyError
    res_fail = client.post(f"{SEASONS_URL}/{season_id}/close", headers=superuser.headers)
    assert res_fail.status_code == 409
    err = res_fail.json()
    assert err["detail"]["detail"] == "season_not_ready"
    assert any(b["kind"] == "missing_final_report" for b in err["detail"]["fields"]["blockers"])

    # 2. Создание только черновика финального отчета НЕ снимает блокер
    res_dfin = client.post(
        REPORTS_URL,
        json={"owner_kind": "event", "owner_id": ev["event_id"], "kind": "final", "title": "Черновик финала", "content": "Текст", "file_ids": []},
        headers=head_org.headers,
    )
    res_fail2 = client.post(f"{SEASONS_URL}/{season_id}/close", headers=superuser.headers)
    assert res_fail2.status_code == 409

    # 3. Публикуем финальный отчет мероприятия и подмероприятия
    client.post(f"{REPORTS_URL}/{res_dfin.json()['report_id']}/publish", json={"expected_revision": 1}, headers=head_org.headers)

    res_subfin = client.post(
        REPORTS_URL,
        json={"owner_kind": "subevent", "owner_id": ev["subevent_id"], "kind": "final", "title": "Финал подмероприятия", "content": "Текст", "file_ids": []},
        headers=sub_lead.headers,
    )
    client.post(f"{REPORTS_URL}/{res_subfin.json()['report_id']}/publish", json={"expected_revision": 1}, headers=sub_lead.headers)

    # 4. Теперь все финальные отчеты опубликованы -> сезон закрывается
    res_ok = client.post(f"{SEASONS_URL}/{season_id}/close", headers=superuser.headers)
    assert res_ok.status_code == 200
    assert res_ok.json()["season"]["state"] == "closed"
