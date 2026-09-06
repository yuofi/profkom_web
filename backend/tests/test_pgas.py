"""
Тесты раздела «ПГАС» (main.py, секция PGAS).

Покрываются:
  * GET    /api/pgas             — таблица доступна любому авторизованному;
  * POST   /api/pgas             — создание записи (pgas_admin / суперюзер);
  * DELETE /api/pgas/{entry_id}  — удаление записи (pgas_admin / суперюзер);
  * флаг pgas_admin в MeOut — по нему фронт решает, показывать ли кнопки;
  * папка 'pgas' в POST /api/upload/presigned-url.

Каждый отказ проверяется по ТОЧНОМУ тексту detail, каждая запись — по состоянию базы.
"""
from __future__ import annotations

import pytest

from database import db

# ─────────────────────────────────────────────────────────────
#  Константы и утилиты
# ─────────────────────────────────────────────────────────────
PGAS_URL = "/api/pgas"
UPLOAD_URL = "/api/upload/presigned-url"
ME_URL = "/api/profile/me"

PGAS_ENTRY_FIELDS = {
    "entry_id",
    "title",
    "year",
    "file_url",
    "file_name",
    "file_type",
    "created_at",
    "uploaded_by",
}

#: отказ require_pgas_admin (auth.py)
DENIED = "PGAS admin rights required"
#: отказ валидации типа файла (main.py, PGAS_BAD_FILE)
BAD_FILE = "Only pdf, png and jpg files are allowed for PGAS"
#: отказ presigned-url для папки pgas
UPLOAD_DENIED = "Only PGAS admins and superusers can upload to 'pgas' folder"

S3_BASE = "https://global.s3.cloud.ru/test-bucket/pgas"


def payload(
    title: str = "Всероссийская олимпиада по математике",
    year: int = 2025,
    file_url: str = f"{S3_BASE}/file.pdf",
    file_name: str = "заявление.pdf",
    file_type: str = "application/pdf",
) -> dict:
    """Валидное тело PgasEntryIn — точка отсчёта для негативных кейсов."""
    return {
        "title": title,
        "year": year,
        "file_url": file_url,
        "file_name": file_name,
        "file_type": file_type,
    }


def assert_pgas_out_shape(body: dict) -> None:
    """Проверяет полную форму PgasEntryOut: состав полей и типы значений."""
    assert isinstance(body, dict), f"Ожидался объект PgasEntryOut, получено {type(body)}"
    assert set(body.keys()) == PGAS_ENTRY_FIELDS, (
        f"Состав полей PgasEntryOut изменился: лишние {set(body) - PGAS_ENTRY_FIELDS}, "
        f"отсутствуют {PGAS_ENTRY_FIELDS - set(body)}"
    )
    assert isinstance(body["entry_id"], int), "entry_id должен быть int"
    assert body["entry_id"] > 0, "entry_id должен быть положительным"
    assert isinstance(body["title"], str), "title (название мероприятия) должен быть str"
    assert isinstance(body["year"], int) and not isinstance(body["year"], bool), (
        "year (год) должен быть int"
    )
    assert isinstance(body["file_url"], str), "file_url должен быть str"
    assert isinstance(body["file_name"], str), "file_name должен быть str"
    assert isinstance(body["file_type"], str), "file_type должен быть str"
    assert isinstance(body["created_at"], str), "created_at должен быть str"
    assert body["uploaded_by"] is None or isinstance(body["uploaded_by"], int), (
        "uploaded_by должен быть int или null"
    )


def ids_of(response) -> list[int]:
    return [e["entry_id"] for e in response.json()]


@pytest.fixture
def make_entry(pgas_admin, client):
    """Создаёт запись ПГАС через HTTP от имени pgas_admin и возвращает тело ответа."""

    def _make(**kw) -> dict:
        r = client.post(PGAS_URL, json=payload(**kw), headers=pgas_admin.headers)
        assert r.status_code == 200, f"фикстура не смогла создать запись: {r.status_code} {r.text}"
        return r.json()

    return _make


