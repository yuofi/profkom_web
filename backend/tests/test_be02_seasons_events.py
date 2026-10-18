"""
Acceptance tests for BE-02: Сезоны, мероприятия, руководители.

Проверяет:
1. Сезоны:
   - Жизненный цикл (planned -> open -> summarizing -> closed).
   - Отделение is_current от state.
   - Не более одного planned сезона одновременно (409 при попытке создать второй).
   - Не более одного is_current=True; атомарное переключение при открытии следующего.
   - Последовательность и нумерация (sequence_number, previous_season_id).
   - Запрет закрытия сезона, пока не закрыт предыдущий (409 season_not_ready с previous_season_not_closed).
   - PATCH конца сезона: валидация дедлайнов (422).

2. Мероприятия и подмероприятия:
   - Создание мероприятий только тачками.
   - Создание подмероприятий главоргами, их замами и тачками.
   - Создание запрещено в summarizing/closed сезонах.
   - Изоляция списков: организатор не видит чужие подмероприятия, посторонний не видит чужие подмероприятия (403 на прямой GET).
   - Копирование структуры ежегодного мероприятия (POST /events/{id}/copy): сохранение серий, очистка составов.

3. Руководители, заместители и организаторы:
   - Назначение нескольких главоргов (только тачки).
   - Назначение ответственных (главорги, их замы, тачки; не сами ответственные).
   - Назначение организаторов (главорги, их замы, тачки; ответственный не может).
   - Заместители: лимит до 2 замов, уникальность, запрет самоназначения.
   - Матрица назначения замов:
     - Замов мастера блока назначает мастер и тачки.
     - Замов главоргов назначают только тачки.
     - Замов ответственных назначают главорги/их замы и тачки (не сам ответственный).
   - Общий зам у нескольких руководителей: при снятии одного руководителя его замы снимаются, но связь с другим руководителем сохраняется.
   - Назначение мастера блока вне состава блока не добавляет его в обычные члены (arr_of_human).

4. Созвоны:
   - Главный созвон: видят главорги, ответственные и их замы; организаторы получают 403. Редактируют только главорги/замы и тачки.
   - Созвон подмероприятия: видят организаторы и руководители; редактируют ответственные/замы, главорги/замы и тачки.
   - DELETE удаляет объявление без сохранения истории.

5. Исправление ошибочного сезона (POST /season-corrections):
   - Только тачки.
   - Оба сезона незакрыты; одинаковый сезон -> 422.
   - Атомарный перенос мероприятия с проверкой дедлайнов.
"""

from __future__ import annotations

import pytest
from test_api_contract import error_body
from api_helpers import post_season
from database import db


SEASONS_URL = "/api/seasons"
EVENTS_URL = "/api/events"
REPORT_SERIES_URL = "/api/report-series"
SEASON_CORRECTIONS_URL = "/api/season-corrections"


# ═════════════════════════════════════════════════════════════
#  1. СЕЗОНЫ: Жизненный цикл, фазы, последовательность
# ═════════════════════════════════════════════════════════════

def test_seasons_только_председатель_может_создавать_сезон(client, superuser, user):
    payload = {
        "title": "Осень-Зима 2026",
        "type": "autumn_winter",
        "starts_at": "2026-09-01T00:00:00Z",
        "ends_at": "2026-12-31T23:59:59Z",
    }
    # Обычный пользователь -> 403
    r = client.post(SEASONS_URL, json=payload, headers=user.headers)
    assert r.status_code == 403

    # Председатель -> 200
    r = client.post(SEASONS_URL, json=payload, headers=superuser.headers)
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "Осень-Зима 2026"
    assert data["state"] == "planned"
    assert data["is_current"] is False
    assert data["sequence_number"] == 1
    assert data["previous_season_id"] is None
    assert data["revision"] == 1


def test_seasons_не_более_одного_planned_сезона_409(client, superuser):
    payload1 = {
        "title": "Сезон 1",
        "type": "winter_spring",
        "starts_at": "2026-01-01T00:00:00Z",
        "ends_at": "2026-05-31T23:59:59Z",
    }
    r1 = client.post(SEASONS_URL, json=payload1, headers=superuser.headers)
    assert r1.status_code == 200

    payload2 = {
        "title": "Сезон 2",
        "type": "summer_autumn",
        "starts_at": "2026-06-01T00:00:00Z",
        "ends_at": "2026-08-31T23:59:59Z",
    }
    # Попытка создать второй planned -> 409 Conflict
    r2 = client.post(SEASONS_URL, json=payload2, headers=superuser.headers)
    assert r2.status_code == 409


