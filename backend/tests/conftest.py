"""
Общие фикстуры для тестов бэкенда Профком ВМК.

Ключевой принцип: тесты НИКОГДА не трогают боевую базу.
DATABASE_PATH подменяется на временный файл ДО первого импорта
`settings` / `database` / `main`, поэтому этот модуль обязан
выставить переменные окружения раньше любых импортов проекта.
"""
from __future__ import annotations

import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

# ─────────────────────────────────────────────────────────────
#  1. Изоляция окружения — ДО импортов проекта
# ─────────────────────────────────────────────────────────────
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

_TMP_DB = Path(tempfile.gettempdir()) / f"profkom_test_{uuid.uuid4().hex}.db"

os.environ["DATABASE_PATH"] = str(_TMP_DB)
# Детерминированный секрет: подписи токенов не должны зависеть от .env разработчика
os.environ["JWT_SECRET_KEY"] = "test-secret-key-do-not-use-in-production"
os.environ["ACCESS_TOKEN_EXPIRE_MINUTES"] = "30"
os.environ["REFRESH_TOKEN_EXPIRE_DAYS"] = "7"
# Пустые S3-креды: клиент boto3 создаётся на импорте, но никуда не ходит — все вызовы мокаются
os.environ.setdefault("S3_ENDPOINT", "https://s3.test.local")
os.environ.setdefault("S3_ACCESS_KEY", "test-key")
os.environ.setdefault("S3_SECRET_KEY", "test-secret")
os.environ.setdefault("S3_BUCKET_NAME", "test-bucket")
os.environ.setdefault("S3_TENANT_ID", "test-tenant")
os.environ.setdefault("S3_REGION_NAME", "ru-central-1")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth as auth_module  # noqa: E402
import database as database_module  # noqa: E402
import main as main_module  # noqa: E402
from database import db  # noqa: E402
from models import Block, ContactInfo, User  # noqa: E402

# Страховка: если .env всё-таки перебил переменную — падаем сразу, а не портим боевую базу
assert str(_TMP_DB) in database_module.DATABASE_URL, (
    f"Тесты подключились не к временной базе, а к {database_module.DATABASE_URL}. "
    "Проверь приоритет переменных окружения в settings.py."
)