# ─────────────────────────────────────────────────────────────
#  1. GET /api/pgas — чтение таблицы
# ─────────────────────────────────────────────────────────────
def test_обычный_пользователь_видит_таблицу(client, user, make_entry):
    """Просмотр таблицы — право любого авторизованного пользователя."""
    created = make_entry(title="Конференция «Наука и молодёжь»", year=2024)

    r = client.get(PGAS_URL, headers=user.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    body = r.json()
    assert isinstance(body, list), f"ответ должен быть списком, получено {type(body)}"
    assert len(body) == 1, f"ожидали ровно одну запись, получено {len(body)}"
    assert_pgas_out_shape(body[0])
    assert body[0]["entry_id"] == created["entry_id"], "должна вернуться созданная запись"
    assert body[0]["title"] == "Конференция «Наука и молодёжь»", (
        "название мероприятия должно прийти без изменений"
    )
    assert body[0]["year"] == 2024, "год должен прийти без изменений"


def test_пустая_таблица_отдаёт_пустой_список(client, user):
    r = client.get(PGAS_URL, headers=user.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert r.json() == [], f"на пустой базе ожидали [], получили {r.json()}"


def test_новые_записи_идут_первыми(client, user, make_entry):
    """Сортировка по entry_id desc: свежая загрузка должна быть сверху таблицы."""
    first = make_entry(title="Первое мероприятие", year=2023)
    second = make_entry(title="Второе мероприятие", year=2024)
    third = make_entry(title="Третье мероприятие", year=2025)

    r = client.get(PGAS_URL, headers=user.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert ids_of(r) == [third["entry_id"], second["entry_id"], first["entry_id"]], (
        f"ожидали порядок от новых к старым, получили {ids_of(r)}"
    )


@pytest.mark.parametrize(
    "role_fixture",
    ["user", "admin", "superuser", "pgas_admin"],
)
def test_таблица_доступна_всем_ролям(client, request, make_entry, role_fixture):
    """Ограничений по ролям на чтение нет — таблицу видят все, кто авторизован."""
    make_entry()
    actor = request.getfixturevalue(role_fixture)

    r = client.get(PGAS_URL, headers=actor.headers)

    assert r.status_code == 200, (
        f"роль {role_fixture} должна видеть таблицу, получили {r.status_code}: {r.text}"
    )
    assert len(r.json()) == 1, f"ожидали одну запись, получено {len(r.json())}"


def test_аноним_не_видит_таблицу(client, anon, make_entry):
    """GET /pgas закрыт обязательным get_current_user."""
    make_entry()

    r = client.get(PGAS_URL, headers=anon)

    assert r.status_code == 401, f"ожидали 401 для анонима, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not authenticated", f"неожиданный detail: {r.json()}"


def test_забаненный_не_видит_таблицу(client, banned_user, make_entry):
    """Бан бьёт раньше любых прав (auth.py, get_current_user)."""
    make_entry()

    r = client.get(PGAS_URL, headers=banned_user.headers)

    assert r.status_code == 403, f"ожидали 403 для забаненного, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "User is banned", f"неожиданный detail: {r.json()}"


# ─────────────────────────────────────────────────────────────
#  2. POST /api/pgas — права на создание
# ─────────────────────────────────────────────────────────────
def test_pgas_admin_создаёт_запись(client, pgas_admin):
    """Полная форма ответа + запись действительно легла в базу."""
    r = client.post(PGAS_URL, json=payload(), headers=pgas_admin.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    body = r.json()
    assert_pgas_out_shape(body)
    assert body["title"] == "Всероссийская олимпиада по математике", (
        "название мероприятия должно сохраниться как есть"
    )
    assert body["year"] == 2025, "год должен сохраниться как есть"
    assert body["file_url"] == f"{S3_BASE}/file.pdf", "ссылка на файл должна сохраниться как есть"
    assert body["file_name"] == "заявление.pdf", "имя файла должно сохраниться как есть"
    assert body["file_type"] == "application/pdf", "тип файла должен сохраниться как есть"
    assert body["uploaded_by"] == pgas_admin.user_id, "uploaded_by берётся из токена, а не из тела"

    stored = db.get_pgas_entry(body["entry_id"])
    assert stored is not None, "запись обязана появиться в базе"
    assert stored.title == "Всероссийская олимпиада по математике", (
        "в базе должно лежать переданное название мероприятия"
    )
    assert stored.year == 2025, "в базе должен лежать переданный год"
    assert stored.uploaded_by == pgas_admin.user_id, "в базе должен лежать автор загрузки"


def test_суперюзер_создаёт_запись(client, superuser):
    """super_user проходит require_pgas_admin без отдельного флага."""
    r = client.post(PGAS_URL, json=payload(), headers=superuser.headers)

    assert r.status_code == 200, f"суперюзеру должно быть разрешено, получили {r.status_code}: {r.text}"
    assert_pgas_out_shape(r.json())
    assert r.json()["uploaded_by"] == superuser.user_id, "uploaded_by должен указывать на суперюзера"


def test_created_at_заполняется_сервером(client, pgas_admin):
    """created_at ставит сервер: ISO-8601 UTC, а не то, что прислал клиент."""
    from datetime import datetime

    body = payload()
    body["created_at"] = "2000-01-01T00:00:00+00:00"

    r = client.post(PGAS_URL, json=body, headers=pgas_admin.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    created_at = r.json()["created_at"]
    assert created_at != "2000-01-01T00:00:00+00:00", (
        "created_at из тела запроса не должен приниматься — его ставит сервер"
    )
    parsed = datetime.fromisoformat(created_at)
    assert parsed.tzinfo is not None, f"created_at должен нести таймзону, получено {created_at!r}"
    assert parsed.utcoffset().total_seconds() == 0, (
        f"created_at должен быть в UTC, получено {created_at!r}"
    )


@pytest.mark.parametrize("role_fixture", ["user", "admin"])
def test_создание_запрещено_без_прав_пгас(client, request, role_fixture):
    """Ни обычный пользователь, ни admin прав на ПГАС не имеют."""
    actor = request.getfixturevalue(role_fixture)

    r = client.post(PGAS_URL, json=payload(), headers=actor.headers)

    assert r.status_code == 403, (
        f"роль {role_fixture} не должна создавать записи, получили {r.status_code}: {r.text}"
    )
    assert r.json()["detail"] == DENIED, f"неожиданный detail: {r.json()}"
    assert db.list_pgas_entries() == [], "при отказе запись в базе появляться не должна"


def test_мастер_блока_не_может_создавать_записи(client, make_master):
    """Права мастера блока распространяются на гайды, но не на ПГАС."""
    master, _ = make_master(block_name="Медиа")

    r = client.post(PGAS_URL, json=payload(), headers=master.headers)

    assert r.status_code == 403, f"ожидали 403 для мастера блока, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == DENIED, f"неожиданный detail: {r.json()}"


def test_аноним_не_может_создавать_записи(client, anon):
    r = client.post(PGAS_URL, json=payload(), headers=anon)

    assert r.status_code == 401, f"ожидали 401 для анонима, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not authenticated", f"неожиданный detail: {r.json()}"
    assert db.list_pgas_entries() == [], "при отказе запись в базе появляться не должна"


def test_забаненный_pgas_admin_не_может_создавать_записи(client, make_user):
    """Бан отрабатывает раньше проверки роли pgas_admin."""
    actor = make_user(pgas_admin=True, banned=True, name="Бан", surname="Пгасов")

    r = client.post(PGAS_URL, json=payload(), headers=actor.headers)

    assert r.status_code == 403, f"ожидали 403, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "User is banned", f"неожиданный detail: {r.json()}"


# ─────────────────────────────────────────────────────────────
#  3. POST /api/pgas — валидация тела
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "body, missing_field",
    [
        ({}, "title"),
        ({"year": 2025, "file_url": f"{S3_BASE}/f.pdf"}, "title"),
        ({"title": "Олимпиада", "file_url": f"{S3_BASE}/f.pdf"}, "year"),
        ({"title": "Олимпиада", "year": 2025}, "file_url"),
    ],
    ids=["пустое-тело", "нет-title", "нет-year", "нет-file_url"],
)
def test_отсутствие_обязательного_поля_даёт_422(client, pgas_admin, body, missing_field):
    r = client.post(PGAS_URL, json=body, headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422, получили {r.status_code}: {r.text}"
    fields = {err["loc"][-1] for err in r.json()["detail"]}
    assert missing_field in fields, f"в ошибке должно фигурировать поле {missing_field}: {r.json()}"
    assert db.list_pgas_entries() == [], "невалидный запрос не должен писать в базу"


@pytest.mark.parametrize(
    "field",
    ["title", "file_url"],
)
def test_пустая_строка_в_обязательном_поле_даёт_422(client, pgas_admin, field):
    """У title и file_url объявлен min_length=1 — пустая строка недопустима."""
    body = payload()
    body[field] = ""

    r = client.post(PGAS_URL, json=body, headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422 для пустого {field}, получили {r.status_code}: {r.text}"
    fields = {err["loc"][-1] for err in r.json()["detail"]}
    assert field in fields, f"в ошибке должно фигурировать поле {field}: {r.json()}"
    assert db.list_pgas_entries() == [], "невалидный запрос не должен писать в базу"


@pytest.mark.parametrize(
    "body",
    [
        {"title": None, "year": 2025, "file_url": f"{S3_BASE}/f.pdf"},
        {"title": "Олимпиада", "year": 2025, "file_url": None},
        {"title": 123, "year": 2025, "file_url": f"{S3_BASE}/f.pdf"},
        {"title": "Олимпиада", "year": 2025, "file_url": ["a"]},
        {"title": "Олимпиада", "year": None, "file_url": f"{S3_BASE}/f.pdf"},
    ],
    ids=[
        "title-null",
        "file_url-null",
        "title-int",
        "file_url-список",
        "year-null",
    ],
)
def test_неверный_тип_поля_даёт_422(client, pgas_admin, body):
    r = client.post(PGAS_URL, json=body, headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422 для {body}, получили {r.status_code}: {r.text}"
    assert db.list_pgas_entries() == [], "невалидный запрос не должен писать в базу"


@pytest.mark.parametrize(
    "year",
    ["две тысячи", ["2025"], {"год": 2025}, "20 25", ""],
    ids=["строка-не-число", "список", "объект", "строка-с-пробелом", "пустая-строка"],
)
def test_нечисловой_year_даёт_422(client, pgas_admin, year):
    """year объявлен как int — всё, что нельзя однозначно прочитать как число, отбивается."""
    r = client.post(PGAS_URL, json=payload(year=year), headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422 для year={year!r}, получили {r.status_code}: {r.text}"
    fields = {err["loc"][-1] for err in r.json()["detail"]}
    assert "year" in fields, f"в ошибке должно фигурировать поле year: {r.json()}"
    assert db.list_pgas_entries() == [], "невалидный запрос не должен писать в базу"


@pytest.mark.parametrize(
    "year",
    [1800, 1899, 2201, 2500, 0, -2025],
    ids=["1800", "1899-нижняя-граница-минус-1", "2201", "2500", "ноль", "отрицательный"],
)
def test_год_вне_диапазона_даёт_422(client, pgas_admin, year):
    """Для year объявлен диапазон Field(ge=1900, le=2200) — за его пределами 422."""
    r = client.post(PGAS_URL, json=payload(year=year), headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422 для year={year}, получили {r.status_code}: {r.text}"
    fields = {err["loc"][-1] for err in r.json()["detail"]}
    assert "year" in fields, f"в ошибке должно фигурировать поле year: {r.json()}"
    assert db.list_pgas_entries() == [], "невалидный запрос не должен писать в базу"


@pytest.mark.parametrize("year", [1900, 2200, 2025], ids=["нижняя-граница", "верхняя-граница", "обычный"])
def test_год_на_границах_диапазона_принимается(client, pgas_admin, year):
    """Границы 1900 и 2200 включительно — ge/le, а не gt/lt."""
    r = client.post(PGAS_URL, json=payload(year=year), headers=pgas_admin.headers)

    assert r.status_code == 200, f"год {year} должен приниматься, получили {r.status_code}: {r.text}"
    assert r.json()["year"] == year, f"год должен сохраниться как есть, получили {r.json()['year']}"


def test_числовая_строка_в_year_приводится_к_int(client, pgas_admin):
    """Зафиксированное поведение pydantic (нестрогий режим): "2025" читается как число 2025.

    Это не дефект: в ответе и в базе всё равно оказывается int, поэтому контракт не нарушается.
    """
    r = client.post(PGAS_URL, json=payload(year="2025"), headers=pgas_admin.headers)

    assert r.status_code == 200, (
        f"числовая строка должна приводиться к int, получили {r.status_code}: {r.text}"
    )
    body = r.json()
    assert body["year"] == 2025, f"ожидали число 2025, получили {body['year']!r}"
    assert isinstance(body["year"], int), f"year в ответе обязан быть int, получили {type(body['year'])}"
    assert db.get_pgas_entry(body["entry_id"]).year == 2025, "в базе тоже должно лежать число"


def test_дробный_year_даёт_422(client, pgas_admin):
    """2025.5 — не год: pydantic отбивает float с дробной частью."""
    r = client.post(PGAS_URL, json=payload(year=2025.5), headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422 для year=2025.5, получили {r.status_code}: {r.text}"
    assert db.list_pgas_entries() == [], "невалидный запрос не должен писать в базу"


def test_отказ_по_правам_приходит_раньше_валидации_тела(client, user):
    """Зависимость require_pgas_admin отрабатывает до разбора тела."""
    r = client.post(PGAS_URL, json={}, headers=user.headers)

    assert r.status_code == 403, (
        f"без прав ожидали 403, а не 422 по телу; получили {r.status_code}: {r.text}"
    )
    assert r.json()["detail"] == DENIED, f"неожиданный detail: {r.json()}"


@pytest.mark.parametrize(
    "file_url, file_type",
    [
        (f"{S3_BASE}/f.pdf", "application/pdf"),
        (f"{S3_BASE}/f.png", "image/png"),
        (f"{S3_BASE}/f.jpg", "image/jpeg"),
        (f"{S3_BASE}/f.jpg", "image/jpg"),
        (f"{S3_BASE}/f.jpeg", "image/jpeg"),
        (f"{S3_BASE}/f.PDF", "APPLICATION/PDF"),
        (f"{S3_BASE}/f.pdf", ""),
    ],
    ids=["pdf", "png", "jpg", "jpg-как-image/jpg", "jpeg", "верхний-регистр", "без-типа"],
)
def test_разрешённые_типы_файлов_принимаются(client, pgas_admin, file_url, file_type):
    r = client.post(
        PGAS_URL,
        json=payload(file_url=file_url, file_type=file_type),
        headers=pgas_admin.headers,
    )

    assert r.status_code == 200, (
        f"файл {file_url!r} / {file_type!r} должен приниматься, получили {r.status_code}: {r.text}"
    )
    assert_pgas_out_shape(r.json())


@pytest.mark.parametrize(
    "file_url, file_type",
    [
        (f"{S3_BASE}/f.exe", "application/x-msdownload"),
        (f"{S3_BASE}/f.html", "text/html"),
        (f"{S3_BASE}/f.svg", "image/svg+xml"),
        (f"{S3_BASE}/f.docx", "application/msword"),
        (f"{S3_BASE}/f.gif", "image/gif"),
        (f"{S3_BASE}/f.pdf", "text/html"),
        (f"{S3_BASE}/f.exe", ""),
        (f"{S3_BASE}/file-without-extension", "application/pdf"),
    ],
    ids=[
        "exe",
        "html",
        "svg",
        "docx",
        "gif",
        "тип-не-совпадает-с-расширением",
        "запрещённое-расширение-без-типа",
        "ссылка-без-расширения",
    ],
)
def test_запрещённый_тип_файла_даёт_400(client, pgas_admin, file_url, file_type):
    r = client.post(
        PGAS_URL,
        json=payload(file_url=file_url, file_type=file_type),
        headers=pgas_admin.headers,
    )

    assert r.status_code == 400, (
        f"файл {file_url!r} / {file_type!r} должен отбиваться, получили {r.status_code}: {r.text}"
    )
    assert r.json()["detail"] == BAD_FILE, f"неожиданный detail: {r.json()}"
    assert db.list_pgas_entries() == [], "отклонённый файл не должен попадать в таблицу"


def test_query_строка_в_ссылке_не_мешает_проверке_расширения(client, pgas_admin):
    """Presigned/публичная ссылка может нести query — расширение берётся до '?'."""
    r = client.post(
        PGAS_URL,
        json=payload(file_url=f"{S3_BASE}/f.pdf?X-Amz-Signature=abc"),
        headers=pgas_admin.headers,
    )

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert r.json()["file_url"] == f"{S3_BASE}/f.pdf?X-Amz-Signature=abc", (
        "ссылка должна сохраниться целиком, вместе с query"
    )


# ─────────────────────────────────────────────────────────────
#  4. DELETE /api/pgas/{entry_id}
# ─────────────────────────────────────────────────────────────
def test_pgas_admin_удаляет_запись(client, pgas_admin, make_entry):
    created = make_entry()

    r = client.delete(f"{PGAS_URL}/{created['entry_id']}", headers=pgas_admin.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert r.json() == {"status": "deleted"}, f"неожиданное тело ответа: {r.json()}"
    assert db.get_pgas_entry(created["entry_id"]) is None, "запись обязана исчезнуть из базы"


def test_суперюзер_удаляет_чужую_запись(client, superuser, make_entry):
    """Владение записью роли не играет: суперюзер удаляет что угодно."""
    created = make_entry()

    r = client.delete(f"{PGAS_URL}/{created['entry_id']}", headers=superuser.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert db.get_pgas_entry(created["entry_id"]) is None, "запись обязана исчезнуть из базы"


def test_удаление_не_трогает_соседние_записи(client, pgas_admin, make_entry):
    keep_first = make_entry(title="Останется первое мероприятие")
    victim = make_entry(title="Удаляемое мероприятие")
    keep_second = make_entry(title="Останется второе мероприятие")

    r = client.delete(f"{PGAS_URL}/{victim['entry_id']}", headers=pgas_admin.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    left = client.get(PGAS_URL, headers=pgas_admin.headers)
    assert ids_of(left) == [keep_second["entry_id"], keep_first["entry_id"]], (
        f"должны остаться ровно соседние записи, получили {ids_of(left)}"
    )


@pytest.mark.parametrize("role_fixture", ["user", "admin"])
def test_удаление_запрещено_без_прав_пгас(client, request, make_entry, role_fixture):
    created = make_entry()
    actor = request.getfixturevalue(role_fixture)

    r = client.delete(f"{PGAS_URL}/{created['entry_id']}", headers=actor.headers)

    assert r.status_code == 403, (
        f"роль {role_fixture} не должна удалять записи, получили {r.status_code}: {r.text}"
    )
    assert r.json()["detail"] == DENIED, f"неожиданный detail: {r.json()}"
    assert db.get_pgas_entry(created["entry_id"]) is not None, "запись обязана остаться в базе"


def test_аноним_не_может_удалять(client, anon, make_entry):
    created = make_entry()

    r = client.delete(f"{PGAS_URL}/{created['entry_id']}", headers=anon)

    assert r.status_code == 401, f"ожидали 401 для анонима, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not authenticated", f"неожиданный detail: {r.json()}"
    assert db.get_pgas_entry(created["entry_id"]) is not None, "запись обязана остаться в базе"


def test_удаление_несуществующей_записи_даёт_404(client, pgas_admin):
    r = client.delete(f"{PGAS_URL}/999999", headers=pgas_admin.headers)

    assert r.status_code == 404, f"ожидали 404, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "PGAS entry not found", f"неожиданный detail: {r.json()}"


def test_повторное_удаление_даёт_404(client, pgas_admin, make_entry):
    """Операция не идемпотентна по коду ответа: второй раз запись уже не найдена."""
    created = make_entry()

    first = client.delete(f"{PGAS_URL}/{created['entry_id']}", headers=pgas_admin.headers)
    second = client.delete(f"{PGAS_URL}/{created['entry_id']}", headers=pgas_admin.headers)

    assert first.status_code == 200, f"первое удаление должно пройти: {first.text}"
    assert second.status_code == 404, f"ожидали 404 на повтор, получили {second.status_code}"
    assert second.json()["detail"] == "PGAS entry not found", f"неожиданный detail: {second.json()}"


def test_нечисловой_entry_id_даёт_422(client, pgas_admin):
    r = client.delete(f"{PGAS_URL}/abc", headers=pgas_admin.headers)

    assert r.status_code == 422, f"ожидали 422 для нечислового id, получили {r.status_code}: {r.text}"


# ─────────────────────────────────────────────────────────────
#  5. Флаг pgas_admin в MeOut
# ─────────────────────────────────────────────────────────────
def test_me_содержит_pgas_admin_false_у_обычного_пользователя(client, user):
    r = client.get(ME_URL, headers=user.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert "pgas_admin" in r.json(), f"MeOut обязан содержать pgas_admin: {sorted(r.json())}"
    assert r.json()["pgas_admin"] is False, "у обычного пользователя pgas_admin должен быть False"


def test_me_содержит_pgas_admin_true_у_роли(client, pgas_admin):
    r = client.get(ME_URL, headers=pgas_admin.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert r.json()["pgas_admin"] is True, "у pgas_admin флаг обязан быть True"
    assert r.json()["super_user"] is False, "роль ПГАС не должна тянуть за собой super_user"
    assert r.json()["admin"] is False, "роль ПГАС не должна тянуть за собой admin"


def test_выданная_роль_попадает_в_me(client, user):
    """Сценарий скрипта scripts/set_pgas_admin.py: роль выдана — фронт видит кнопки."""
    assert client.get(ME_URL, headers=user.headers).json()["pgas_admin"] is False, (
        "предусловие: роли ещё нет"
    )

    db.update_user(user.user_id, pgas_admin=True)

    assert client.get(ME_URL, headers=user.headers).json()["pgas_admin"] is True, (
        "после выдачи роли MeOut обязан отдавать pgas_admin=True"
    )


def test_профиль_по_id_тоже_отдаёт_pgas_admin(client, pgas_admin):
    """UserOut собирается из dataclass — новое поле приезжает автоматически."""
    r = client.get(f"/api/profile/{pgas_admin.user_id}", headers=pgas_admin.headers)

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert r.json()["pgas_admin"] is True, f"ожидали pgas_admin=True, получили {r.json()}"


# ─────────────────────────────────────────────────────────────
#  6. presigned-url для папки pgas
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "content_type",
    ["application/pdf", "image/png", "image/jpeg", "image/jpg"],
)
def test_pgas_admin_получает_ссылку_на_загрузку(client, pgas_admin, mock_s3, content_type):
    r = client.post(
        UPLOAD_URL,
        json={"folder": "pgas", "content_type": content_type},
        headers=pgas_admin.headers,
    )

    assert r.status_code == 200, f"ожидали 200 для {content_type}, получили {r.status_code}: {r.text}"
    assert set(r.json()) == {"upload_url", "public_url"}, f"неожиданная форма ответа: {r.json()}"
    assert mock_s3["presigned"] == [{"folder": "pgas", "content_type": content_type}], (
        f"в S3 должны уйти ровно переданные folder/content_type, ушло: {mock_s3['presigned']}"
    )


def test_суперюзер_получает_ссылку_на_загрузку(client, superuser, mock_s3):
    r = client.post(
        UPLOAD_URL,
        json={"folder": "pgas", "content_type": "application/pdf"},
        headers=superuser.headers,
    )

    assert r.status_code == 200, f"суперюзеру должно быть разрешено, получили {r.status_code}: {r.text}"
    assert len(mock_s3["presigned"]) == 1, f"ожидали один вызов S3, получено {mock_s3['presigned']}"


@pytest.mark.parametrize("role_fixture", ["user", "admin"])
def test_папка_pgas_закрыта_для_остальных_ролей(client, request, mock_s3, role_fixture):
    actor = request.getfixturevalue(role_fixture)

    r = client.post(
        UPLOAD_URL,
        json={"folder": "pgas", "content_type": "application/pdf"},
        headers=actor.headers,
    )

    assert r.status_code == 403, (
        f"роль {role_fixture} не должна грузить в pgas, получили {r.status_code}: {r.text}"
    )
    assert r.json()["detail"] == UPLOAD_DENIED, f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "при отказе обращения в S3 быть не должно"


def test_мастер_блока_не_может_грузить_в_pgas(client, make_master, mock_s3):
    """Права на папку guides не дают прав на папку pgas."""
    master, _ = make_master(block_name="Медиа")

    r = client.post(
        UPLOAD_URL,
        json={"folder": "pgas", "content_type": "application/pdf"},
        headers=master.headers,
    )

    assert r.status_code == 403, f"ожидали 403 для мастера блока, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == UPLOAD_DENIED, f"неожиданный detail: {r.json()}"


@pytest.mark.parametrize(
    "content_type",
    ["image/gif", "image/svg+xml", "text/html", "application/x-msdownload", "", "application/octet-stream"],
    ids=["gif", "svg", "html", "exe", "пустой", "octet-stream"],
)
def test_запрещённый_content_type_в_папке_pgas_даёт_400(client, pgas_admin, mock_s3, content_type):
    r = client.post(
        UPLOAD_URL,
        json={"folder": "pgas", "content_type": content_type},
        headers=pgas_admin.headers,
    )

    assert r.status_code == 400, (
        f"тип {content_type!r} должен отбиваться, получили {r.status_code}: {r.text}"
    )
    assert r.json()["detail"] == BAD_FILE, f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "при отказе обращения в S3 быть не должно"


def test_проверка_прав_на_pgas_идёт_раньше_проверки_типа(client, user, mock_s3):
    """Обычный пользователь получает 403 по роли, а не 400 по типу файла."""
    r = client.post(
        UPLOAD_URL,
        json={"folder": "pgas", "content_type": "text/html"},
        headers=user.headers,
    )

    assert r.status_code == 403, f"ожидали 403 по правам, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == UPLOAD_DENIED, f"неожиданный detail: {r.json()}"


def test_роль_pgas_admin_не_открывает_папку_guides(client, pgas_admin, mock_s3):
    """Роли не пересекаются: pgas_admin не получает доступ к чужой защищённой папке."""
    r = client.post(
        UPLOAD_URL,
        json={"folder": "guides", "content_type": "image/png"},
        headers=pgas_admin.headers,
    )

    assert r.status_code == 403, f"ожидали 403, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Only superusers and block masters can upload to 'guides' folder", (
        f"неожиданный detail: {r.json()}"
    )


def test_роль_pgas_admin_не_даёт_прав_админа(client, pgas_admin):
    """pgas_admin — узкая роль: админские ручки для неё закрыты."""
    r = client.post("/api/contacts/filter", json={}, headers=pgas_admin.headers)

    assert r.status_code == 403, f"ожидали 403 на админской ручке, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Admin rights required", f"неожиданный detail: {r.json()}"