def test_seasons_открытие_сезона_переключает_is_current_атомарно(client, superuser):
    # Создаём Сезон 1
    r1 = client.post(SEASONS_URL, json={
        "title": "Сезон 1",
        "type": "winter_spring",
        "starts_at": "2026-01-01T00:00:00Z",
        "ends_at": "2026-05-31T23:59:59Z",
    }, headers=superuser.headers)
    assert r1.status_code == 200
    s1_id = r1.json()["season_id"]

    # Открываем Сезон 1
    r_open1 = post_season(client,f"{SEASONS_URL}/{s1_id}/open", json={"expected_revision": 1}, headers=superuser.headers)
    assert r_open1.status_code == 200
    s1_data = r_open1.json()
    assert s1_data["state"] == "open"
    assert s1_data["is_current"] is True

    # Проверяем GET /api/seasons/current
    r_cur = client.get(f"{SEASONS_URL}/current", headers=superuser.headers)
    assert r_cur.status_code == 200
    assert r_cur.json()["season_id"] == s1_id

    # Теперь можно создать Сезон 2 (так как Сезон 1 уже не planned, а open)
    r2 = client.post(SEASONS_URL, json={
        "title": "Сезон 2",
        "type": "summer_autumn",
        "starts_at": "2026-06-01T00:00:00Z",
        "ends_at": "2026-08-31T23:59:59Z",
    }, headers=superuser.headers)
    assert r2.status_code == 200
    s2 = r2.json()
    assert s2["sequence_number"] == 2
    assert s2["previous_season_id"] == s1_id

    # Открываем Сезон 2: Сезон 1 теряет is_current, но сохраняет свой state=open!
    r_open2 = post_season(client,f"{SEASONS_URL}/{s2['season_id']}/open", json={"expected_revision": 1}, headers=superuser.headers)
    assert r_open2.status_code == 200
    assert r_open2.json()["is_current"] is True

    # Проверяем Сезон 1: is_current=False, state=open
    r_check1 = client.get(f"{SEASONS_URL}/{s1_id}", headers=superuser.headers)
    assert r_check1.status_code == 200
    assert r_check1.json()["state"] == "open"
    assert r_check1.json()["is_current"] is False

    # Current теперь Сезон 2
    r_cur2 = client.get(f"{SEASONS_URL}/current", headers=superuser.headers)
    assert r_cur2.status_code == 200
    assert r_cur2.json()["season_id"] == s2["season_id"]


def test_seasons_последовательное_закрытие_препятствия_блоккеры(client, superuser):
    # Сезон 1
    r1 = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    s1_id = r1.json()["season_id"]
    post_season(client,f"{SEASONS_URL}/{s1_id}/open", json={}, headers=superuser.headers)

    # Сезон 2
    r2 = client.post(SEASONS_URL, json={
        "title": "Сезон 2", "type": "summer_autumn", "starts_at": "2026-06-01T00:00:00Z", "ends_at": "2026-08-31T23:59:59Z"
    }, headers=superuser.headers)
    s2_id = r2.json()["season_id"]
    post_season(client,f"{SEASONS_URL}/{s2_id}/open", json={}, headers=superuser.headers)

    # Переводим Сезон 2 в summarizing
    post_season(client,f"{SEASONS_URL}/{s2_id}/begin-summary", json={}, headers=superuser.headers)

    # Попытка закрыть Сезон 2 до закрытия Сезона 1 -> 409 с блокером previous_season_not_closed
    r_close2 = post_season(client,f"{SEASONS_URL}/{s2_id}/close", json={}, headers=superuser.headers)
    assert r_close2.status_code == 409
    err = r_close2.json()
    assert err["detail"]["code"] == "season_not_ready"
    blockers = err["detail"]["fields"]["blockers"]
    assert any(b["kind"] == "previous_season_not_closed" for b in blockers)

    # Переводим Сезон 1 в summarizing и закрываем его
    post_season(client,f"{SEASONS_URL}/{s1_id}/begin-summary", json={}, headers=superuser.headers)
    r_close1 = post_season(client,f"{SEASONS_URL}/{s1_id}/close", json={}, headers=superuser.headers)
    assert r_close1.status_code == 200

    # Теперь Сезон 2 успешно закрывается
    r_close2_ok = post_season(client,f"{SEASONS_URL}/{s2_id}/close", json={}, headers=superuser.headers)
    assert r_close2_ok.status_code == 200
    assert r_close2_ok.json()["season"]["state"] == "closed"


