"""
Тесты эндпоинта POST /api/upload/presigned-url (main.py:884).

Что покрывается:
  * аутентификация (все виды негодных токенов);
  * авторизация для «защищённой» папки guides;
  * валидация тела запроса (pydantic-модель PresignedUrlRequest, main.py:217);
  * ровно те аргументы, которые улетают в generate_presigned_url;
  * отсутствие санитайзинга folder / content_type — фиксируем ФАКТИЧЕСКОЕ
    поведение и выносим его в отчёт как дефект безопасности.

Фикстура mock_s3 автоиспользуемая: она подменяет main.generate_presigned_url
и складывает вызовы в mock_s3["presigned"].
"""
from __future__ import annotations

import pytest

from database import db

URL = "/api/upload/presigned-url"


# ─────────────────────────────────────────────────────────────
#  helpers
# ─────────────────────────────────────────────────────────────
def _post(client, headers, body):
    return client.post(URL, json=body, headers=headers)


def _assert_urls_shape(body) -> None:
    """Ответ обязан соответствовать UrlsResponse: ровно два строковых поля."""
    assert isinstance(body, dict), f"тело ответа должно быть объектом, получено {type(body)}"
    assert set(body.keys()) == {"upload_url", "public_url"}, (
        f"UrlsResponse должен содержать ровно upload_url и public_url, получено {sorted(body)}"
    )
    assert isinstance(body["upload_url"], str), "upload_url должен быть строкой"
    assert isinstance(body["public_url"], str), "public_url должен быть строкой"
    assert body["upload_url"], "upload_url не должен быть пустым"
    assert body["public_url"], "public_url не должен быть пустым"


# ─────────────────────────────────────────────────────────────
#  1. Happy path
# ─────────────────────────────────────────────────────────────
def test_обычный_пользователь_получает_ссылку_для_обычной_папки(client, user, mock_s3):
    """200 + полная форма UrlsResponse + ровно один вызов S3 с теми же аргументами."""
    r = _post(client, user.headers, {"folder": "avatars", "content_type": "image/jpeg"})

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    _assert_urls_shape(r.json())
    assert mock_s3["presigned"] == [{"folder": "avatars", "content_type": "image/jpeg"}], (
        f"в S3 должны уйти ровно переданные folder/content_type, ушло: {mock_s3['presigned']}"
    )