TABLES = ("refresh_tokens", "contact_info", "guides", "block", "pgas_entries", "users")


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Удаляем временную базу после прогона."""
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(_TMP_DB) + suffix)
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass


# ─────────────────────────────────────────────────────────────
#  2. Клиент и чистка базы
# ─────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def app():
    return main_module.app


@pytest.fixture(scope="session")
def client(app) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clean_db() -> Iterator[None]:
    """Каждый тест стартует с пустой базой — порядок тестов не важен."""
    _truncate()
    yield
    _truncate()


def _truncate() -> None:
    from sqlalchemy import text

    with database_module.engine.begin() as conn:
        for table in TABLES:
            conn.execute(text(f"DELETE FROM {table}"))
        # sqlite_sequence появляется только после первой вставки в AUTOINCREMENT-таблицу
        exists = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
        ).first()
        if exists:
            conn.execute(text("DELETE FROM sqlite_sequence"))


# ─────────────────────────────────────────────────────────────
#  3. Моки внешних сервисов (S3 и VK никогда не вызываются по-настоящему)
# ─────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def mock_s3(monkeypatch) -> dict[str, Any]:
    """
    Подменяет обе точки выхода в S3.

    `generate_presigned_url` импортирован в main.py на уровне модуля,
    поэтому патчим main.generate_presigned_url.
    `upload_image_from_url` импортируется внутри тела vk_login,
    поэтому патчим его по месту определения — utils.s3_service.
    """
    import utils.s3_service as s3_service

    calls: dict[str, list] = {"presigned": [], "upload": []}

    def fake_presigned(folder: str, content_type: str) -> dict[str, str]:
        calls["presigned"].append({"folder": folder, "content_type": content_type})
        ext = content_type.split("/")[-1]
        if ext == "jpeg":
            ext = "jpg"
        key = f"{folder}/{uuid.uuid4()}.{ext}"
        return {
            "upload_url": f"https://s3.test.local/{key}?X-Amz-Signature=fake",
            "public_url": f"https://global.s3.cloud.ru/test-bucket/{key}",
        }

    def fake_upload(url: str, folder: str = "avatars") -> Optional[str]:
        calls["upload"].append({"url": url, "folder": folder})
        if not url:
            return None
        return f"https://global.s3.cloud.ru/test-bucket/{folder}/{uuid.uuid4()}.jpg"

    monkeypatch.setattr(main_module, "generate_presigned_url", fake_presigned)
    monkeypatch.setattr(s3_service, "generate_presigned_url", fake_presigned)
    monkeypatch.setattr(s3_service, "upload_image_from_url", fake_upload)
    return calls


@pytest.fixture
def mock_vk(monkeypatch) -> Callable[..., dict]:
    """
    Фабрика мока VK API.

    vk_login делает `import urllib.request` внутри функции и зовёт
    urllib.request.urlopen — патчим именно его. Возвращаемый объект
    поддерживает контекстный менеджер, как настоящий ответ urlopen.
    """
    import json as _json
    import urllib.request

    state: dict[str, Any] = {"requests": []}

    class _FakeResponse:
        def __init__(self, payload: dict):
            self._body = _json.dumps(payload).encode("utf-8")
            self.headers = {"Content-Type": "application/json"}

        def read(self) -> bytes:
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def configure(
        *,
        user_id: str = "777",
        first_name: str = "Пётр",
        last_name: str = "Сидоров",
        email: Optional[str] = None,
        phone: Optional[str] = None,
        avatar: Optional[str] = None,
        fail_primary: bool = False,
        fail_all: bool = False,
    ) -> dict:
        """Настраивает ответ VK. Возвращает словарь состояния для проверок."""

        def fake_urlopen(req, *args, **kwargs):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            state["requests"].append(url)
            if fail_all:
                raise OSError("VK unreachable")
            if "id.vk.ru/oauth2/user_info" in url:
                if fail_primary:
                    raise OSError("primary endpoint down")
                user: dict[str, Any] = {"user_id": user_id, "first_name": first_name, "last_name": last_name}
                if email:
                    user["email"] = email
                if phone:
                    user["phone"] = phone
                if avatar:
                    user["avatar"] = avatar
                return _FakeResponse({"user": user})
            if "api.vk.com/method/users.get" in url:
                user2: dict[str, Any] = {"id": int(user_id), "first_name": first_name, "last_name": last_name}
                if avatar:
                    user2["photo_max"] = avatar
                if phone:
                    user2["mobile_phone"] = phone
                return _FakeResponse({"response": [user2]})
            raise OSError(f"unexpected URL in test: {url}")

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        return state

    return configure


# ─────────────────────────────────────────────────────────────
#  4. Фабрики пользователей и ролей
# ─────────────────────────────────────────────────────────────
DEFAULT_PASSWORD = "Passw0rd!"


class Actor:
    """Пользователь + всё, что нужно, чтобы ходить от его имени."""

    def __init__(self, user_id: int, email: str, password: str, kkr_name: str, tokens: dict):
        self.user_id = user_id
        self.email = email
        self.password = password
        self.kkr_name = kkr_name
        self.access_token = tokens["access_token"]
        self.refresh_token = tokens["refresh_token"]

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Actor #{self.user_id} {self.email}>"


@pytest.fixture
def make_user() -> Callable[..., Actor]:
    """
    Создаёт пользователя напрямую в базе (минуя HTTP) и выдаёт ему токены.

    Прямая запись, а не /auth/register, — намеренно: так тест может
    поставить любые флаги (admin, super_user, banned) и не зависит
    от валидации регистрации.
    """
    counter = {"n": 0}

    def _make(
        *,
        email: Optional[str] = None,
        password: Optional[str] = DEFAULT_PASSWORD,
        name: str = "Тест",
        surname: str = "Пользователь",
        patronymic: str = "",
        kkr_name: Optional[str] = None,
        group_number: str = "101",
        blocks: str = "",
        admin: bool = False,
        super_user: bool = False,
        pgas_admin: bool = False,
        banned: bool = False,
        in_profcom: bool = False,
        budget: bool = True,
        photo_url: Optional[str] = None,
        phone: str = "",
        vk: str = "",
        tg: str = "",
        location: str = "",
    ) -> Actor:
        counter["n"] += 1
        n = counter["n"]
        email = email or f"user{n}_{uuid.uuid4().hex[:6]}@test.ru"
        # Фамилия по умолчанию делается уникальной: _sync_admin_rights ищет
        # пользователя по kkr_name и берёт .first(), поэтому одинаковые ФИО
        # у разных фикстур приводят к выдаче прав не тому пользователю.
        if surname == "Пользователь":
            surname = f"Пользователь{n}"
        kkr_name = kkr_name if kkr_name is not None else f"{name} {surname}".strip()

        contact = ContactInfo(
            user_id=0,
            email=email,
            surname=surname,
            name=name,
            patronymic=patronymic,
            kkr_name=kkr_name,
            group_number=group_number,
            location=location,
            blocks=blocks,
            phone=phone,
            vk=vk,
            tg=tg,
            budget=budget,
            in_profcom=in_profcom,
        )
        user = User(
            user_id=0,
            hashed_password=auth_module.hash_password(password) if password else "",
            kkr_score=0,
            group_number=group_number,
            blocks=blocks,
            photo_url=photo_url,
            banned=False,          # флаги ставим после создания, чтобы не мешать sync-логике
            super_user=False,
            admin=False,
        )
        created = db.create_user_with_contact(contact, user)

        updates: dict[str, Any] = {}
        if admin:
            updates["admin"] = True
        if super_user:
            updates["super_user"] = True
        if pgas_admin:
            updates["pgas_admin"] = True
        if banned:
            updates["banned"] = True
        if updates:
            db.update_user(created.user_id, **updates)

        tokens = auth_module.create_token_pair(created.user_id)
        return Actor(created.user_id, email, password or "", kkr_name, tokens)

    return _make


@pytest.fixture
def user(make_user) -> Actor:
    """Обычный авторизованный пользователь без прав."""
    return make_user()


@pytest.fixture
def admin(make_user) -> Actor:
    """admin=True, super_user=False."""
    return make_user(admin=True, name="Админ", surname="Админов")


@pytest.fixture
def superuser(make_user) -> Actor:
    """super_user=True."""
    return make_user(super_user=True, name="Супер", surname="Юзеров")


@pytest.fixture
def pgas_admin(make_user) -> Actor:
    """pgas_admin=True — права только на раздел ПГАС."""
    return make_user(pgas_admin=True, name="Пгас", surname="Пгасов")


@pytest.fixture
def banned_user(make_user) -> Actor:
    return make_user(banned=True, name="Бан", surname="Баннов")


@pytest.fixture
def anon() -> dict:
    """Пустые заголовки — запрос без авторизации."""
    return {}


# ─────────────────────────────────────────────────────────────
#  5. Фабрики доменных объектов
# ─────────────────────────────────────────────────────────────
@pytest.fixture
def make_block() -> Callable[..., Block]:
    def _make(
        name: str = "Медиа",
        master: str = "",
        hr: str = "",
        cnt_of_human: int = 0,
        arr_of_human: Optional[list[int]] = None,
    ) -> Block:
        return db.create_block(
            Block(
                name=name,
                master=master,
                hr=hr,
                cnt_of_human=cnt_of_human,
                arr_of_human=list(arr_of_human or []),
            )
        )

    return _make


@pytest.fixture
def make_master(make_user, make_block):
    """
    Мастер блока: пользователь, чей kkr_name записан в block.master.

    Побочный эффект боевого кода: create_block вызывает _sync_admin_rights,
    поэтому мастер автоматически получает admin=True. Тесты на это опираются.
    """

    def _make(block_name: str = "Медиа", **user_kwargs) -> tuple[Actor, Block]:
        actor = make_user(**user_kwargs)
        block = make_block(name=block_name, master=actor.kkr_name)
        return actor, block

    return _make


@pytest.fixture
def make_hr(make_user, make_block):
    """HR блока: пользователь, чей kkr_name записан в block.hr."""

    def _make(block_name: str = "Медиа", master_name: str = "Мастер Мастеров", **user_kwargs):
        actor = make_user(**user_kwargs)
        block = make_block(name=block_name, master=master_name, hr=actor.kkr_name)
        return actor, block

    return _make


@pytest.fixture
def make_guide() -> Callable[..., Any]:
    from models import Guide

    def _make(
        title: str = "Тестовый гайд",
        owner_block: str = "none",
        text: str = "# Заголовок\n\nтело",
        description: str = "",
        original_link: Optional[str] = None,
    ):
        return db.create_guide(
            Guide(
                guide_id=0,
                title=title,
                owner_block=owner_block,
                text=text,
                description=description,
                original_link=original_link,
            )
        )

    return _make


# ─────────────────────────────────────────────────────────────
#  6. Утилиты для токенов
# ─────────────────────────────────────────────────────────────
@pytest.fixture
def expired_access_token() -> Callable[[int], str]:
    """Валидно подписанный, но просроченный access-токен."""
    from jose import jwt

    def _make(user_id: int) -> str:
        now = datetime.now(timezone.utc) - timedelta(hours=2)
        payload = {"sub": str(user_id), "type": "access", "iat": now, "exp": now + timedelta(minutes=30)}
        return jwt.encode(payload, auth_module.SECRET_KEY, algorithm=auth_module.ALGORITHM)

    return _make


@pytest.fixture
def refresh_typed_token() -> Callable[[int], str]:
    """JWT с type=refresh — не должен приниматься там, где ждут access."""
    from jose import jwt

    def _make(user_id: int) -> str:
        now = datetime.now(timezone.utc)
        payload = {"sub": str(user_id), "type": "refresh", "iat": now, "exp": now + timedelta(days=7)}
        return jwt.encode(payload, auth_module.SECRET_KEY, algorithm=auth_module.ALGORITHM)

    return _make


@pytest.fixture
def foreign_signed_token() -> Callable[[int], str]:
    """Токен, подписанный чужим секретом."""
    from jose import jwt

    def _make(user_id: int) -> str:
        now = datetime.now(timezone.utc)
        payload = {"sub": str(user_id), "type": "access", "iat": now, "exp": now + timedelta(minutes=30)}
        return jwt.encode(payload, "totally-different-secret", algorithm="HS256")

    return _make


@pytest.fixture
def expired_refresh_token() -> Callable[[int], str]:
    """Refresh-токен, лежащий в базе с прошедшей датой истечения."""

    def _make(user_id: int) -> str:
        token = str(uuid.uuid4())
        db.save_refresh_token(token, user_id, datetime.now(timezone.utc) - timedelta(days=1))
        return token

    return _make