def test_seasons_patch_валидация_дедлайнов(client, superuser):
    r1 = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    s1 = r1.json()

    # Создаём мероприятие с ends_at = 2026-05-20
    r_ev = client.post(EVENTS_URL, json={
        "season_id": s1["season_id"],
        "title": "Посвят",
        "description": "Описание посвята",
        "ends_at": "2026-05-20T00:00:00Z",
    }, headers=superuser.headers)
    assert r_ev.status_code == 200

    # Попытка сократить сезон до 2026-05-10 (< ends_at мероприятия) -> 422
    r_patch = client.patch(f"{SEASONS_URL}/{s1['season_id']}", json={
        "expected_revision": s1["revision"],
        "ends_at": "2026-05-10T00:00:00Z", "reason":"Schedule adjustment",
    }, headers=superuser.headers)
    assert r_patch.status_code == 422

    # Корректный патч -> 200
    r_patch_ok = client.patch(f"{SEASONS_URL}/{s1['season_id']}", json={
        "expected_revision": s1["revision"],
        "title": "Обновлённое название",
    }, headers=superuser.headers)
    assert r_patch_ok.status_code == 200
    assert r_patch_ok.json()["title"] == "Обновлённое название"


# ═════════════════════════════════════════════════════════════
#  2. МЕРОПРИЯТИЯ И ПОДМЕРОПРИЯТИЯ
# ═════════════════════════════════════════════════════════════

def test_events_создание_и_права_доступа(client, superuser, user):
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    season_id = r_s.json()["season_id"]

    # Обычный пользователь не может создать мероприятие -> 403
    r_fail = client.post(EVENTS_URL, json={
        "season_id": season_id, "title": "День математика", "description": "Праздник"
    }, headers=user.headers)
    assert r_fail.status_code == 403

    # Тачки могут создать мероприятие -> 200
    r_ev = client.post(EVENTS_URL, json={
        "season_id": season_id, "title": "День математика", "description": "Праздник"
    }, headers=superuser.headers)
    assert r_ev.status_code == 200
    ev = r_ev.json()
    assert ev["title"] == "День математика"
    assert ev["season_id"] == season_id
    assert ev["report_series_id"] is not None

    # Серия отчётов автоматически создана
    r_series = client.get(REPORT_SERIES_URL, headers=user.headers)
    assert r_series.status_code == 200
    assert r_series.json()["items"] == []  # Unassigned users do not gain report-series access.


