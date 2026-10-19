"""
Acceptance test suite for BE-06: Материалы, контакты и архив.

Тестирует сценарии:
1. Материалы (Materials):
   - Разделение: общие материалы (только тачки), гайды блоков (мастер/замы/тачки).
   - Единая система черновиков и публикаций. Неопубликованный черновик изолирован от обычных читателей.
   - Назначенные редакторы (PUT /api/materials/{id}/editors): назначают только тачки,
     редактор может править и публиковать конкретный материал, не имея доступа к неназначенным.
   - Публикация фиксирует published_content, published_at, published_by; читатель видит только публикацию.
   - Версионирование (expected_revision) с защитой от конфликтов (409).
   - Удаление уполномоченными лицами.

2. Контакты и карточки бывших (Contacts & Alumni):
   - Текущие контакты пишет только владелец.
   - Карточки бывших (/api/contacts/archive): создание/редактирование/удаление только тачки/HR мастер.
   - Обычные участники получают 403 на запись.
   - Периоды участия (participation_periods), заметки (notes).
   - Поиск/фильтрация по подстроке ФИО, email, tg, vk.
   - Выгрузка почт активных участников (/api/contacts/emails) доступна всем одобренным,
     исключает заблокированных и архивированных.

3. Аватары и фото профиля (Avatars):
   - Стандартные аватары (GET /api/avatars): не менее 6 пресетов.
   - PUT /api/profile/me/avatar: выбор ровно одного из preset_id или file_id (422 при обоих/ни одном).
   - Проверка владения файлом (403 при чужом файле), проверка mime_type (422 если не image/*).

4. Архив аккаунтов (Accounts Archive & Restore):
   - Архивирование только председателем.
   - Архивирование действующего председателя -> 409 chair_transfer_required_before_archive.
   - Отзыв refresh-сессий, деактивация членств в блоках, снятие с поста мастера.
   - Восстановление аккаунта председателем; проверка конфликтов мастера блока (409 с перечнем).
   - Явное разрешение конфликта через master_conflicts: [{block_id, keep_user_id}].
   - Идемпотентная очистка аккаунтов старше 3 лет: обезличивание ПДн, сохранение ID, задач и баллов.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from database import db, engine, BlockMembershipORM, FileRecordORM
from sqlalchemy import text


# ═════════════════════════════════════════════════════════════
#  1. МАТЕРИАЛЫ: ЖИЗНЕННЫЙ ЦИКЛ, ЧЕРНОВИК И ПУБЛИКАЦИЯ
# ═════════════════════════════════════════════════════════════

def test_general_material_crud_and_draft_isolation(client, superuser, user):
    """
    Тачки создают общий материал. Черновик скрыт от обычного читателя до публикации.
    Публикация делает материал доступным читателю без отображения draft_content.
    """
    # 1. Обычный участник не может создать общий материал
    r_bad = client.post(
        "/api/materials",
        headers=user.headers,
        json={
            "kind": "general",
            "title": "Обучение",
            "content": {"format": "markdown", "body": "Черновик лекции"},
        },
    )
    assert r_bad.status_code == 403

    # 2. Председатель (тачки) создаёт материал
    r_create = client.post(
        "/api/materials",
        headers=superuser.headers,
        json={
            "kind": "general",
            "title": "Обучение профкома",
            "description": "Базовые правила",
            "content": {"format": "markdown", "body": "Черновик v1"},
        },
    )
    assert r_create.status_code == 201, r_create.text
    mat = r_create.json()
    mat_id = mat["material_id"]
    assert mat["title"] == "Обучение профкома"
    assert mat["revision"] == 1
    assert mat["draft_content"]["body"] == "Черновик v1"
    assert mat["published_content"] is None
    assert "publish_material" in mat["capabilities"]
    assert "manage_editors" in mat["capabilities"]

    # 3. Обычный читатель пытается открыть неопубликованный материал -> 404
    r_read_unpub = client.get(f"/api/materials/{mat_id}", headers=user.headers)
    assert r_read_unpub.status_code == 404

    # И в списке неопубликованный материал читателю не виден
    r_list_user = client.get("/api/materials", headers=user.headers)
    assert r_list_user.status_code == 200
    assert all(m["material_id"] != mat_id for m in r_list_user.json())

    # 4. Автор (тачки) видит материал в списке и детально с draft_content
    r_view_chair = client.get(f"/api/materials/{mat_id}", headers=superuser.headers)
    assert r_view_chair.status_code == 200
    assert r_view_chair.json()["draft_content"]["body"] == "Черновик v1"

    # 5. Патч черновика
    r_patch = client.patch(
        f"/api/materials/{mat_id}",
        headers=superuser.headers,
        json={
            "expected_revision": 1,
            "title": "Обучение профкома (обновлено)",
            "content": {"format": "markdown", "body": "Черновик v2"},
        },
    )
    assert r_patch.status_code == 200
    assert r_patch.json()["revision"] == 2
    assert r_patch.json()["title"] == "Обучение профкома (обновлено)"

    # Конфликт ревизий
    r_conf = client.patch(
        f"/api/materials/{mat_id}",
        headers=superuser.headers,
        json={
            "expected_revision": 1,
            "title": "Устаревшая правка",
        },
    )
    assert r_conf.status_code == 409

    # 6. Публикация материала
    r_pub = client.post(
        f"/api/materials/{mat_id}/publish",
        headers=superuser.headers,
        json={"expected_revision": 2},
    )
    assert r_pub.status_code == 200
    pub_data = r_pub.json()
    assert pub_data["revision"] == 3
    assert pub_data["published_content"]["body"] == "Черновик v2"
    assert pub_data["published_at"] is not None
    assert pub_data["published_by"]["user_id"] == superuser.user_id

    # 7. Теперь обычный читатель видит материал, но НЕ видит draft_content
    r_read_pub = client.get(f"/api/materials/{mat_id}", headers=user.headers)
    assert r_read_pub.status_code == 200
    reader_data = r_read_pub.json()
    assert reader_data["published_content"]["body"] == "Черновик v2"
    assert reader_data["draft_content"] is None
    assert reader_data["capabilities"] == []

    # 8. Удаление материала: читатель не может удалить (403), тачки удаляют (200)
    r_del_fail = client.delete(f"/api/materials/{mat_id}", headers=user.headers)
    assert r_del_fail.status_code == 403

    r_del_ok = client.delete(f"/api/materials/{mat_id}", headers=superuser.headers)
    assert r_del_ok.status_code == 200

    r_after_del = client.get(f"/api/materials/{mat_id}", headers=superuser.headers)
    assert r_after_del.status_code == 404


def test_block_guide_permissions(client, make_user, make_block):
    """
    Гайды блоков могут создавать мастер и зам этого блока, либо тачки.
    Мастер другого блока или рядовой участник получают 403.
    """
    master_a = make_user()
    deputy_a = make_user()
    master_b = make_user()
    member = make_user()

    # Создаём блоки
    block_a = make_block(name="Блок-А", master=master_a.kkr_name)
    block_b = make_block(name="Блок-Б", master=master_b.kkr_name)
    with engine.begin() as conn:
        conn.execute(text("UPDATE block SET master_user_id = :uid WHERE name = 'Блок-А'"), {"uid": master_a.user_id})
        conn.execute(text("UPDATE block SET master_user_id = :uid WHERE name = 'Блок-Б'"), {"uid": master_b.user_id})

    # Назначаем заместителя в Блок-А
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO role_assignments (role_assignment_id, user_id, scope_kind, scope_id, role, revision) "
                "VALUES ('ra-dep-a', :uid, 'block', 'Блок-А', 'deputy', 1)"
            ),
            {"uid": deputy_a.user_id},
        )

    # 1. Чужой мастер (Блок-Б) не может создать гайд для Блок-А
    r_b = client.post(
        "/api/materials",
        headers=master_b.headers,
        json={
            "kind": "guide",
            "owner_block_id": "Блок-А",
            "title": "Гайд от чужака",
            "content": {"format": "markdown", "body": "..."},
        },
    )
    assert r_b.status_code == 403

    # 2. Рядовой участник не может создать гайд для Блок-А
    r_mem = client.post(
        "/api/materials",
        headers=member.headers,
        json={
            "kind": "guide",
            "owner_block_id": "Блок-А",
            "title": "Гайд от участника",
            "content": {"format": "markdown", "body": "..."},
        },
    )
    assert r_mem.status_code == 403

    # 3. Заместитель Блок-А может создать гайд
    r_dep = client.post(
        "/api/materials",
        headers=deputy_a.headers,
        json={
            "kind": "guide",
            "owner_block_id": "Блок-А",
            "title": "Гайд от зама",
            "content": {"format": "markdown", "body": "Правила блока"},
        },
    )
    assert r_dep.status_code == 201
    mat_id = r_dep.json()["material_id"]

    # 4. Мастер Блок-А может редактировать и публиковать этот гайд
    r_edit = client.patch(
        f"/api/materials/{mat_id}",
        headers=master_a.headers,
        json={
            "expected_revision": 1,
            "title": "Гайд Блока-А (финал)",
        },
    )
    assert r_edit.status_code == 200

    r_pub = client.post(
        f"/api/materials/{mat_id}/publish",
        headers=master_a.headers,
        json={"expected_revision": 2},
    )
    assert r_pub.status_code == 200

    # Гайд блока не имеет manage_editors
    assert "manage_editors" not in r_pub.json()["capabilities"]


def test_appointed_material_editors(client, superuser, make_user):
    """
    Тачки могут назначать редакторов на отдельный материал.
    Назначенный редактор получает право редактировать и публиковать этот материал,
    но не другие материалы.
    """
    editor_user = make_user()
    other_editor = make_user()
    outsider = make_user()

    # 1. Тачки создают материал 1 и материал 2
    r_m1 = client.post(
        "/api/materials",
        headers=superuser.headers,
        json={
            "kind": "general",
            "title": "Материал №1",
            "content": {"format": "markdown", "body": "Текст 1"},
        },
    )
    m1_id = r_m1.json()["material_id"]

    r_m2 = client.post(
        "/api/materials",
        headers=superuser.headers,
        json={
            "kind": "general",
            "title": "Материал №2",
            "content": {"format": "markdown", "body": "Текст 2"},
        },
    )
    m2_id = r_m2.json()["material_id"]

    # 2. Не-тачки не могут назначать редакторов
    r_set_bad = client.put(
        f"/api/materials/{m1_id}/editors",
        headers=editor_user.headers,
        json={"expected_revision": 1, "editor_user_ids": [editor_user.user_id]},
    )
    assert r_set_bad.status_code == 403

    # 3. Тачки назначают editor_user и other_editor на материал №1
    r_set_ok = client.put(
        f"/api/materials/{m1_id}/editors",
        headers=superuser.headers,
        json={"expected_revision": 1, "editor_user_ids": [editor_user.user_id, other_editor.user_id]},
    )
    assert r_set_ok.status_code == 200
    res_data = r_set_ok.json()
    assert set(res_data["editor_user_ids"]) == {editor_user.user_id, other_editor.user_id}
    assert res_data["revision"] == 2

    # 4. Назначенный редактор видит черновик и capabilities у материала №1
    r_get_m1 = client.get(f"/api/materials/{m1_id}", headers=editor_user.headers)
    assert r_get_m1.status_code == 200
    m1_data = r_get_m1.json()
    assert m1_data["draft_content"]["body"] == "Текст 1"
    assert "edit_material" in m1_data["capabilities"]
    assert "publish_material" in m1_data["capabilities"]

    # Но на материале №2 назначенный редактор не имеет прав
    r_get_m2 = client.get(f"/api/materials/{m2_id}", headers=editor_user.headers)
    assert r_get_m2.status_code == 404  # Не опубликован -> 404

    # 5. Назначенный редактор правит черновик материала №1
    r_patch_m1 = client.patch(
        f"/api/materials/{m1_id}",
        headers=editor_user.headers,
        json={
            "expected_revision": 2,
            "content": {"format": "markdown", "body": "Текст 1 отредактирован"},
        },
    )
    assert r_patch_m1.status_code == 200
    assert r_patch_m1.json()["revision"] == 3

    # 6. Второй назначенный редактор публикует материал №1
    r_pub_m1 = client.post(
        f"/api/materials/{m1_id}/publish",
        headers=other_editor.headers,
        json={"expected_revision": 3},
    )
    assert r_pub_m1.status_code == 200
    assert r_pub_m1.json()["published_content"]["body"] == "Текст 1 отредактирован"

    # 7. Посторонний не может править материал №1
    r_outsider_patch = client.patch(
        f"/api/materials/{m1_id}",
        headers=outsider.headers,
        json={
            "expected_revision": 4,
            "title": "Хак",
        },
    )
    assert r_outsider_patch.status_code == 403


# ═════════════════════════════════════════════════════════════
#  2. КОНТАКТЫ И КАРТОЧКИ БЫВШИХ
# ═════════════════════════════════════════════════════════════

def test_alumni_contacts_crud_and_search(client, superuser, user, make_user):
    """
    Карточки бывших (/api/contacts/archive):
    - Создание/редактирование/удаление только тачки или HR мастер.
    - Обычные пользователи получают 403 на запись.
    - Поиск по подстроке ФИО, email, tg, vk.
    """
    # Создаём HR мастера
    hr_master = make_user()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO block (name, master, hr, cnt_of_human, arr_of_human, is_hr, master_user_id) "
                "VALUES ('HR_Test', :m, :m, 0, '[]', 1, :uid)"
            ),
            {"m": hr_master.kkr_name, "uid": hr_master.user_id},
        )

    # 1. Обычный участник не может создать карточку бывшего
    r_user_create = client.post(
        "/api/contacts/archive",
        headers=user.headers,
        json={
            "surname": "Петров",
            "name": "Пётр",
            "email": "petrov@example.com",
        },
    )
    assert r_user_create.status_code == 403

    # 2. HR мастер создаёт карточку выпускника с периодами участия
    r_hr_create = client.post(
        "/api/contacts/archive",
        headers=hr_master.headers,
        json={
            "surname": "Иванов",
            "name": "Иван",
            "patronymic": "Иванович",
            "email": "ivanov@example.com",
            "tg": "@ivanov_alumni",
            "vk": "vk.com/ivanov",
            "phone": "+79991112233",
            "participation_periods": [
                {"from_year": 2018, "to_year": 2022},
                {"from_year": 2023, "to_year": 2024},
            ],
            "notes": "Экс-председатель комиссии",
        },
    )
    assert r_hr_create.status_code == 201, r_hr_create.text
    alumni_1 = r_hr_create.json()
    a1_id = alumni_1["alumni_id"]
    assert alumni_1["surname"] == "Иванов"
    assert len(alumni_1["participation_periods"]) == 2
    assert "edit_alumni" in alumni_1["capabilities"]

    # 3. Тачки создают вторую карточку
    r_chair_create = client.post(
        "/api/contacts/archive",
        headers=superuser.headers,
        json={
            "surname": "Сидорова",
            "name": "Анна",
            "email": "sidorova@alumni.org",
            "tg": "@anna_sid",
        },
    )
    assert r_chair_create.status_code == 201
    a2_id = r_chair_create.json()["alumni_id"]

    # 4. Одобренный активный участник может просматривать архив выпускников
    r_list = client.get("/api/contacts/archive", headers=user.headers)
    assert r_list.status_code == 200
    ids = [c["alumni_id"] for c in r_list.json()]
    assert a1_id in ids
    assert a2_id in ids
    # У обычного участника capabilities пустые
    item_user_view = next(c for c in r_list.json() if c["alumni_id"] == a1_id)
    assert item_user_view["capabilities"] == []

    # 5. Поиск по подстроке:
    # Поиск по фамилии
    r_search_name = client.get("/api/contacts/archive?query=Иван", headers=user.headers)
    assert r_search_name.status_code == 200
    results = r_search_name.json()
    assert len(results) == 1
    assert results[0]["surname"] == "Иванов"

    # Поиск по Telegram
    r_search_tg = client.get("/api/contacts/archive?query=anna_sid", headers=user.headers)
    assert r_search_tg.status_code == 200
    results_tg = r_search_tg.json()
    assert len(results_tg) == 1
    assert results_tg[0]["surname"] == "Сидорова"

    # 6. Редактирование карточки HR мастером
    r_patch = client.patch(
        f"/api/contacts/archive/{a1_id}",
        headers=hr_master.headers,
        json={
            "expected_revision": 1,
            "notes": "Обновленная заметка",
        },
    )
    assert r_patch.status_code == 200
    assert r_patch.json()["revision"] == 2
    assert r_patch.json()["notes"] == "Обновленная заметка"

    # Конфликт ревизий
    r_conf = client.patch(
        f"/api/contacts/archive/{a1_id}",
        headers=hr_master.headers,
        json={"expected_revision": 1},
    )
    assert r_conf.status_code == 409

    # Обычный участник не может патчить
    r_user_patch = client.patch(
        f"/api/contacts/archive/{a1_id}",
        headers=user.headers,
        json={"expected_revision": 2, "name": "Хак"},
    )
    assert r_user_patch.status_code == 403

    # 7. Удаление карточки тачками
    r_del = client.delete(f"/api/contacts/archive/{a2_id}", headers=superuser.headers)
    assert r_del.status_code == 200

    r_list_after = client.get("/api/contacts/archive", headers=user.headers)
    assert all(c["alumni_id"] != a2_id for c in r_list_after.json())


def test_active_emails_export(client, superuser, make_user):
    """
    Выгрузка списка почт (GET /api/contacts/emails) одобренных активных участников.
    Архивированные и забаненные пользователи не включаются.
    """
    u1 = make_user(email="active1@msu.ru")
    u2 = make_user(email="active2@msu.ru")
    banned = make_user(email="banned@msu.ru", banned=True)
    archived = make_user(email="archived@msu.ru")
    db.update_user(archived.user_id, account_state="archived")

    r = client.get("/api/contacts/emails", headers=u1.headers)
    assert r.status_code == 200
    emails = r.json()["emails"]
    assert "active1@msu.ru" in emails
    assert "active2@msu.ru" in emails
    assert "banned@msu.ru" not in emails
    assert "archived@msu.ru" not in emails


# ═════════════════════════════════════════════════════════════
#  3. АВАТАРЫ И ПРОФИЛЬ
# ═════════════════════════════════════════════════════════════

def test_avatar_presets_and_custom_file_avatar(client, user, make_user):
    """
    - GET /api/avatars возвращает минимум 6 стандартных пресетов.
    - PUT /api/profile/me/avatar принимает либо preset_id, либо file_id (ровно одно поле).
    - Чужой файл или файл не-изображение отклоняются с 403 / 422.
    """
    # 1. Получение пресетов
    r_presets = client.get("/api/avatars")
    assert r_presets.status_code == 200
    data = r_presets.json()
    items = data.get("items") or data.get("presets")
    assert len(items) >= 6
    preset_ids = [p["preset_id"] for p in items]
    assert "preset_classic" in preset_ids
    assert "preset_cat" in preset_ids

    # 2. Выбор стандартного пресета
    r_set_preset = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={"preset_id": "preset_cat"},
    )
    assert r_set_preset.status_code == 200
    updated_profile = r_set_preset.json()
    assert updated_profile["photo_url"] == "/static/avatars/preset_cat.png"

    # Проверяем в базе
    u_db = db.get_user(user.user_id)
    assert u_db.photo_url == "/static/avatars/preset_cat.png"

    # 3. Ошибки валидации: передали оба или ни одного
    r_both = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={"preset_id": "preset_cat", "file_id": "file-123"},
    )
    assert r_both.status_code == 422

    r_none = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={},
    )
    assert r_none.status_code == 422

    # Несуществующий пресет -> 404
    r_fake_preset = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={"preset_id": "preset_dragon_unknown"},
    )
    assert r_fake_preset.status_code == 404

    # 4. Установка собственного файла аватара
    other_user = make_user()
    now_iso = datetime.now(timezone.utc).isoformat()
    with engine.begin() as conn:
        # Файл, принадлежащий другому пользователю
        conn.execute(
            text(
                "INSERT INTO file_records (file_id, owner_kind, owner_id, purpose, name, mime_type, size_bytes, uploaded_by_user_id, state, created_at, expires_at) "
                "VALUES ('file-foreign', 'user', :other_id, 'avatar', 'avatar.png', 'image/png', 1024, :other_id, 'completed', :now, :now)"
            ),
            {"other_id": str(other_user.user_id), "now": now_iso},
        )
        # Файл пользователя, но не изображение (например PDF)
        conn.execute(
            text(
                "INSERT INTO file_records (file_id, owner_kind, owner_id, purpose, name, mime_type, size_bytes, uploaded_by_user_id, state, created_at, expires_at) "
                "VALUES ('file-doc', 'user', :uid, 'avatar', 'doc.pdf', 'application/pdf', 2048, :uid, 'completed', :now, :now)"
            ),
            {"uid": str(user.user_id), "now": now_iso},
        )
        # Валидный файл-изображение пользователя
        conn.execute(
            text(
                "INSERT INTO file_records (file_id, owner_kind, owner_id, purpose, name, mime_type, size_bytes, uploaded_by_user_id, state, created_at, expires_at) "
                "VALUES ('file-avatar-ok', 'user', :uid, 'avatar', 'my_pic.jpg', 'image/jpeg', 4096, :uid, 'completed', :now, :now)"
            ),
            {"uid": str(user.user_id), "now": now_iso},
        )

    # Чужой файл -> 403
    r_foreign = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={"file_id": "file-foreign"},
    )
    assert r_foreign.status_code == 403

    # Не изображение -> 422
    r_pdf = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={"file_id": "file-doc"},
    )
    assert r_pdf.status_code == 422

    # Валидный собственный файл -> 200
    r_ok = client.put(
        "/api/profile/me/avatar",
        headers=user.headers,
        json={"file_id": "file-avatar-ok"},
    )
    assert r_ok.status_code == 200
    assert r_ok.json()["photo_url"] == "/api/files/file-avatar-ok/download"


# ═════════════════════════════════════════════════════════════
#  4. АРХИВ АККАУНТОВ И ВОССТАНОВЛЕНИЕ
# ═════════════════════════════════════════════════════════════

def test_archive_account_chair_only_and_session_revocation(client, superuser, user, make_user, make_block):
    """
    - Только председатель может архивировать аккаунты.
    - Самоархивирование председателя запрещено (409 chair_transfer_required_before_archive).
    - При архивации отзываются все refresh-сессии пользователя и деактивируются членства в блоках.
    """
    target = make_user()
    block = make_block(name="ТестБлок", master=target.kkr_name)
    with engine.begin() as conn:
        conn.execute(text("UPDATE block SET master_user_id = :uid WHERE name = 'ТестБлок'"), {"uid": target.user_id})

    # Добавляем членство в блок
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO block_memberships (block_id, user_id, block_category, joined_at, is_active) "
                "VALUES ('ТестБлок', :uid, 'member', :now, 1)"
            ),
            {"uid": target.user_id, "now": datetime.now(timezone.utc).isoformat()},
        )

    # 1. Обычный пользователь не может архивировать аккаунт -> 403
    r_user_arch = client.post(
        f"/api/accounts/{target.user_id}/archive",
        headers=user.headers,
        json={"reason": "Попытка взлома"},
    )
    assert r_user_arch.status_code == 403

    # 2. Попытка председателя заархивировать самого себя -> 409
    r_self_arch = client.post(
        f"/api/accounts/{superuser.user_id}/archive",
        headers=superuser.headers,
        json={"reason": "Ухожу в отпуск"},
    )
    assert r_self_arch.status_code == 409
    assert "chair_transfer_required_before_archive" in r_self_arch.text

    # 3. Председатель успешно архивирует target
    r_arch = client.post(
        f"/api/accounts/{target.user_id}/archive",
        headers=superuser.headers,
        json={"reason": "Окончание учёбы"},
    )
    assert r_arch.status_code == 200, r_arch.text
    arch_data = r_arch.json()
    assert arch_data["account_state"] == "archived"
    assert arch_data["archive_reason"] == "Окончание учёбы"

    # Проверяем, что в базе account_state="archived"
    u_db = db.get_user(target.user_id)
    assert u_db.account_state == "archived"

    # Проверяем, что refresh-токены пользователя удалены
    with engine.begin() as conn:
        tokens_cnt = conn.execute(
            text("SELECT count(*) FROM refresh_tokens WHERE user_id = :uid"),
            {"uid": target.user_id},
        ).scalar()
        assert tokens_cnt == 0

        # Членство в блоке деактивировано
        mem_active = conn.execute(
            text("SELECT is_active FROM block_memberships WHERE user_id = :uid AND block_id = 'ТестБлок'"),
            {"uid": target.user_id},
        ).scalar()
        assert mem_active == 0

        # Мастер блока очищен
        b_master_uid = conn.execute(
            text("SELECT master_user_id FROM block WHERE name = 'ТестБлок'")
        ).scalar()
        assert b_master_uid is None

    # 4. Просмотр списка архива: обычный участник -> 403, председатель -> 200
    r_view_user = client.get("/api/accounts/archive", headers=user.headers)
    assert r_view_user.status_code == 403

    r_view_chair = client.get("/api/accounts/archive", headers=superuser.headers)
    assert r_view_chair.status_code == 200
    arch_items = r_view_chair.json()
    arch_target = next((a for a in arch_items if a["user_id"] == target.user_id), None)
    assert arch_target is not None
    assert arch_target["archive_reason"] == "Окончание учёбы"


def test_restore_account_master_conflict(client, superuser, make_user, make_block):
    """
    Восстановление аккаунта:
    - Если за время архивации в блоке появился новый мастер, при попытке восстановления
      возникает конфликт 409 с перечнем блоков.
    - Явная передача master_conflicts: [{block_id, keep_user_id}] разрешает конфликт.
    """
    old_master = make_user()
    new_master = make_user()
    block = make_block(name="КонфликтныйБлок", master=old_master.kkr_name)
    with engine.begin() as conn:
        conn.execute(text("UPDATE block SET master_user_id = :uid WHERE name = 'КонфликтныйБлок'"), {"uid": old_master.user_id})

    # Фиксируем роль мастера в role_assignments
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO role_assignments (role_assignment_id, user_id, scope_kind, scope_id, role, revision) "
                "VALUES ('ra-master-old', :uid, 'block', 'КонфликтныйБлок', 'master', 1)"
            ),
            {"uid": old_master.user_id},
        )

    # 1. Архивируем old_master
    client.post(
        f"/api/accounts/{old_master.user_id}/archive",
        headers=superuser.headers,
        json={"reason": "Архив для теста"},
    )

    # 2. Назначаем нового мастера в КонфликтныйБлок
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE block SET master = :m, master_user_id = :uid WHERE name = 'КонфликтныйБлок'"),
            {"m": new_master.kkr_name, "uid": new_master.user_id},
        )

    # 3. Пытаемся восстановить old_master без указания разрешения конфликта -> 409
    r_restore_conf = client.post(
        f"/api/accounts/{old_master.user_id}/restore",
        headers=superuser.headers,
        json={},
    )
    assert r_restore_conf.status_code == 409
    conf_detail = r_restore_conf.json()
    assert conf_detail["detail"]["detail"] == "master_conflict_unresolved"
    conflicts = conf_detail["detail"]["conflicts"]
    assert len(conflicts) == 1
    assert conflicts[0]["block_id"] == "КонфликтныйБлок"
    assert conflicts[0]["current_master_user_id"] == new_master.user_id

    # 4. Восстанавливаем с явным указанием: оставить new_master мастером блока
    r_restore_ok = client.post(
        f"/api/accounts/{old_master.user_id}/restore",
        headers=superuser.headers,
        json={
            "master_conflicts": [
                {"block_id": "КонфликтныйБлок", "keep_user_id": new_master.user_id}
            ]
        },
    )
    assert r_restore_ok.status_code == 200
    assert r_restore_ok.json()["user_id"] == old_master.user_id

    # Проверяем в базе: old_master активен, но мастером остался new_master
    u_db = db.get_user(old_master.user_id)
    assert u_db.account_state == "active"

    b_db = db.get_block("КонфликтныйБлок")
    assert b_db.master_user_id == new_master.user_id


def test_3_year_cleanup_archived_accounts(client, superuser, make_user):
    """
    Автоматическая идемпотентная очистка аккаунтов через 3 года (cleanup_archived_accounts):
    - Недавний архив (< 3 лет) НЕ очищается.
    - Старый архив (> 3 лет) обезличивается (surname -> Бывший, name -> Участник #id, контакты очищаются).
    - ID, баллы и история сохраняются.
    - Повторный запуск идемпотентен.
    """
    recent_user = make_user(name="Недавний", surname="Архивный", email="recent@test.msu.ru")
    old_user = make_user(name="Старый", surname="Архивный", email="old@test.msu.ru")

    # Архивируем обоих
    client.post(
        f"/api/accounts/{recent_user.user_id}/archive",
        headers=superuser.headers,
        json={"reason": "Недавний выпуск"},
    )
    client.post(
        f"/api/accounts/{old_user.user_id}/archive",
        headers=superuser.headers,
        json={"reason": "Старый выпуск"},
    )

    # В аудите смещаем дату архивации old_user на 4 года назад
    four_years_ago = (datetime.now(timezone.utc) - timedelta(days=4 * 365)).isoformat()
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE audit_logs SET created_at = :past "
                "WHERE target_kind = 'account' AND target_id = :uid"
            ),
            {"past": four_years_ago, "uid": str(old_user.user_id)},
        )

    # Запускаем очистку
    cleaned = db.cleanup_archived_accounts(retention_days=3 * 365)
    assert cleaned == 1

    # Проверяем recent_user: данные не тронуты
    c_recent = db.get_contact(recent_user.user_id)
    assert c_recent.surname == "Архивный"
    assert c_recent.name == "Недавний"
    assert c_recent.email == "recent@test.msu.ru"

    # Проверяем old_user: персональные данные обезличены
    c_old = db.get_contact(old_user.user_id)
    assert c_old.surname == "Бывший"
    assert f"#{old_user.user_id}" in c_old.name
    assert c_old.email == f"archived_{old_user.user_id}@profkom.archive"
    assert c_old.phone == ""

    # Повторный запуск идемпотентен: очищено 0 новых
    cleaned_again = db.cleanup_archived_accounts(retention_days=3 * 365)
    assert cleaned_again == 0