def test_эндпоинт_не_пишет_в_базу(client, user, mock_s3):
    """Выдача presigned-ссылки — операция без побочных эффектов в БД."""
    before = db.get_user(user.user_id)

    r = _post(client, user.headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    after = db.get_user(user.user_id)
    assert after == before, "запрос ссылки не должен менять запись пользователя в БД"
    assert after.photo_url == before.photo_url, "photo_url не должен меняться при выдаче ссылки"


@pytest.mark.parametrize(
    "folder",
    ["avatars", "guides_preview", "docs", "a", "avatars/nested/deep", "аватары", "folder-with-dash"],
)
def test_любая_папка_кроме_guides_доступна_обычному_пользователю(client, user, mock_s3, folder):
    """Ограничение по ролям навешено только на строку 'guides'."""
    r = _post(client, user.headers, {"folder": folder, "content_type": "image/png"})

    assert r.status_code == 200, f"папка {folder!r} должна быть разрешена, получили {r.status_code}"
    assert mock_s3["presigned"] == [{"folder": folder, "content_type": "image/png"}], (
        f"folder должен уйти в S3 без изменений, ушло: {mock_s3['presigned']}"
    )


def test_лишние_поля_в_теле_игнорируются(client, user, mock_s3):
    """PresignedUrlRequest не запрещает extra — лишние ключи просто отбрасываются."""
    r = _post(
        client,
        user.headers,
        {"folder": "avatars", "content_type": "image/png", "bucket": "чужой-бакет", "key": "hack"},
    )

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert mock_s3["presigned"] == [{"folder": "avatars", "content_type": "image/png"}], (
        "лишние поля не должны влиять на аргументы S3"
    )


def test_повторный_запрос_выдаёт_новую_ссылку(client, user, mock_s3):
    """Идемпотентности нет и не должно быть: каждый вызов — новый объект в S3."""
    first = _post(client, user.headers, {"folder": "avatars", "content_type": "image/png"})
    second = _post(client, user.headers, {"folder": "avatars", "content_type": "image/png"})

    assert first.status_code == 200 and second.status_code == 200, "оба запроса должны быть успешны"
    assert len(mock_s3["presigned"]) == 2, (
        f"должно быть ровно два обращения в S3, получено {len(mock_s3['presigned'])}"
    )
    assert first.json()["public_url"] != second.json()["public_url"], (
        "два вызова обязаны дать разные ключи объектов, иначе загрузки затрут друг друга"
    )


# ─────────────────────────────────────────────────────────────
#  2. Аутентификация
# ─────────────────────────────────────────────────────────────
def test_аноним_получает_401(client, anon, mock_s3):
    r = _post(client, anon, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 401, f"ожидали 401 для анонима, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not authenticated", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "для анонима не должно быть обращений в S3"


def test_анониму_отказ_приходит_раньше_валидации_тела(client, anon, mock_s3):
    """Даже с заведомо невалидным телом сначала отрабатывает security-зависимость."""
    r = _post(client, anon, {})

    assert r.status_code == 401, (
        f"неавторизованный запрос с битым телом должен давать 401, а не 422; получили {r.status_code}"
    )
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


@pytest.mark.parametrize(
    "header_value, expected_detail",
    [
        ("", "Not authenticated"),
        # пустой токен при верной схеме доходит до декодера, поэтому detail другой
        ("Bearer", "Access token invalid or expired"),
        ("Basic dXNlcjpwYXNz", "Not authenticated"),
        ("Token abc.def.ghi", "Not authenticated"),
        ("Bearer ", "Access token invalid or expired"),
        ("Bearer not-a-jwt", "Access token invalid or expired"),
        ("Bearer a.b.c", "Access token invalid or expired"),
        ("Bearer " + "x" * 5000, "Access token invalid or expired"),
    ],
    ids=[
        "пустой-заголовок",
        "только-схема",
        "схема-basic",
        "схема-token",
        "схема-без-токена",
        "мусор-вместо-jwt",
        "три-сегмента-мусора",
        "очень-длинный-токен",
    ],
)
def test_кривой_заголовок_авторизации_даёт_401(client, mock_s3, header_value, expected_detail):
    r = _post(
        client,
        {"Authorization": header_value},
        {"folder": "avatars", "content_type": "image/png"},
    )

    assert r.status_code == 401, f"ожидали 401 для заголовка {header_value!r}, получили {r.status_code}"
    assert r.json()["detail"] == expected_detail, f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


def test_просроченный_access_токен_даёт_401(client, user, expired_access_token, mock_s3):
    headers = {"Authorization": f"Bearer {expired_access_token(user.user_id)}"}

    r = _post(client, headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Access token invalid or expired", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


def test_refresh_типизированный_jwt_не_принимается(client, user, refresh_typed_token, mock_s3):
    """type=refresh обязан отбиваться в _decode_access (auth.py:79)."""
    headers = {"Authorization": f"Bearer {refresh_typed_token(user.user_id)}"}

    r = _post(client, headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Not an access token", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


def test_токен_подписанный_чужим_секретом_не_принимается(client, user, foreign_signed_token, mock_s3):
    headers = {"Authorization": f"Bearer {foreign_signed_token(user.user_id)}"}

    r = _post(client, headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Access token invalid or expired", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


def test_опаковый_refresh_токен_из_базы_не_годится_как_access(client, user, mock_s3):
    """refresh_token — обычный uuid, он не является JWT и должен отбиваться."""
    headers = {"Authorization": f"Bearer {user.refresh_token}"}

    r = _post(client, headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "Access token invalid or expired", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


def test_токен_удалённого_пользователя_даёт_401(client, user, mock_s3):
    db.delete_user(user.user_id)
    assert db.get_user(user.user_id) is None, "предусловие: пользователь удалён из базы"

    r = _post(client, user.headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 401, f"ожидали 401, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "User not found", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


def test_забаненный_пользователь_получает_403(client, banned_user, mock_s3):
    r = _post(client, banned_user.headers, {"folder": "avatars", "content_type": "image/png"})

    assert r.status_code == 403, f"ожидали 403 для забаненного, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "User is banned", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "забаненный не должен получать ссылку на загрузку"


def test_забаненный_суперюзер_тоже_не_получает_ссылку(client, make_user, mock_s3):
    """Бан бьёт раньше любых привилегий (auth.py:96)."""
    actor = make_user(super_user=True, banned=True, name="Бан", surname="Супергеров")

    r = _post(client, actor.headers, {"folder": "guides", "content_type": "image/png"})

    assert r.status_code == 403, f"ожидали 403, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == "User is banned", f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "не должно быть обращений в S3"


# ─────────────────────────────────────────────────────────────
#  3. Авторизация: папка guides
# ─────────────────────────────────────────────────────────────
GUIDES_DENIED = "Only superusers and block masters can upload to 'guides' folder"


def test_обычному_пользователю_запрещена_папка_guides(client, user, mock_s3):
    r = _post(client, user.headers, {"folder": "guides", "content_type": "image/png"})

    assert r.status_code == 403, f"ожидали 403, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == GUIDES_DENIED, f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "при отказе обращения в S3 быть не должно"


def test_суперюзер_может_загружать_в_guides(client, superuser, mock_s3):
    r = _post(client, superuser.headers, {"folder": "guides", "content_type": "image/jpeg"})

    assert r.status_code == 200, f"суперюзеру должно быть разрешено, получили {r.status_code}: {r.text}"
    _assert_urls_shape(r.json())
    assert mock_s3["presigned"] == [{"folder": "guides", "content_type": "image/jpeg"}], (
        f"неожиданные аргументы S3: {mock_s3['presigned']}"
    )


def test_мастер_блока_может_загружать_в_guides(client, make_master, mock_s3):
    master, block = make_master(block_name="Медиа")
    assert db.get_user_master_block_names(master.user_id) == [block.name], (
        "предусловие: пользователь действительно числится мастером блока"
    )

    r = _post(client, master.headers, {"folder": "guides", "content_type": "image/png"})

    assert r.status_code == 200, f"мастеру должно быть разрешено, получили {r.status_code}: {r.text}"
    _assert_urls_shape(r.json())
    assert mock_s3["presigned"] == [{"folder": "guides", "content_type": "image/png"}], (
        f"неожиданные аргументы S3: {mock_s3['presigned']}"
    )


def test_hr_блока_не_может_загружать_в_guides(client, make_hr, mock_s3):
    """Проверка смотрит только на master, HR — не мастер."""
    hr, _ = make_hr(block_name="Медиа", master_name="Иной Мастеров")
    assert db.get_user_master_block_names(hr.user_id) == [], "предусловие: HR не мастер"

    r = _post(client, hr.headers, {"folder": "guides", "content_type": "image/png"})

    assert r.status_code == 403, f"ожидали 403 для HR, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == GUIDES_DENIED, f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "при отказе обращения в S3 быть не должно"


def test_админ_без_блока_не_может_загружать_в_guides(client, admin, mock_s3):
    """admin=True сам по себе прав на guides не даёт."""
    r = _post(client, admin.headers, {"folder": "guides", "content_type": "image/png"})

    assert r.status_code == 403, f"ожидали 403 для админа-не-мастера, получили {r.status_code}"
    assert r.json()["detail"] == GUIDES_DENIED, f"неожиданный detail: {r.json()}"
    assert mock_s3["presigned"] == [], "при отказе обращения в S3 быть не должно"


def test_пользователь_без_kkr_name_не_может_загружать_в_guides(client, make_user, mock_s3):
    """Пустой kkr_name → get_user_master_block_names возвращает [] (database.py:707)."""
    actor = make_user(kkr_name="")
    assert db.get_user_master_block_names(actor.user_id) == [], "предусловие: прав мастера нет"

    r = _post(client, actor.headers, {"folder": "guides", "content_type": "image/png"})

    assert r.status_code == 403, f"ожидали 403, получили {r.status_code}: {r.text}"
    assert r.json()["detail"] == GUIDES_DENIED, f"неожиданный detail: {r.json()}"


@pytest.mark.parametrize(
    "folder",
    ["Guides", "GUIDES", "guides/", "/guides", " guides", "guides ", "guides/nested", "gUiDeS"],
)
def test_проверка_guides_обходится_регистром_и_слешем(client, user, mock_s3, folder):
    """
    ДЕФЕКТ (main.py:893): сравнение `payload.folder == 'guides'` — точное.

    Обычный пользователь попадает в тот же (или соседний) префикс бакета,
    просто изменив регистр или дописав слеш. Тест фиксирует ФАКТИЧЕСКОЕ
    поведение: отказа нет.
    """
    r = _post(client, user.headers, {"folder": folder, "content_type": "image/png"})

    assert r.status_code == 200, (
        f"фактическое поведение: {folder!r} проверку не проходит и запрос выполняется; "
        f"получили {r.status_code}: {r.text}"
    )
    assert mock_s3["presigned"] == [{"folder": folder, "content_type": "image/png"}], (
        f"folder уходит в ключ объекта без нормализации, ушло: {mock_s3['presigned']}"
    )


# ─────────────────────────────────────────────────────────────
#  4. Валидация тела запроса
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "body, missing_field",
    [
        ({}, "folder"),
        ({"content_type": "image/png"}, "folder"),
        ({"folder": "avatars"}, "content_type"),
    ],
    ids=["пустое-тело", "нет-folder", "нет-content_type"],
)
def test_отсутствие_обязательного_поля_даёт_422(client, user, mock_s3, body, missing_field):
    r = _post(client, user.headers, body)

    assert r.status_code == 422, f"ожидали 422, получили {r.status_code}: {r.text}"
    fields = {err["loc"][-1] for err in r.json()["detail"]}
    assert missing_field in fields, f"в ошибке должно фигурировать поле {missing_field}: {r.json()}"
    assert mock_s3["presigned"] == [], "невалидный запрос не должен доходить до S3"


@pytest.mark.parametrize(
    "body",
    [
        {"folder": None, "content_type": "image/png"},
        {"folder": "avatars", "content_type": None},
        {"folder": 123, "content_type": "image/png"},
        {"folder": "avatars", "content_type": 1.5},
        {"folder": True, "content_type": "image/png"},
        {"folder": ["avatars"], "content_type": "image/png"},
        {"folder": {"name": "avatars"}, "content_type": "image/png"},
        {"folder": "avatars", "content_type": ["image/png"]},
    ],
    ids=[
        "folder-null",
        "content_type-null",
        "folder-int",
        "content_type-float",
        "folder-bool",
        "folder-список",
        "folder-объект",
        "content_type-список",
    ],
)
def test_неверный_тип_поля_даёт_422(client, user, mock_s3, body):
    r = _post(client, user.headers, body)

    assert r.status_code == 422, f"ожидали 422 для {body}, получили {r.status_code}: {r.text}"
    assert mock_s3["presigned"] == [], "невалидный запрос не должен доходить до S3"


def test_тело_не_объект_даёт_422(client, user, mock_s3):
    r = _post(client, user.headers, ["avatars", "image/png"])

    assert r.status_code == 422, f"ожидали 422, получили {r.status_code}: {r.text}"
    assert mock_s3["presigned"] == [], "невалидный запрос не должен доходить до S3"


def test_тело_не_json_даёт_422(client, user, mock_s3):
    r = client.post(
        URL,
        content=b"folder=avatars",
        headers={**user.headers, "Content-Type": "application/json"},
    )

    assert r.status_code == 422, f"ожидали 422 для битого JSON, получили {r.status_code}: {r.text}"
    assert mock_s3["presigned"] == [], "невалидный запрос не должен доходить до S3"


# ─────────────────────────────────────────────────────────────
#  5. Отсутствие санитайзинга folder → path traversal
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "folder",
    [
        "../../etc",
        "..",
        "avatars/../guides",
        "/absolute",
        "//double-slash",
        "guides/../guides",
        "\\windows\\path",
        "a\nb",
        "a\tb",
        "%2e%2e%2fguides",
        "?query=1",
        "a#b",
    ],
    ids=[
        "выход-вверх",
        "две-точки",
        "traversal-в-guides",
        "ведущий-слеш",
        "двойной-слеш",
        "traversal-внутри-guides",
        "обратные-слеши",
        "перевод-строки",
        "табуляция",
        "url-кодированный-traversal",
        "знак-вопроса",
        "решётка",
    ],
)
def test_folder_не_санитайзится_и_уходит_в_ключ_как_есть(client, user, mock_s3, folder):
    """
    ДЕФЕКТ (main.py:896 → utils/s3_service.py:21): folder подставляется в
    f"{folder}/{uuid}.{ext}" без какой-либо проверки. Фиксируем фактическое
    поведение — запрос проходит, значение доезжает до генератора ключа.
    """
    r = _post(client, user.headers, {"folder": folder, "content_type": "image/png"})

    assert r.status_code == 200, (
        f"фактическое поведение: {folder!r} принимается без проверок, получили {r.status_code}"
    )
    assert mock_s3["presigned"] == [{"folder": folder, "content_type": "image/png"}], (
        f"значение folder должно доехать до S3 неизменным: {mock_s3['presigned']}"
    )


@pytest.mark.parametrize(
    "folder",
    ["", " ", "   ", "\t", "\n"],
    ids=["пустая-строка", "один-пробел", "несколько-пробелов", "таб", "перевод-строки"],
)
def test_пустая_или_пробельная_папка_принимается(client, user, mock_s3, folder):
    """min_length у folder нет — пустая строка порождает ключ вида "/uuid.png"."""
    r = _post(client, user.headers, {"folder": folder, "content_type": "image/png"})

    assert r.status_code == 200, (
        f"фактическое поведение: пустая/пробельная папка принимается, получили {r.status_code}"
    )
    assert mock_s3["presigned"] == [{"folder": folder, "content_type": "image/png"}], (
        f"неожиданные аргументы S3: {mock_s3['presigned']}"
    )


def test_очень_длинное_имя_папки_принимается(client, user, mock_s3):
    """max_length нет — ключ объекта может превысить лимит S3 (1024 байта)."""
    folder = "a" * 5000

    r = _post(client, user.headers, {"folder": folder, "content_type": "image/png"})

    assert r.status_code == 200, (
        f"фактическое поведение: длина folder не ограничена, получили {r.status_code}"
    )
    assert mock_s3["presigned"][0]["folder"] == folder, "folder должен уйти целиком"
    assert len(mock_s3["presigned"]) == 1, "должен быть ровно один вызов S3"


def test_юникод_и_эмодзи_в_имени_папки_принимаются(client, user, mock_s3):
    folder = "аватары/日本語/🙂"

    r = _post(client, user.headers, {"folder": folder, "content_type": "image/png"})

    assert r.status_code == 200, f"ожидали 200, получили {r.status_code}: {r.text}"
    assert mock_s3["presigned"] == [{"folder": folder, "content_type": "image/png"}], (
        f"юникод должен доехать без искажений: {mock_s3['presigned']}"
    )


# ─────────────────────────────────────────────────────────────
#  6. Отсутствие валидации content_type
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "content_type",
    [
        "",
        " ",
        "notaslash",
        "image",
        "a/b/c/d",
        "/",
        "//",
        "image/",
        "/png",
        "application/x-msdownload",
        "text/html",
        "application/x-sh",
        "application/octet-stream",
        "image/png; charset=utf-8",
        "картинка/пнг",
        "image/../../evil",
        "x" * 3000,
    ],
    ids=[
        "пустой",
        "пробел",
        "без-слеша",
        "только-тип",
        "много-слешей",
        "один-слеш",
        "два-слеша",
        "без-подтипа",
        "без-типа",
        "исполняемый-файл",
        "html-для-xss",
        "shell-скрипт",
        "octet-stream",
        "с-параметром",
        "юникод",
        "traversal-в-типе",
        "очень-длинный",
    ],
)
def test_content_type_никак_не_валидируется(client, user, mock_s3, content_type):
    """
    ДЕФЕКТ (main.py:217 и main.py:896): content_type — просто str.
    Ни белого списка image/*, ни проверки формата: любое значение
    уходит в подпись presigned-URL и в расширение файла.
    """
    r = _post(client, user.headers, {"folder": "avatars", "content_type": content_type})

    assert r.status_code == 200, (
        f"фактическое поведение: content_type {content_type!r} принимается, получили {r.status_code}"
    )
    assert mock_s3["presigned"] == [{"folder": "avatars", "content_type": content_type}], (
        f"content_type должен уйти в S3 неизменным: {mock_s3['presigned']}"
    )


@pytest.mark.parametrize(
    "content_type",
    ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"],
)
def test_нормальные_image_типы_проходят(client, user, mock_s3, content_type):
    r = _post(client, user.headers, {"folder": "avatars", "content_type": content_type})

    assert r.status_code == 200, f"ожидали 200 для {content_type}, получили {r.status_code}"
    _assert_urls_shape(r.json())
    assert mock_s3["presigned"] == [{"folder": "avatars", "content_type": content_type}], (
        f"неожиданные аргументы S3: {mock_s3['presigned']}"
    )


# ─────────────────────────────────────────────────────────────
#  7. Прочие HTTP-детали
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
def test_другие_http_методы_не_поддерживаются(client, user, method):
    r = getattr(client, method)(URL, headers=user.headers)

    assert r.status_code == 405, f"ожидали 405 для {method.upper()}, получили {r.status_code}"