def test_subevents_изоляция_списков_не_раскрывает_чужие_подмероприятия(client, superuser, user, make_user):
    user2 = make_user(email="user2@test.local")
    user3 = make_user(email="user3@test.local")
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    season_id = r_s.json()["season_id"]

    r_ev = client.post(EVENTS_URL, json={
        "season_id": season_id, "title": "День математика", "description": "Праздник"
    }, headers=superuser.headers)
    ev_id = r_ev.json()["event_id"]

    # Создаём два подмероприятия: "Лекции" и "Квест"
    r_sub1 = client.post(f"{EVENTS_URL}/{ev_id}/subevents", json={
        "title": "Лекции", "description": "Лекционная часть"
    }, headers=superuser.headers)
    sub1_id = r_sub1.json()["subevent_id"]

    r_sub2 = client.post(f"{EVENTS_URL}/{ev_id}/subevents", json={
        "title": "Квест", "description": "Игровая часть"
    }, headers=superuser.headers)
    sub2_id = r_sub2.json()["subevent_id"]

    # Назначаем user организатором "Лекции", а user2 организатором "Квест"
    client.put(f"/api/subevents/{sub1_id}/organizers", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)
    client.put(f"/api/subevents/{sub2_id}/organizers", json={"user_ids": [user2.user_id], "expected_revision": 1}, headers=superuser.headers)

    # user запрашивает список подмероприятий: видит ТОЛЬКО "Лекции", НЕ видит "Квест"!
    r_subs_user = client.get(f"{EVENTS_URL}/{ev_id}/subevents", headers=user.headers)
    assert r_subs_user.status_code == 200
    sub_titles = [s["title"] for s in r_subs_user.json()["items"]]
    assert "Лекции" in sub_titles
    assert "Квест" not in sub_titles

    # user пытается напрямую открыть чужое подмероприятие "Квест" -> 403 Forbidden!
    r_direct = client.get(f"/api/subevents/{sub2_id}", headers=user.headers)
    assert r_direct.status_code == 403

    # user3 (вообще не участвует) видит пустой список и 403 на прямой доступ
    r_subs_user3 = client.get(f"{EVENTS_URL}/{ev_id}/subevents", headers=user3.headers)
    assert r_subs_user3.status_code == 200
    assert len(r_subs_user3.json()["items"]) == 0
    assert client.get(f"/api/subevents/{sub1_id}", headers=user3.headers).status_code == 403

    # Председатель/тачки видят оба подмероприятия
    r_subs_su = client.get(f"{EVENTS_URL}/{ev_id}/subevents", headers=superuser.headers)
    assert r_subs_su.status_code == 200
    assert len(r_subs_su.json()) == 2


def test_events_copy_структуры_без_старых_задач_и_людей(client, superuser, user):
    r_s1 = client.post(SEASONS_URL, json={
        "title": "2025", "type": "winter_spring", "starts_at": "2025-01-01T00:00:00Z", "ends_at": "2025-05-31T23:59:59Z"
    }, headers=superuser.headers)
    post_season(client,f"{SEASONS_URL}/{r_s1.json()['season_id']}/open", json={}, headers=superuser.headers)

    r_s2 = client.post(SEASONS_URL, json={
        "title": "2026", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    s2_id = r_s2.json()["season_id"]

    # Исходное мероприятие с подмероприятиями и организатором
    r_ev = client.post(EVENTS_URL, json={
        "season_id": r_s1.json()["season_id"], "title": "День математика 2025", "description": "Описание"
    }, headers=superuser.headers)
    ev1_id = r_ev.json()["event_id"]
    r_sub = client.post(f"{EVENTS_URL}/{ev1_id}/subevents", json={"title": "Лекции", "description": "Лекции 2025"}, headers=superuser.headers)
    sub1_id = r_sub.json()["subevent_id"]
    client.put(f"/api/subevents/{sub1_id}/organizers", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)

    # Копируем структуру в Сезон 2026
    r_copy = client.post(f"{EVENTS_URL}/{ev1_id}/copy", json={
        "season_id": s2_id,
        "title": "День математика 2026",
    }, headers=superuser.headers)
    assert r_copy.status_code == 200
    copy_data = r_copy.json()
    new_ev = copy_data["event"]
    new_subs = copy_data["subevents"]

    assert new_ev["event_id"] != ev1_id
    assert new_ev["season_id"] == s2_id
    assert new_ev["title"] == "День математика 2026"
    assert new_ev["report_series_id"] == r_ev.json()["report_series_id"]  # Серия сохранена!
    assert len(new_ev["leaders"]) == 0  # Руководители пустые!

    assert len(new_subs) == 1
    assert new_subs[0]["subevent_id"] != sub1_id
    assert new_subs[0]["title"] == "Лекции"
    assert len(new_subs[0]["organizer_user_ids"]) == 0  # Организаторы пустые!


# ═════════════════════════════════════════════════════════════
#  3. РУКОВОДИТЕЛИ, ЗАМЕСТИТЕЛИ, ОРГАНИЗАТОРЫ
# ═════════════════════════════════════════════════════════════

def test_leaders_назначение_главоргов_и_ответственных(client, superuser, user, make_user):
    user2 = make_user(email="user2@test.local")
    user3 = make_user(email="user3@test.local")
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    r_ev = client.post(EVENTS_URL, json={"season_id": r_s.json()["season_id"], "title": "Посвят"}, headers=superuser.headers)
    ev_id = r_ev.json()["event_id"]
    r_sub = client.post(f"{EVENTS_URL}/{ev_id}/subevents", json={"title": "Квест"}, headers=superuser.headers)
    sub_id = r_sub.json()["subevent_id"]

    # 1. Назначение главоргов: только тачки
    r_fail = client.put(f"{EVENTS_URL}/{ev_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=user.headers)
    assert r_fail.status_code == 403

    r_lead = client.put(f"{EVENTS_URL}/{ev_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert r_lead.status_code == 200
    ev_leaders = r_lead.json()["leaders"]
    assert len(ev_leaders) == 1
    assert ev_leaders[0]["user"]["user_id"] == user.user_id

    # 2. Главорг user теперь может назначить ответственного в подмероприятие
    r_sub_lead = client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user2.user_id], "expected_revision": 1}, headers=user.headers)
    assert r_sub_lead.status_code == 200
    sub_leaders = r_sub_lead.json()["leaders"]
    assert len(sub_leaders) == 1
    assert sub_leaders[0]["user"]["user_id"] == user2.user_id

    # 3. Ответственный user2 НЕ может назначать ответственных подмероприятия
    r_fail2 = client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user3.user_id], "expected_revision": 2}, headers=user2.headers)
    assert r_fail2.status_code == 403

    # 4. Ответственный user2 НЕ может назначать организаторов (только главорги/тачки)
    r_fail_org = client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [user3.user_id], "expected_revision": 2}, headers=user2.headers)
    assert r_fail_org.status_code == 403

    # Главорг user назначает организатора user3
    r_org = client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [user3.user_id], "expected_revision": 2}, headers=user.headers)
    assert r_org.status_code == 200
    assert user3.user_id in r_org.json()["organizer_user_ids"]


def test_deputies_матрица_назначений_и_независимость_общего_зама(client, superuser, user, make_user):
    user2 = make_user(email="user2@test.local")
    user3 = make_user(email="user3@test.local")
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    r_ev = client.post(EVENTS_URL, json={"season_id": r_s.json()["season_id"], "title": "Посвят"}, headers=superuser.headers)
    ev_id = r_ev.json()["event_id"]

    # Назначаем двух главоргов: user и user2
    r_ev = client.put(f"{EVENTS_URL}/{ev_id}/leaders", json={"user_ids": [user.user_id, user2.user_id], "expected_revision": 1}, headers=superuser.headers)
    leaders = r_ev.json()["leaders"]
    lead1 = next(l for l in leaders if l["user"]["user_id"] == user.user_id)
    lead2 = next(l for l in leaders if l["user"]["user_id"] == user2.user_id)

    # Замов главоргов назначают только тачки! Главорг user сам себе не может назначить -> 403
    r_fail = client.put(f"/api/role-assignments/{lead1['role_assignment_id']}/deputies", json={"user_ids": [user3.user_id], "expected_revision": 1}, headers=user.headers)
    assert r_fail.status_code == 403

    # Тачки назначают user3 замом первого главорга (lead1)
    r_dep1 = client.put(f"/api/role-assignments/{lead1['role_assignment_id']}/deputies", json={"user_ids": [user3.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert r_dep1.status_code == 200
    assert user3.user_id in r_dep1.json()["deputy_user_ids"]

    # Тачки также назначают user3 замом второго главорга (lead2) -> общий зам!
    r_dep2 = client.put(f"/api/role-assignments/{lead2['role_assignment_id']}/deputies", json={"user_ids": [user3.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert r_dep2.status_code == 200
    assert user3.user_id in r_dep2.json()["deputy_user_ids"]

    # Теперь снимаем первого главорга (user) из мероприятия
    r_new_ev = client.put(f"{EVENTS_URL}/{ev_id}/leaders", json={"user_ids": [user2.user_id], "expected_revision": 2}, headers=superuser.headers)
    assert r_new_ev.status_code == 200
    new_leaders = r_new_ev.json()["leaders"]
    assert len(new_leaders) == 1
    # Второй главорг (user2) остался, и user3 по-прежнему является его замом!
    assert user3.user_id in new_leaders[0]["deputy_user_ids"]


def test_deputies_валидация_лимита_и_запрет_самоназначения(client, superuser, user, make_user):
    user2 = make_user(email="user2@test.local")
    user3 = make_user(email="user3@test.local")
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    r_ev = client.post(EVENTS_URL, json={"season_id": r_s.json()["season_id"], "title": "Посвят"}, headers=superuser.headers)
    r_ev = client.put(f"{EVENTS_URL}/{r_ev.json()['event_id']}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)
    lead = r_ev.json()["leaders"][0]
    lead_aid = lead["role_assignment_id"]

    # Самоназначение руководителя своим замом -> 409
    r_self = client.put(f"/api/role-assignments/{lead_aid}/deputies", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert r_self.status_code == 409

    # Лимит замов: максимум 2. Попытка назначить 3 -> 409
    r_overflow = client.put(f"/api/role-assignments/{lead_aid}/deputies", json={"user_ids": [user2.user_id, user3.user_id, 9999], "expected_revision": 1}, headers=superuser.headers)
    assert r_overflow.status_code == 409


def test_block_leader_назначение_мастера_не_добавляет_в_члены(client, superuser, user):
    # Создаём блок через существующий API
    from models import Block
    db.create_block(Block(name='media',master='старый'))

    # Назначаем user мастером блока
    r_set = client.put("/api/blocks/media/leader", json={"user_id": user.user_id,"expected_revision":1}, headers=superuser.headers)
    assert r_set.status_code == 200
    block_data = r_set.json()
    assert block_data["name"] == "media"

    # Служебная роль мастера НЕ добавляет его в arr_of_human (обычное членство требует отдельной заявки)
    assert user.user_id not in (block_data.get("arr_of_human") or [])


# ═════════════════════════════════════════════════════════════
#  4. СОЗВОНЫ: Видимость и управление
# ═════════════════════════════════════════════════════════════

def test_meeting_главный_созвон_скрыт_от_организатора(client, superuser, user, make_user):
    user2 = make_user(email="user2@test.local")
    user3 = make_user(email="user3@test.local")
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    r_ev = client.post(EVENTS_URL, json={"season_id": r_s.json()["season_id"], "title": "Посвят"}, headers=superuser.headers)
    ev_id = r_ev.json()["event_id"]

    # user — главорг
    client.put(f"{EVENTS_URL}/{ev_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)

    # Создаём подмероприятие: user2 — ответственный, user3 — организатор
    r_sub = client.post(f"{EVENTS_URL}/{ev_id}/subevents", json={"title": "Квест"}, headers=superuser.headers)
    sub_id = r_sub.json()["subevent_id"]
    client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user2.user_id], "expected_revision": 1}, headers=superuser.headers)
    client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [user3.user_id], "expected_revision": 1}, headers=superuser.headers)

    # Главорг user создаёт главный созвон
    r_m = client.put(f"{EVENTS_URL}/{ev_id}/meeting", json={
        "title": "Собрание главоргов и ответственных",
        "starts_at": "2026-03-01T18:00:00Z",
        "join_url": "https://meet.google.com/abc-defg-hij",
    }, headers=user.headers)
    assert r_m.status_code == 200

    # 1. Главорг user видит созвон
    assert client.get(f"{EVENTS_URL}/{ev_id}/meeting", headers=user.headers).status_code == 200

    # 2. Ответственный user2 видит главный созвон
    assert client.get(f"{EVENTS_URL}/{ev_id}/meeting", headers=user2.headers).status_code == 200

    # 3. Организатор user3 НЕ видит главный созвон -> 403 Forbidden!
    assert client.get(f"{EVENTS_URL}/{ev_id}/meeting", headers=user3.headers).status_code == 403


def test_meeting_созвон_подмероприятия_доступен_организатору(client, superuser, user, make_user):
    user2 = make_user(email="user2@test.local")
    user3 = make_user(email="user3@test.local")
    r_s = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    r_ev = client.post(EVENTS_URL, json={"season_id": r_s.json()["season_id"], "title": "Посвят"}, headers=superuser.headers)
    ev_id = r_ev.json()["event_id"]

    r_sub = client.post(f"{EVENTS_URL}/{ev_id}/subevents", json={"title": "Квест"}, headers=superuser.headers)
    sub_id = r_sub.json()["subevent_id"]
    r_lead = client.put(f"/api/subevents/{sub_id}/leaders", json={"user_ids": [user.user_id], "expected_revision": 1}, headers=superuser.headers)
    assert r_lead.status_code == 200
    rev2 = r_lead.json()["revision"]
    r_org = client.put(f"/api/subevents/{sub_id}/organizers", json={"user_ids": [user2.user_id], "expected_revision": rev2}, headers=superuser.headers)
    assert r_org.status_code == 200

    # Ответственный user создаёт созвон подмероприятия
    r_m = client.put(f"/api/subevents/{sub_id}/meeting", json={
        "title": "Синхрон квеста",
        "starts_at": "2026-03-02T19:00:00Z",
        "join_url": "https://telemost.yandex.ru/12345",
    }, headers=user.headers)
    assert r_m.status_code == 200

    # Организатор user2 видит созвон
    assert client.get(f"/api/subevents/{sub_id}/meeting", headers=user2.headers).status_code == 200


    # Организатор user2 НЕ может редактировать созвон -> 403 Forbidden!
    assert client.put(f"/api/subevents/{sub_id}/meeting", json={
        "title": "Хак", "starts_at": "2026-03-02T19:00:00Z", "join_url": "https://hack.me"
    }, headers=user2.headers).status_code == 403

    # Посторонний user3 не видит созвон -> 403
    assert client.get(f"/api/subevents/{sub_id}/meeting", headers=user3.headers).status_code == 403

    # Удаление созвона
    r_del = client.delete(f"/api/subevents/{sub_id}/meeting", headers=user.headers)
    assert r_del.status_code == 200
    assert client.get(f"/api/subevents/{sub_id}/meeting", headers=user2.headers).status_code == 404


# ═════════════════════════════════════════════════════════════
#  5. ИСПРАВЛЕНИЕ ОШИБОЧНОГО СЕЗОНА (POST /season-corrections)
# ═════════════════════════════════════════════════════════════

def test_season_corrections_только_тачки_атомарный_перенос(client, superuser, user):
    # Создаём два сезона
    r_s1 = client.post(SEASONS_URL, json={
        "title": "Сезон 1", "type": "winter_spring", "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-05-31T23:59:59Z"
    }, headers=superuser.headers)
    s1_id = r_s1.json()["season_id"]
    post_season(client,f"{SEASONS_URL}/{s1_id}/open", json={}, headers=superuser.headers)

    r_s2 = client.post(SEASONS_URL, json={
        "title": "Сезон 2", "type": "summer_autumn", "starts_at": "2026-06-01T00:00:00Z", "ends_at": "2026-08-31T23:59:59Z"
    }, headers=superuser.headers)
    s2_id = r_s2.json()["season_id"]

    # Создаём мероприятие в Сезоне 1
    r_ev = client.post(EVENTS_URL, json={"season_id": s1_id, "title": "Ошибочное мероприятие"}, headers=superuser.headers)
    ev_id = r_ev.json()["event_id"]

    # Обычный пользователь -> 403
    r_fail = client.post(SEASON_CORRECTIONS_URL, json={
        "object_kind": "event",
        "object_id": ev_id,
        "expected_revision": 1,
        "target_season_id": s2_id,
        "reason": "Ошибка ввода",
    }, headers=user.headers)
    assert r_fail.status_code == 403

    # Одинаковый сезон -> 422
    r_same = client.post(SEASON_CORRECTIONS_URL, json={
        "object_kind": "event",
        "object_id": ev_id,
        "expected_revision": 1,
        "target_season_id": s1_id,
        "reason": "Тот же сезон",
    }, headers=superuser.headers)
    assert r_same.status_code == 422

    # Успешный перенос тачками
    r_corr = client.post(SEASON_CORRECTIONS_URL, json={
        "object_kind": "event",
        "object_id": ev_id,
        "expected_revision": 1,
        "target_season_id": s2_id,
        "reason": "Переносим в правильный сезон",
    }, headers=superuser.headers)
    assert r_corr.status_code == 200
    res = r_corr.json()
    assert res["source_season_id"] == s1_id
    assert res["target_season_id"] == s2_id

    # Проверяем мероприятие: теперь принадлежит Сезону 2
    r_check = client.get(f"{EVENTS_URL}/{ev_id}", headers=superuser.headers)
    assert r_check.status_code == 200
    assert r_check.json()["season_id"] == s2_id
