"""
Тесты раздела «Гайды» (main.py:650-785).

Покрываются:
  * GET    /api/guides                — список с ОПЦИОНАЛЬНОЙ авторизацией и правилами видимости;
  * GET    /api/guides/{guide_id}     — чтение одного гайда;
  * POST   /api/guides                — создание (суперюзер / мастер блока);
  * POST|PUT|PATCH /api/guides/{id}   — редактирование (один обработчик на три глагола);
  * DELETE /api/guides/{guide_id}     — удаление.

Каждый отказ проверяется по ТОЧНОМУ тексту detail, каждая запись — по состоянию базы.
"""
from __future__ import annotations

import pytest

from database import db

# ─────────────────────────────────────────────────────────────
#  Константы и утилиты
# ─────────────────────────────────────────────────────────────
GUIDES_URL = "/api/guides"

#: три глагола, которые ведут в ОДИН и тот же обработчик edit_guide (main.py:719-721)
EDIT_METHODS = ("POST", "PUT", "PATCH")

#: значения owner_block, которые делают гайд публичным (main.py:663, 678)
PUBLIC_OWNER_BLOCKS = ("", "none", "all", " NoNe ", "  ALL  ", "NONE", "All")

GUIDE_OUT_FIELDS = {"guide_id", "title", "owner_block", "text", "description", "original_link"}


def edit(client, method: str, guide_id, payload: dict, headers: dict):
    """Единая точка входа для всех трёх глаголов редактирования."""
    return client.request(method, f"{GUIDES_URL}/{guide_id}", json=payload, headers=headers)


def assert_guide_out_shape(body: dict) -> None:
    """Проверяет полную форму GuideOut: состав полей и типы значений."""
    assert isinstance(body, dict), f"Ожидался объект GuideOut, получено {type(body)}"
    assert set(body.keys()) == GUIDE_OUT_FIELDS, (
        f"Состав полей GuideOut изменился: лишние {set(body) - GUIDE_OUT_FIELDS}, "
        f"отсутствуют {GUIDE_OUT_FIELDS - set(body)}"
    )
    assert isinstance(body["guide_id"], int), "guide_id должен быть int"
    assert body["guide_id"] > 0, "guide_id должен быть положительным"
    assert isinstance(body["title"], str), "title должен быть str"
    assert isinstance(body["owner_block"], str), "owner_block должен быть str"
    assert isinstance(body["text"], str), "text должен быть str"
    assert isinstance(body["description"], str), "description должен быть str"
    assert body["original_link"] is None or isinstance(body["original_link"], str), (
        "original_link должен быть str или null"
    )


def ids_of(response) -> set[int]:
    return {g["guide_id"] for g in response.json()}


# ─────────────────────────────────────────────────────────────
#  Фикстуры набора гайдов и «плохих» токенов
# ─────────────────────────────────────────────────────────────
@pytest.fixture
def zoo(make_user, make_block, make_guide, make_user_in_block):
    """
    Полный «зоопарк» видимости: два блока и гайды всех сортов.

    Возвращает словарь с гайдами и актёрами.
    """
    make_block(name="Медиа", master="Мастер Медиа")
    make_block(name="Наука", master="Мастер Науки")

    guides = {
        "пустой": make_guide(title="Публичный (пустой owner_block)", owner_block=""),
        "none": make_guide(title="Публичный none", owner_block="none"),
        "all": make_guide(title="Публичный all", owner_block="all"),
        "none_регистр": make_guide(title="Публичный ' NoNe '", owner_block=" NoNe "),
        "all_регистр": make_guide(title="Публичный '  ALL  '", owner_block="  ALL  "),
        "медиа": make_guide(title="Гайд Медиа", owner_block="Медиа"),
        "медиа_пробелы": make_guide(title="Гайд ' Медиа '", owner_block=" Медиа "),
        "медиа_регистр": make_guide(title="Гайд 'медиа'", owner_block="медиа"),
        "наука": make_guide(title="Гайд Науки", owner_block="Наука"),
    }
    public_ids = {guides[k].guide_id for k in ("пустой", "none", "all", "none_регистр", "all_регистр")}
    media_ids = {guides[k].guide_id for k in ("медиа", "медиа_пробелы", "медиа_регистр")}
    science_ids = {guides["наука"].guide_id}
    return {
        "guides": guides,
        "public_ids": public_ids,
        "media_ids": media_ids,
        "science_ids": science_ids,
        "all_ids": public_ids | media_ids | science_ids,
    }


@pytest.fixture
def make_user_in_block(make_user):
    """Рядовой участник блока: блок должен уже существовать (иначе синхронизация его отбросит)."""

    def _make(block_name: str, **kw):
        actor = make_user(blocks=block_name, **kw)
        assert block_name in db.get_user_block_names(actor.user_id), (
            f"Фикстура не смогла записать пользователя в блок {block_name!r}"
        )
        return actor

    return _make


@pytest.fixture
def deleted_user_headers(make_user):
    """
    Токен пользователя, которого удалили из базы уже после выдачи токена.

    Соседний пользователь создаётся намеренно и НЕ удаляется: без него SQLite
    переиспользует освободившийся rowid, и токен «удалённого» начал бы указывать
    на следующего созданного пользователя.
    """
    victim = make_user()
    _keeper = make_user()
    db.delete_user(victim.user_id)
    assert db.get_user(victim.user_id) is None, "Пользователь должен быть удалён"
    return victim.headers


@pytest.fixture
def auth_cases(
    make_user,
    banned_user,
    deleted_user_headers,
    expired_access_token,
    refresh_typed_token,
    foreign_signed_token,
):
    """
    Таблица «плохих» аутентификаций: kind -> (headers, ожидаемый статус, ожидаемый detail).

    Используется всеми защищёнными эндпоинтами раздела.
    """
    victim = make_user()
    return {
        "нет_токена": ({}, 401, "Not authenticated"),
        "мусор_вместо_jwt": ({"Authorization": "Bearer this-is-not-a-jwt"}, 401, "Access token invalid or expired"),
        "jwt_без_схемы": ({"Authorization": victim.access_token}, 401, "Not authenticated"),
        "чужая_схема": ({"Authorization": f"Basic {victim.access_token}"}, 401, "Not authenticated"),
        # "Bearer " с пустым токеном проходит схему OAuth2 и падает уже на декодировании
        "пустой_bearer": ({"Authorization": "Bearer "}, 401, "Access token invalid or expired"),
        "просроченный": (
            {"Authorization": f"Bearer {expired_access_token(victim.user_id)}"},
            401,
            "Access token invalid or expired",
        ),
        "токен_типа_refresh": (
            {"Authorization": f"Bearer {refresh_typed_token(victim.user_id)}"},
            401,
            "Not an access token",
        ),
        "чужая_подпись": (
            {"Authorization": f"Bearer {foreign_signed_token(victim.user_id)}"},
            401,
            "Access token invalid or expired",
        ),
        "удалённый_пользователь": (deleted_user_headers, 401, "User not found"),
        "забаненный": (banned_user.headers, 403, "User is banned"),
    }


AUTH_KINDS = [
    "нет_токена",
    "мусор_вместо_jwt",
    "jwt_без_схемы",
    "чужая_схема",
    "пустой_bearer",
    "просроченный",
    "токен_типа_refresh",
    "чужая_подпись",
    "удалённый_пользователь",
    "забаненный",
]


# ═════════════════════════════════════════════════════════════
#  GET /api/guides — список
# ═════════════════════════════════════════════════════════════
class TestСписокГайдов:
    def test_пустой_список_когда_гайдов_нет(self, client, anon):
        """Без гайдов в базе эндпоинт отдаёт 200 и пустой массив."""
        r = client.get(GUIDES_URL, headers=anon)
        assert r.status_code == 200, r.text
        assert r.json() == [], "Ожидался пустой список гайдов"

    def test_форма_элемента_списка(self, client, make_guide, anon):
        """Каждый элемент списка — полноценный GuideOut со всеми полями."""
        g = make_guide(
            title="Как жить",
            owner_block="none",
            text="# Как жить\n\nтекст",
            description="краткое описание",
            original_link="https://example.com/doc",
        )
        r = client.get(GUIDES_URL, headers=anon)
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body, list) and len(body) == 1, "Ожидался ровно один гайд"
        item = body[0]
        assert_guide_out_shape(item)
        assert item == {
            "guide_id": g.guide_id,
            "title": "Как жить",
            "owner_block": "none",
            "text": "# Как жить\n\nтекст",
            "description": "краткое описание",
            "original_link": "https://example.com/doc",
        }, "Тело ответа не совпало с созданным гайдом"

    @pytest.mark.parametrize("owner_block", PUBLIC_OWNER_BLOCKS)
    def test_анонимус_видит_публичные_гайды(self, client, make_guide, anon, owner_block):
        """'', 'none', 'all' — с любым регистром и пробелами — публичны."""
        g = make_guide(title="Публичный", owner_block=owner_block)
        r = client.get(GUIDES_URL, headers=anon)
        assert r.status_code == 200, r.text
        assert ids_of(r) == {g.guide_id}, f"owner_block={owner_block!r} должен быть публичным"

    @pytest.mark.parametrize("owner_block", ["Медиа", " Медиа ", "медиа", "Наука", "nonee", "al", "none1"])
    def test_анонимус_не_видит_блочные_гайды(self, client, make_block, make_guide, anon, owner_block):
        """Любое значение owner_block, кроме публичных, скрывает гайд от анонимуса."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Скрытый", owner_block=owner_block)
        r = client.get(GUIDES_URL, headers=anon)
        assert r.status_code == 200, r.text
        assert ids_of(r) == set(), f"owner_block={owner_block!r} не должен быть виден анонимусу"
        assert db.get_guide(g.guide_id) is not None, "Гайд обязан остаться в базе — он лишь отфильтрован"

    def test_анонимус_видит_только_публичные_из_зоопарка(self, client, zoo, anon):
        """Полная выборка: анонимусу достаются ровно публичные гайды."""
        r = client.get(GUIDES_URL, headers=anon)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"], "Анонимусу видны только публичные гайды"
        assert len(db.list_guides()) == len(zoo["all_ids"]), "В базе должны лежать все гайды"

    def test_обычный_пользователь_без_блоков_видит_только_публичные(self, client, zoo, user):
        """Авторизация без блоков ничего не добавляет к анонимной выдаче."""
        r = client.get(GUIDES_URL, headers=user.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"], "Пользователю без блоков видны только публичные гайды"

    def test_участник_блока_видит_публичные_и_свои(self, client, zoo, make_user_in_block):
        """Участник «Медиа» видит публичные + все гайды «Медиа» (регистр и пробелы игнорируются)."""
        member = make_user_in_block("Медиа")
        r = client.get(GUIDES_URL, headers=member.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"] | zoo["media_ids"], "Участник блока должен видеть гайды своего блока"

    def test_участник_чужого_блока_не_видит_гайды_соседа(self, client, zoo, make_user_in_block):
        """Участник «Наука» не видит ни одного гайда «Медиа»."""
        member = make_user_in_block("Наука")
        r = client.get(GUIDES_URL, headers=member.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"] | zoo["science_ids"], "Чужие блочные гайды не должны попадать в выдачу"
        assert ids_of(r) & zoo["media_ids"] == set(), "Гайды «Медиа» не должны быть видны участнику «Наука»"

    def test_участник_двух_блоков_видит_оба_набора(self, client, zoo, make_user):
        """Членство сразу в двух блоках объединяет обе выборки."""
        member = make_user(blocks="Медиа,Наука")
        assert set(db.get_user_block_names(member.user_id)) == {"Медиа", "Наука"}
        r = client.get(GUIDES_URL, headers=member.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["all_ids"], "Участник обоих блоков видит всё"

    def test_мастер_блока_видит_гайды_своего_блока(self, client, zoo, make_user):
        """Мастер попадает в блок по kkr_name, даже не будучи в arr_of_human."""
        master = make_user(kkr_name="Мастер Медиа", name="Мастер", surname="Медиа")
        r = client.get(GUIDES_URL, headers=master.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"] | zoo["media_ids"], "Мастер видит гайды своего блока"

    def test_hr_блока_видит_гайды_своего_блока(self, client, make_guide, make_hr):
        """HR считается участником блока (database.get_user_block_names)."""
        hr, _block = make_hr(block_name="Медиа", master_name="Мастер Медиа")
        g = make_guide(title="Гайд Медиа", owner_block="Медиа")
        r = client.get(GUIDES_URL, headers=hr.headers)
        assert r.status_code == 200, r.text
        assert g.guide_id in ids_of(r), "HR должен видеть гайды своего блока"

    def test_суперюзер_видит_все_гайды(self, client, zoo, superuser):
        """Суперюзер получает выдачу без какой-либо фильтрации."""
        r = client.get(GUIDES_URL, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["all_ids"], "Суперюзер видит все гайды"

    def test_админ_без_блоков_не_видит_чужие_гайды(self, client, zoo, admin):
        """Флаг admin сам по себе не даёт доступа к блочным гайдам."""
        r = client.get(GUIDES_URL, headers=admin.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"], "admin без блоков приравнивается к обычному пользователю"

    @pytest.mark.parametrize(
        "kind",
        [
            "нет_токена",
            "мусор_вместо_jwt",
            "jwt_без_схемы",
            "чужая_схема",
            "пустой_bearer",
            "просроченный",
            "токен_типа_refresh",
            "чужая_подпись",
            "удалённый_пользователь",
            "забаненный",
        ],
    )
    def test_невалидная_авторизация_деградирует_до_анонимной(self, client, zoo, auth_cases, kind):
        """
        get_current_user_optional глушит любые ошибки токена: список отдаётся как анонимусу,
        200 вместо 401/403.
        """
        headers, _status, _detail = auth_cases[kind]
        r = client.get(GUIDES_URL, headers=headers)
        assert r.status_code == 200, f"{kind}: опциональная авторизация не должна ронять запрос ({r.text})"
        assert ids_of(r) == zoo["public_ids"], f"{kind}: должна отдаваться анонимная выборка"

    def test_забаненный_участник_блока_теряет_доступ_к_блочным_гайдам(self, client, zoo, make_user):
        """Бан низводит участника блока до анонимуса (get_current_user_optional возвращает None)."""
        banned_member = make_user(blocks="Медиа", banned=True)
        r = client.get(GUIDES_URL, headers=banned_member.headers)
        assert r.status_code == 200, r.text
        assert ids_of(r) == zoo["public_ids"], "Забаненный не должен видеть блочные гайды"


# ═════════════════════════════════════════════════════════════
#  GET /api/guides/{guide_id} — один гайд
# ═════════════════════════════════════════════════════════════
class TestЧтениеГайда:
    def test_публичный_гайд_читается_анонимно(self, client, make_guide, anon):
        """Happy path: полное тело GuideOut без авторизации."""
        g = make_guide(
            title="Публичный",
            owner_block="none",
            text="# Публичный\n\nтело",
            description="описание",
            original_link="https://example.com",
        )
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=anon)
        assert r.status_code == 200, r.text
        assert_guide_out_shape(r.json())
        assert r.json() == {
            "guide_id": g.guide_id,
            "title": "Публичный",
            "owner_block": "none",
            "text": "# Публичный\n\nтело",
            "description": "описание",
            "original_link": "https://example.com",
        }

    def test_original_link_может_быть_null(self, client, make_guide, anon):
        """original_link — Optional, отсутствие ссылки отдаётся как null."""
        g = make_guide(title="Без ссылки", owner_block="none", original_link=None)
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=anon)
        assert r.status_code == 200, r.text
        assert r.json()["original_link"] is None, "original_link должен быть null"

    def test_description_по_умолчанию_пустая_строка(self, client, make_guide, anon):
        """description никогда не null — по умолчанию пустая строка."""
        g = make_guide(title="Без описания", owner_block="none", description="")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=anon)
        assert r.status_code == 200, r.text
        assert r.json()["description"] == "", "description по умолчанию — пустая строка"

    @pytest.mark.parametrize("owner_block", PUBLIC_OWNER_BLOCKS)
    def test_публичные_значения_owner_block(self, client, make_guide, anon, owner_block):
        """'', 'none', 'all' в любом регистре и с пробелами дают анонимный доступ."""
        g = make_guide(title="Публичный", owner_block=owner_block)
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=anon)
        assert r.status_code == 200, f"owner_block={owner_block!r} должен быть публичным ({r.text})"
        # database.create_guide (database.py:665) сам подменяет пустую строку на "none";
        # все прочие значения хранятся дословно, без нормализации.
        expected = owner_block if owner_block else "none"
        assert r.json()["owner_block"] == expected, "owner_block отдаётся как есть, без нормализации"

    def test_блочный_гайд_запрещён_анонимусу(self, client, make_block, make_guide, anon):
        """403 Access forbidden — без токена блочный гайд не читается."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=anon)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Access forbidden"

    def test_блочный_гайд_запрещён_чужому_участнику(self, client, make_block, make_guide, make_user_in_block):
        """Участник «Наука» получает 403 на гайд «Медиа»."""
        make_block(name="Медиа", master="Мастер Медиа")
        make_block(name="Наука", master="Мастер Науки")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        stranger = make_user_in_block("Наука")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=stranger.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Access forbidden"

    def test_блочный_гайд_запрещён_обычному_пользователю(self, client, make_block, make_guide, user):
        """Авторизация без нужного блока не помогает."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=user.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Access forbidden"

    def test_блочный_гайд_запрещён_админу_без_блока(self, client, make_block, make_guide, admin):
        """Флаг admin не даёт доступа к чужим блочным гайдам."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=admin.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Access forbidden"

    @pytest.mark.parametrize("owner_block", ["Медиа", " Медиа ", "медиа", "МЕДИА"])
    def test_участник_блока_читает_гайд_в_любом_написании(
        self, client, make_block, make_guide, make_user_in_block, owner_block
    ):
        """Сравнение блока — по strip().lower(), поэтому написание не важно."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Гайд Медиа", owner_block=owner_block)
        member = make_user_in_block("Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=member.headers)
        assert r.status_code == 200, f"owner_block={owner_block!r}: участник должен читать гайд ({r.text})"
        assert r.json()["guide_id"] == g.guide_id

    def test_мастер_читает_гайд_своего_блока(self, client, make_guide, make_master):
        """Мастер — участник блока по определению."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Гайд Медиа", owner_block="Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=master.headers)
        assert r.status_code == 200, r.text

    def test_hr_читает_гайд_своего_блока(self, client, make_guide, make_hr):
        """HR тоже считается участником блока."""
        hr, _block = make_hr(block_name="Медиа", master_name="Мастер Медиа")
        g = make_guide(title="Гайд Медиа", owner_block="Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=hr.headers)
        assert r.status_code == 200, r.text

    def test_суперюзер_читает_любой_блочный_гайд(self, client, make_block, make_guide, superuser):
        """Суперюзер обходит проверку блоков."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Медиа"

    def test_несуществующий_гайд_404(self, client, anon):
        """404 Guide not found — точный текст ошибки."""
        r = client.get(f"{GUIDES_URL}/999999", headers=anon)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Guide not found"

    @pytest.mark.parametrize("guide_id", [0, -1, 2**40])
    def test_невозможные_id_дают_404(self, client, anon, guide_id):
        """Нулевой, отрицательный и запредельный id — это просто «нет такого гайда»."""
        r = client.get(f"{GUIDES_URL}/{guide_id}", headers=anon)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Guide not found"

    @pytest.mark.parametrize("guide_id", ["abc", "1.5", "%20", "null"])
    def test_нечисловой_id_422(self, client, anon, guide_id):
        """Путь типизирован как int — нечисловой id отбивается pydantic'ом."""
        r = client.get(f"{GUIDES_URL}/{guide_id}", headers=anon)
        assert r.status_code == 422, r.text
        assert r.json()["detail"][0]["loc"] == ["path", "guide_id"]

    @pytest.mark.parametrize("kind", AUTH_KINDS)
    def test_невалидный_токен_читает_как_анонимус(self, client, make_guide, auth_cases, kind):
        """Публичный гайд остаётся доступен при любом сломанном токене."""
        g = make_guide(title="Публичный", owner_block="none")
        headers, _status, _detail = auth_cases[kind]
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=headers)
        assert r.status_code == 200, f"{kind}: публичный гайд должен читаться ({r.text})"
        assert r.json()["guide_id"] == g.guide_id

    @pytest.mark.parametrize("kind", AUTH_KINDS)
    def test_невалидный_токен_не_даёт_доступа_к_блочному_гайду(
        self, client, make_block, make_guide, make_user, auth_cases, kind
    ):
        """
        Даже если сломанный токен принадлежит участнику блока, доступа нет:
        битый токен приравнивается к анонимному запросу → 403.
        """
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        headers, _status, _detail = auth_cases[kind]
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=headers)
        assert r.status_code == 403, f"{kind}: блочный гайд не должен открываться ({r.text})"
        assert r.json()["detail"] == "Access forbidden"

    def test_забаненный_участник_блока_получает_403(self, client, make_block, make_guide, make_user):
        """Бан отбирает доступ к блочному гайду, хотя пользователь всё ещё в блоке."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Секрет Медиа", owner_block="Медиа")
        banned_member = make_user(blocks="Медиа", banned=True)
        assert "Медиа" in db.get_user_block_names(banned_member.user_id)
        r = client.get(f"{GUIDES_URL}/{g.guide_id}", headers=banned_member.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Access forbidden"


# ═════════════════════════════════════════════════════════════
#  POST /api/guides — создание
# ═════════════════════════════════════════════════════════════
class TestСозданиеГайда:
    def test_суперюзер_создаёт_гайд_happy_path(self, client, superuser):
        """Полное тело ответа + запись в базе."""
        payload = {
            "title": "Новый гайд",
            "owner_block": "Медиа",
            "text": "# Новый гайд\n\nсодержимое",
            "description": "описание",
            "original_link": "https://example.com/src",
        }
        r = client.post(GUIDES_URL, json=payload, headers=superuser.headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert_guide_out_shape(body)
        assert body["title"] == "Новый гайд"
        assert body["owner_block"] == "Медиа"
        assert body["text"] == "# Новый гайд\n\nсодержимое"
        assert body["description"] == "описание"
        assert body["original_link"] == "https://example.com/src"

        stored = db.get_guide(body["guide_id"])
        assert stored is not None, "Гайд должен появиться в базе"
        assert (stored.title, stored.owner_block, stored.text, stored.description, stored.original_link) == (
            "Новый гайд",
            "Медиа",
            "# Новый гайд\n\nсодержимое",
            "описание",
            "https://example.com/src",
        ), "Запись в базе не совпала с ответом"

    def test_суперюзер_создаёт_гайд_для_несуществующего_блока(self, client, superuser):
        """Существование блока не проверяется — гайд создаётся с любым owner_block."""
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": "Блока-Нет"}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Блока-Нет"
        assert db.get_block("Блока-Нет") is None, "Блок не создавался — проверка отсутствует в коде"

    def test_суперюзер_owner_block_обрезается_по_краям(self, client, superuser):
        """(guide.owner_block or 'none').strip() — пробелы по краям убираются."""
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": "  Медиа  "}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Медиа", "owner_block должен приходить обрезанным"

    @pytest.mark.parametrize("owner_block", ["", "   ", "\t\n", None])
    def test_пустой_owner_block_превращается_в_none(self, client, superuser, owner_block):
        """Пустой/пробельный/отсутствующий owner_block нормализуется в 'none'."""
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": owner_block}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "none", f"owner_block={owner_block!r} должен стать 'none'"
        assert db.get_guide(r.json()["guide_id"]).owner_block == "none"

    def test_owner_block_не_передан_вообще(self, client, superuser):
        """Дефолт схемы GuideIn — 'none'."""
        r = client.post(GUIDES_URL, json={"title": "T"}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "none"

    @pytest.mark.parametrize("text", ["", None])
    def test_пустой_text_заменяется_шаблоном(self, client, superuser, text):
        """Пустой текст → '# {title}\\n\\n'."""
        r = client.post(GUIDES_URL, json={"title": "Заголовок", "text": text}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["text"] == "# Заголовок\n\n", "Должен подставиться markdown-шаблон"
        assert db.get_guide(r.json()["guide_id"]).text == "# Заголовок\n\n"

    def test_text_не_передан_вообще(self, client, superuser):
        """Дефолт GuideIn.text == '' → тоже шаблон."""
        r = client.post(GUIDES_URL, json={"title": "Заголовок"}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["text"] == "# Заголовок\n\n"

    def test_пробельный_text_сохраняется_как_есть(self, client, superuser):
        """' ' — истинное значение, шаблон не подставляется."""
        r = client.post(GUIDES_URL, json={"title": "T", "text": " "}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["text"] == " ", "Пробельный текст не считается пустым"

    @pytest.mark.parametrize("description", ["", None])
    def test_description_по_умолчанию_пустая(self, client, superuser, description):
        """None и '' одинаково дают пустую строку (никогда не null)."""
        r = client.post(GUIDES_URL, json={"title": "T", "description": description}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["description"] == "", "description должен быть пустой строкой"

    def test_original_link_по_умолчанию_null(self, client, superuser):
        """Если ссылку не передали — в ответе null."""
        r = client.post(GUIDES_URL, json={"title": "T"}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["original_link"] is None
        assert db.get_guide(r.json()["guide_id"]).original_link is None

    def test_мастер_создаёт_гайд_в_своём_блоке(self, client, make_master):
        """Мастер блока — второй разрешённый создатель."""
        master, block = make_master(block_name="Медиа")
        r = client.post(GUIDES_URL, json={"title": "Гайд мастера", "owner_block": "Медиа"}, headers=master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == block.name
        assert db.get_guide(r.json()["guide_id"]).owner_block == "Медиа"

    def test_мастер_указал_блок_в_другом_регистре(self, client, make_master):
        """Сопоставление регистронезависимое, а сохраняется каноническое имя блока."""
        master, _block = make_master(block_name="Медиа")
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": "мЕдИа"}, headers=master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Медиа", "Должно сохраниться каноническое имя блока"

    @pytest.mark.parametrize("requested", ["Наука", "", "none", "all", "   ", None])
    def test_мастер_получает_подмену_на_свой_первый_блок(self, client, make_master, make_block, requested):
        """
        ПОВЕДЕНИЕ КОДА (main.py:703-705): любой запрошенный блок, который мастер не ведёт
        — включая 'none'/'all'/пустую строку — МОЛЧА заменяется на его первый мастерский блок.
        Мастер не может создать публичный гайд.
        """
        master, _block = make_master(block_name="Медиа")
        make_block(name="Дизайн", master=master.kkr_name)
        make_block(name="Наука", master="Мастер Науки")
        own_blocks = db.get_user_master_block_names(master.user_id)
        assert set(own_blocks) == {"Медиа", "Дизайн"}, "Мастер должен вести оба блока"

        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": requested}, headers=master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == own_blocks[0], (
            f"owner_block={requested!r} должен молча замениться на первый мастерский блок"
        )
        assert r.json()["owner_block"] not in ("none", "all", ""), "Публичный гайд мастеру создать не дают"

    def test_мастер_может_выбрать_второй_свой_блок(self, client, make_master, make_block):
        """Явно указанный собственный блок не подменяется."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Дизайн", master=master.kkr_name)
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": "Дизайн"}, headers=master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Дизайн"

    @pytest.mark.parametrize("actor_name", ["user", "admin", "hr"])
    def test_создание_запрещено_без_мастерства(self, client, request, make_hr, actor_name):
        """403 для обычного пользователя, «просто админа» и HR блока."""
        if actor_name == "hr":
            actor, _block = make_hr(block_name="Медиа", master_name="Мастер Медиа")
        else:
            actor = request.getfixturevalue(actor_name)
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": "none"}, headers=actor.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Only block masters and superusers can create guides"
        assert db.list_guides() == [], "При отказе гайд не должен создаваться"

    def test_участник_блока_не_может_создавать(self, client, make_block, make_user_in_block):
        """Членство в блоке не равно мастерству."""
        make_block(name="Медиа", master="Мастер Медиа")
        member = make_user_in_block("Медиа")
        r = client.post(GUIDES_URL, json={"title": "T", "owner_block": "Медиа"}, headers=member.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Only block masters and superusers can create guides"
        assert db.list_guides() == []

    @pytest.mark.parametrize("kind", AUTH_KINDS)
    def test_авторизация_обязательна(self, client, auth_cases, kind):
        """Полная матрица отказов аутентификации с точными detail."""
        headers, status, detail = auth_cases[kind]
        r = client.post(GUIDES_URL, json={"title": "T"}, headers=headers)
        assert r.status_code == status, f"{kind}: ожидался {status} ({r.text})"
        assert r.json()["detail"] == detail, f"{kind}: неверный текст ошибки"
        assert db.list_guides() == [], f"{kind}: гайд не должен создаваться"

    def test_отказ_авторизации_приоритетнее_валидации_тела(self, client, anon):
        """Битое тело + отсутствие токена → 401, а не 422."""
        r = client.post(GUIDES_URL, json={"nonsense": 1}, headers=anon)
        assert r.status_code == 401, r.text
        assert r.json()["detail"] == "Not authenticated"

    @pytest.mark.parametrize(
        "payload, loc",
        [
            ({}, ["body", "title"]),
            ({"owner_block": "none"}, ["body", "title"]),
            ({"title": None}, ["body", "title"]),
            ({"title": 123}, ["body", "title"]),
            ({"title": ["a"]}, ["body", "title"]),
            ({"title": {"a": 1}}, ["body", "title"]),
            ({"title": "T", "owner_block": 5}, ["body", "owner_block"]),
            ({"title": "T", "owner_block": []}, ["body", "owner_block"]),
            ({"title": "T", "text": 5}, ["body", "text"]),
            ({"title": "T", "description": []}, ["body", "description"]),
            ({"title": "T", "original_link": {}}, ["body", "original_link"]),
            ({"title": "T", "original_link": 7}, ["body", "original_link"]),
        ],
    )
    def test_валидация_тела_422(self, client, superuser, payload, loc):
        """Отсутствующие и неправильно типизированные поля отбиваются pydantic'ом."""
        r = client.post(GUIDES_URL, json=payload, headers=superuser.headers)
        assert r.status_code == 422, f"{payload} должен быть отвергнут ({r.text})"
        assert [e["loc"] for e in r.json()["detail"]] == [loc], f"Ошибка не там, где ждали: {r.json()['detail']}"
        assert db.list_guides() == [], "При 422 гайд не должен создаваться"

    def test_тело_не_объект_422(self, client, superuser):
        """Список вместо объекта — 422."""
        r = client.post(GUIDES_URL, json=[1, 2, 3], headers=superuser.headers)
        assert r.status_code == 422, r.text
        assert db.list_guides() == []

    def test_лишние_поля_игнорируются(self, client, superuser):
        """GuideIn не запрещает extra — посторонние ключи просто отбрасываются."""
        r = client.post(
            GUIDES_URL,
            json={"title": "T", "guide_id": 4242, "unknown": "мусор"},
            headers=superuser.headers,
        )
        assert r.status_code == 200, r.text
        assert r.json()["guide_id"] != 4242, "guide_id из тела не должен влиять на PK"

    @pytest.mark.parametrize(
        "title",
        [
            "",
            "   ",
            "\t\n ",
            "Гайд с эмодзи 🚀 и юникодом ⚡",
            "Ünïcödé — тире, «кавычки», 中文",
            "A" * 10000,
        ],
    )
    def test_title_без_ограничений(self, client, superuser, title):
        """
        Никаких min_length/max_length: пустая строка, пробелы, эмодзи и 10 000 символов
        проходят и сохраняются дословно.
        """
        r = client.post(GUIDES_URL, json={"title": title, "text": "тело"}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["title"] == title, "title должен сохраниться без изменений"
        assert db.get_guide(r.json()["guide_id"]).title == title

    def test_очень_длинный_текст_сохраняется_целиком(self, client, superuser):
        """100 000 символов текста доходят до базы без обрезки."""
        text = "ы" * 100_000
        r = client.post(GUIDES_URL, json={"title": "T", "text": text}, headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert len(r.json()["text"]) == 100_000
        assert db.get_guide(r.json()["guide_id"]).text == text

    def test_original_link_не_валидируется_как_url(self, client, superuser):
        """Поле объявлено как str — принимается любая строка, не только URL."""
        r = client.post(
            GUIDES_URL,
            json={"title": "T", "original_link": "не ссылка вовсе"},
            headers=superuser.headers,
        )
        assert r.status_code == 200, r.text
        assert r.json()["original_link"] == "не ссылка вовсе"

    def test_повторное_создание_с_тем_же_названием_разрешено(self, client, superuser):
        """Уникальности по title нет — создаются два независимых гайда."""
        first = client.post(GUIDES_URL, json={"title": "Дубль"}, headers=superuser.headers)
        second = client.post(GUIDES_URL, json={"title": "Дубль"}, headers=superuser.headers)
        assert first.status_code == 200 and second.status_code == 200
        assert first.json()["guide_id"] != second.json()["guide_id"], "Должны получиться разные записи"
        assert len(db.list_guides()) == 2

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: права мастера определяются по строке kkr_name (database.py:704-716), "
        "поэтому однофамилец с тем же ККР-именем получает права мастера чужого блока "
        "и может создавать/править/удалять его гайды (main.py:699)",
    )
    def test_однофамилец_мастера_не_должен_получать_права(self, client, make_master, make_user):
        """Совпадение kkr_name не должно давать посторонему пользователю права мастера блока."""
        master, _block = make_master(block_name="Медиа", kkr_name="Иван Иванов")
        twin = make_user(kkr_name="Иван Иванов", email="twin@test.ru")
        assert twin.user_id != master.user_id

        r = client.post(GUIDES_URL, json={"title": "Чужой гайд", "owner_block": "Медиа"}, headers=twin.headers)
        assert r.status_code == 403, "Однофамилец не должен уметь создавать гайды блока"
        assert r.json()["detail"] == "Only block masters and superusers can create guides"


# ═════════════════════════════════════════════════════════════
#  POST | PUT | PATCH /api/guides/{guide_id} — редактирование
# ═════════════════════════════════════════════════════════════
@pytest.mark.parametrize("method", EDIT_METHODS)
class TestРедактированиеГайда:
    """Все три глагола ведут в один обработчик и обязаны вести себя одинаково."""

    def test_суперюзер_меняет_все_поля(self, client, superuser, make_guide, method):
        """Happy path: полное тело GuideOut + запись в базе."""
        g = make_guide(title="Старый", owner_block="none", text="старый текст", description="старое")
        payload = {
            "title": "Новый",
            "owner_block": "Медиа",
            "text": "новый текст",
            "description": "новое описание",
            "original_link": "https://example.com/new",
        }
        r = edit(client, method, g.guide_id, payload, superuser.headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert_guide_out_shape(body)
        assert body == {
            "guide_id": g.guide_id,
            "title": "Новый",
            "owner_block": "Медиа",
            "text": "новый текст",
            "description": "новое описание",
            "original_link": "https://example.com/new",
        }
        stored = db.get_guide(g.guide_id)
        assert (stored.title, stored.owner_block, stored.text, stored.description, stored.original_link) == (
            "Новый",
            "Медиа",
            "новый текст",
            "новое описание",
            "https://example.com/new",
        ), "Изменения должны быть в базе"

    def test_пустое_тело_ничего_не_меняет(self, client, superuser, make_guide, method):
        """{} — валидное тело GuideUpdate: все поля остаются прежними."""
        g = make_guide(title="Старый", owner_block="none", text="текст", description="описание",
                       original_link="https://old")
        r = edit(client, method, g.guide_id, {}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json() == {
            "guide_id": g.guide_id,
            "title": "Старый",
            "owner_block": "none",
            "text": "текст",
            "description": "описание",
            "original_link": "https://old",
        }, "Пустой запрос не должен ничего менять"

    @pytest.mark.parametrize("field, value", [
        ("title", "Только заголовок"),
        ("text", "только текст"),
        ("description", "только описание"),
        ("original_link", "https://only-link"),
        ("owner_block", "Медиа"),
    ])
    def test_отсутствующие_поля_сохраняют_прежние_значения(
        self, client, superuser, make_guide, method, field, value
    ):
        """
        Слияние в стиле PATCH — в том числе для PUT: неуказанные поля НЕ обнуляются
        (main.py:756-763). Для PUT это нарушает семантику «полная замена».
        """
        g = make_guide(
            title="Т", owner_block="none", text="Текст", description="Описание", original_link="https://old"
        )
        r = edit(client, method, g.guide_id, {field: value}, superuser.headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body[field] == value, f"{field} должен обновиться"
        untouched = {
            "title": "Т",
            "owner_block": "none",
            "text": "Текст",
            "description": "Описание",
            "original_link": "https://old",
        }
        for key, expected in untouched.items():
            if key == field:
                continue
            assert body[key] == expected, f"{method}: поле {key} не должно было измениться"

    def test_пустая_строка_затирает_title(self, client, superuser, make_guide, method):
        """Валидации нет: пустой заголовок принимается и сохраняется."""
        g = make_guide(title="Был заголовок", owner_block="none")
        r = edit(client, method, g.guide_id, {"title": ""}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["title"] == "", "Пустой title принимается как есть"
        assert db.get_guide(g.guide_id).title == ""

    def test_пустая_строка_затирает_text_и_description(self, client, superuser, make_guide, method):
        """'' отличается от None и действительно записывается."""
        g = make_guide(title="Т", owner_block="none", text="текст", description="описание")
        r = edit(client, method, g.guide_id, {"text": "", "description": ""}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["text"] == ""
        assert r.json()["description"] == ""
        assert db.get_guide(g.guide_id).text == ""

    @pytest.mark.parametrize("owner_block", ["", "   "])
    def test_суперюзер_обнуляет_owner_block_в_none(self, client, superuser, make_guide, method, owner_block):
        """Пустой/пробельный owner_block превращается в 'none' (main.py:759)."""
        g = make_guide(title="Т", owner_block="Медиа")
        r = edit(client, method, g.guide_id, {"owner_block": owner_block}, superuser.headers)
        assert r.status_code == 200, r.text
        expected = "none" if owner_block == "" else owner_block
        assert r.json()["owner_block"] == expected, (
            "Пустая строка → 'none'; пробельная строка суперюзеру не обрезается"
        )
        assert (r.json()["owner_block"] or "").strip().lower() in ("", "none"), "Гайд должен стать публичным"

    def test_суперюзер_переносит_гайд_в_любой_блок(self, client, superuser, make_guide, method):
        """Суперюзеру доступен произвольный owner_block, включая несуществующий блок."""
        g = make_guide(title="Т", owner_block="none")
        r = edit(client, method, g.guide_id, {"owner_block": "Совершенно Новый Блок"}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Совершенно Новый Блок"
        assert db.get_guide(g.guide_id).owner_block == "Совершенно Новый Блок"

    def test_мастер_редактирует_гайд_своего_блока(self, client, make_master, make_guide, method):
        """Основной разрешённый сценарий для мастера."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Старый", owner_block="Медиа", text="старый")
        r = edit(client, method, g.guide_id, {"title": "Новый", "text": "новый"}, master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["title"] == "Новый"
        assert r.json()["owner_block"] == "Медиа", "Блок не должен измениться"
        assert db.get_guide(g.guide_id).text == "новый"

    @pytest.mark.parametrize("stored_block", ["Медиа", " Медиа ", "медиа", "МЕДИА"])
    def test_мастер_узнаёт_свой_блок_в_любом_написании(
        self, client, make_master, make_guide, method, stored_block
    ):
        """Сравнение блока идёт по strip().lower()."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Т", owner_block=stored_block)
        r = edit(client, method, g.guide_id, {"title": "Новый"}, master.headers)
        assert r.status_code == 200, f"owner_block={stored_block!r} принадлежит мастеру ({r.text})"
        assert r.json()["owner_block"] == stored_block, "Без явного owner_block значение сохраняется дословно"

    def test_мастер_не_редактирует_чужой_блок(self, client, make_master, make_block, make_guide, method):
        """403 с точным текстом; данные в базе не меняются."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Наука", master="Мастер Науки")
        g = make_guide(title="Чужой", owner_block="Наука")
        r = edit(client, method, g.guide_id, {"title": "Взлом"}, master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only edit guides belonging to your own block as a master"
        assert db.get_guide(g.guide_id).title == "Чужой", "Чужой гайд не должен измениться"

    def test_мастер_не_редактирует_публичный_гайд(self, client, make_master, make_guide, method):
        """
        Публичный гайд (owner_block='none') не принадлежит ни одному блоку,
        поэтому мастер получает 403 — в том числе на гайд, который сам же и опубликовал.
        """
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Публичный", owner_block="none")
        r = edit(client, method, g.guide_id, {"title": "Новый"}, master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only edit guides belonging to your own block as a master"
        assert db.get_guide(g.guide_id).title == "Публичный"

    @pytest.mark.parametrize("target", ["none", "None", "NONE", "all", "ALL", "", "   ", " none "])
    def test_мастер_переводит_гайд_в_публичные(self, client, make_master, make_guide, method, target):
        """'none'/'all'/'' в любом виде схлопываются ровно в 'none'."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Т", owner_block="Медиа")
        r = edit(client, method, g.guide_id, {"owner_block": target}, master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "none", f"{target!r} должен превратиться в 'none'"
        assert db.get_guide(g.guide_id).owner_block == "none"

    def test_мастер_теряет_доступ_после_публикации_гайда(self, client, make_master, make_guide, method):
        """
        ЛОВУШКА (main.py:738-739): переведя свой гайд в 'none', мастер больше не может
        его ни редактировать, ни вернуть обратно в блок — гайд становится «сиротой».
        """
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Т", owner_block="Медиа")
        assert edit(client, method, g.guide_id, {"owner_block": "none"}, master.headers).status_code == 200

        r = edit(client, method, g.guide_id, {"owner_block": "Медиа"}, master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only edit guides belonging to your own block as a master"
        assert db.get_guide(g.guide_id).owner_block == "none", "Гайд остался публичным и без хозяина"

    def test_мастер_переносит_гайд_в_другой_свой_блок(self, client, make_master, make_block, make_guide, method):
        """Между собственными блоками переносить можно; сохраняется каноническое имя."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Дизайн", master=master.kkr_name)
        g = make_guide(title="Т", owner_block="Медиа")
        r = edit(client, method, g.guide_id, {"owner_block": "дИзАйН"}, master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Дизайн", "Должно записаться каноническое имя блока"

    def test_мастер_оставляет_свой_блок_и_получает_каноническое_имя(
        self, client, make_master, make_guide, method
    ):
        """Явно указанный текущий блок нормализуется к имени блока (main.py:747-748)."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Т", owner_block=" медиа ")
        r = edit(client, method, g.guide_id, {"owner_block": "МЕДИА"}, master.headers)
        assert r.status_code == 200, r.text
        assert r.json()["owner_block"] == "Медиа", "owner_block должен нормализоваться к имени блока"

    def test_мастер_не_переносит_гайд_в_чужой_блок(self, client, make_master, make_block, make_guide, method):
        """403 с текстом про допустимую видимость; блок в базе не меняется."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Наука", master="Мастер Науки")
        g = make_guide(title="Т", owner_block="Медиа")
        r = edit(client, method, g.guide_id, {"owner_block": "Наука"}, master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only set visibility to 'none' (for all) or your own block"
        assert db.get_guide(g.guide_id).owner_block == "Медиа", "Перенос не должен состояться"

    def test_мастер_не_переносит_гайд_в_несуществующий_блок(self, client, make_master, make_guide, method):
        """Несуществующее имя блока трактуется как чужое → 403."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Т", owner_block="Медиа")
        r = edit(client, method, g.guide_id, {"owner_block": "Блока-Нет"}, master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only set visibility to 'none' (for all) or your own block"

    def test_отказ_переноса_не_сохраняет_остальные_поля(self, client, make_master, make_block, make_guide, method):
        """При 403 не должно примениться ничего, даже разрешённые поля из того же запроса."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Наука", master="Мастер Науки")
        g = make_guide(title="Т", owner_block="Медиа", text="исходный")
        r = edit(
            client, method, g.guide_id,
            {"title": "Переименован", "text": "изменён", "owner_block": "Наука"},
            master.headers,
        )
        assert r.status_code == 403, r.text
        stored = db.get_guide(g.guide_id)
        assert (stored.title, stored.text, stored.owner_block) == ("Т", "исходный", "Медиа"), (
            "Отклонённый запрос не должен оставлять частичных изменений"
        )

    @pytest.mark.parametrize("actor_name", ["user", "admin", "hr", "member"])
    def test_редактирование_запрещено_без_мастерства(
        self, client, request, make_block, make_guide, make_hr, make_user_in_block, method, actor_name
    ):
        """Обычный пользователь, «просто админ», HR и рядовой участник блока — все получают 403."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Гайд Медиа", owner_block="Медиа")
        if actor_name == "hr":
            actor, _b = make_hr(block_name="Дизайн", master_name="Кто-то")
        elif actor_name == "member":
            actor = make_user_in_block("Медиа")
        else:
            actor = request.getfixturevalue(actor_name)

        r = edit(client, method, g.guide_id, {"title": "Взлом"}, actor.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only edit guides belonging to your own block as a master"
        assert db.get_guide(g.guide_id).title == "Гайд Медиа", "Гайд не должен измениться"

    def test_несуществующий_гайд_404(self, client, superuser, method):
        """404 Guide not found даже для суперюзера."""
        r = edit(client, method, 999999, {"title": "Т"}, superuser.headers)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Guide not found"

    def test_несуществующий_гайд_404_раньше_проверки_прав(self, client, user, method):
        """Порядок проверок: сначала существование гайда, потом права (main.py:727-730)."""
        r = edit(client, method, 999999, {"title": "Т"}, user.headers)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Guide not found"

    @pytest.mark.parametrize("guide_id", ["abc", "1,2"])
    def test_нечисловой_id_422(self, client, superuser, method, guide_id):
        """Нечисловой path-параметр отбивается валидацией."""
        r = edit(client, method, guide_id, {"title": "Т"}, superuser.headers)
        assert r.status_code == 422, r.text
        assert r.json()["detail"][0]["loc"] == ["path", "guide_id"]

    @pytest.mark.parametrize("kind", AUTH_KINDS)
    def test_авторизация_обязательна(self, client, make_guide, auth_cases, method, kind):
        """Полная матрица отказов аутентификации."""
        g = make_guide(title="Исходный", owner_block="none")
        headers, status, detail = auth_cases[kind]
        r = edit(client, method, g.guide_id, {"title": "Взлом"}, headers)
        assert r.status_code == status, f"{kind}: ожидался {status} ({r.text})"
        assert r.json()["detail"] == detail, f"{kind}: неверный текст ошибки"
        assert db.get_guide(g.guide_id).title == "Исходный", f"{kind}: гайд не должен измениться"

    @pytest.mark.parametrize(
        "payload, loc",
        [
            ({"title": 1}, ["body", "title"]),
            ({"title": []}, ["body", "title"]),
            ({"owner_block": 1}, ["body", "owner_block"]),
            ({"text": {"a": 1}}, ["body", "text"]),
            ({"description": 3.5}, ["body", "description"]),
            ({"original_link": 7}, ["body", "original_link"]),
        ],
    )
    def test_валидация_тела_422(self, client, superuser, make_guide, method, payload, loc):
        """Неправильные типы в GuideUpdate → 422, гайд не трогается."""
        g = make_guide(title="Исходный", owner_block="none")
        r = edit(client, method, g.guide_id, payload, superuser.headers)
        assert r.status_code == 422, f"{payload} должен быть отвергнут ({r.text})"
        assert [e["loc"] for e in r.json()["detail"]] == [loc]
        assert db.get_guide(g.guide_id).title == "Исходный"

    def test_лишние_поля_игнорируются(self, client, superuser, make_guide, method):
        """guide_id и посторонние ключи в теле не действуют."""
        g = make_guide(title="Исходный", owner_block="none")
        r = edit(client, method, g.guide_id, {"title": "Новый", "guide_id": 424242, "хлам": True}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["guide_id"] == g.guide_id, "guide_id из тела не должен подменять path-параметр"
        assert db.get_guide(424242) is None

    def test_юникод_и_длинные_строки(self, client, superuser, make_guide, method):
        """Эмодзи, юникод и 50 000 символов сохраняются дословно."""
        g = make_guide(title="Т", owner_block="none")
        title = "Гайд 🚀 «кавычки» 中文"
        text = "я" * 50_000
        r = edit(client, method, g.guide_id, {"title": title, "text": text}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["title"] == title
        assert len(r.json()["text"]) == 50_000
        assert db.get_guide(g.guide_id).text == text

    def test_повторное_редактирование_идемпотентно(self, client, superuser, make_guide, method):
        """Два одинаковых запроса дают одинаковый результат."""
        g = make_guide(title="Т", owner_block="none")
        payload = {"title": "Новый", "text": "новый текст"}
        first = edit(client, method, g.guide_id, payload, superuser.headers)
        second = edit(client, method, g.guide_id, payload, superuser.headers)
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json(), "Повтор запроса не должен менять результат"
        assert len(db.list_guides()) == 1, "Редактирование не должно плодить записи"

    @pytest.mark.xfail(
        strict=True,
        reason="БАГ: очистить original_link нельзя — main.py:762 подменяет явный null прежним значением, "
        "а database.update_guide (database.py:862-864) отдельно игнорирует None. "
        "Поле nullable, но API не даёт способа его обнулить",
    )
    def test_original_link_можно_обнулить(self, client, superuser, make_guide, method):
        """Явный null в original_link должен стирать ссылку."""
        g = make_guide(title="Т", owner_block="none", original_link="https://old")
        r = edit(client, method, g.guide_id, {"original_link": None}, superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json()["original_link"] is None, "Явный null должен очищать ссылку"


@pytest.mark.parametrize("method", EDIT_METHODS)
def test_все_три_глагола_дают_одинаковый_результат(client, superuser, make_guide, method):
    """Один и тот же запрос через POST/PUT/PATCH обязан приводить к одному состоянию."""
    g = make_guide(title="Т", owner_block="none", text="исходный", description="d")
    r = edit(client, method, g.guide_id, {"title": "Итог", "text": "итоговый"}, superuser.headers)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "guide_id": g.guide_id,
        "title": "Итог",
        "owner_block": "none",
        "text": "итоговый",
        "description": "d",
        "original_link": None,
    }, f"{method}: результат отличается от эталона"


def test_глаголы_get_и_delete_не_путаются_с_редактированием(client, superuser, make_guide):
    """HEAD/OPTIONS не должны молча редактировать; проверяем, что список разрешённых глаголов ожидаемый."""
    g = make_guide(title="Т", owner_block="none")
    r = client.request("OPTIONS", f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
    assert r.status_code in (200, 405), r.text
    assert db.get_guide(g.guide_id).title == "Т", "OPTIONS не должен ничего менять"


# ═════════════════════════════════════════════════════════════
#  DELETE /api/guides/{guide_id}
# ═════════════════════════════════════════════════════════════
class TestУдалениеГайда:
    def test_суперюзер_удаляет_гайд(self, client, superuser, make_guide):
        """Happy path: тело {'status': 'deleted'} и строка физически исчезает."""
        g = make_guide(title="На удаление", owner_block="none")
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert r.json() == {"status": "deleted"}, "Неожиданное тело ответа"
        assert db.get_guide(g.guide_id) is None, "Гайд должен быть удалён из базы"
        assert db.list_guides() == []

    @pytest.mark.parametrize("owner_block", ["none", "all", "", "Медиа", "Наука"])
    def test_суперюзер_удаляет_любой_гайд(self, client, superuser, make_block, make_guide, owner_block):
        """Суперюзеру доступен любой owner_block."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Т", owner_block=owner_block)
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert db.get_guide(g.guide_id) is None

    @pytest.mark.parametrize("owner_block", ["Медиа", " Медиа ", "медиа", "МЕДИА"])
    def test_мастер_удаляет_гайд_своего_блока(self, client, make_master, make_guide, owner_block):
        """Сопоставление блока — по strip().lower()."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Т", owner_block=owner_block)
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=master.headers)
        assert r.status_code == 200, f"owner_block={owner_block!r} принадлежит мастеру ({r.text})"
        assert r.json() == {"status": "deleted"}
        assert db.get_guide(g.guide_id) is None

    def test_мастер_удаляет_гайд_второго_своего_блока(self, client, make_master, make_block, make_guide):
        """Права мастера распространяются на все его блоки."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Дизайн", master=master.kkr_name)
        g = make_guide(title="Т", owner_block="Дизайн")
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=master.headers)
        assert r.status_code == 200, r.text
        assert db.get_guide(g.guide_id) is None

    def test_мастер_не_удаляет_чужой_гайд(self, client, make_master, make_block, make_guide):
        """403 с точным текстом; строка остаётся в базе."""
        master, _block = make_master(block_name="Медиа")
        make_block(name="Наука", master="Мастер Науки")
        g = make_guide(title="Чужой", owner_block="Наука")
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only delete guides of your own block"
        assert db.get_guide(g.guide_id) is not None, "Чужой гайд должен остаться"

    def test_мастер_не_удаляет_публичный_гайд(self, client, make_master, make_guide):
        """Публичный гайд не принадлежит блоку → мастеру 403."""
        master, _block = make_master(block_name="Медиа")
        g = make_guide(title="Публичный", owner_block="none")
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=master.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only delete guides of your own block"
        assert db.get_guide(g.guide_id) is not None

    @pytest.mark.parametrize("actor_name", ["user", "admin", "hr", "member"])
    def test_удаление_запрещено_без_мастерства(
        self, client, request, make_block, make_guide, make_hr, make_user_in_block, actor_name
    ):
        """Обычный пользователь, админ, HR и участник блока получают 403."""
        make_block(name="Медиа", master="Мастер Медиа")
        g = make_guide(title="Гайд Медиа", owner_block="Медиа")
        if actor_name == "hr":
            actor, _b = make_hr(block_name="Дизайн", master_name="Кто-то")
        elif actor_name == "member":
            actor = make_user_in_block("Медиа")
        else:
            actor = request.getfixturevalue(actor_name)

        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=actor.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "You can only delete guides of your own block"
        assert db.get_guide(g.guide_id) is not None, "Гайд не должен быть удалён"

    def test_несуществующий_гайд_404(self, client, superuser):
        """404 Guide not found."""
        r = client.delete(f"{GUIDES_URL}/999999", headers=superuser.headers)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Guide not found"

    def test_несуществующий_гайд_404_раньше_проверки_прав(self, client, user):
        """Существование проверяется до прав (main.py:771-773)."""
        r = client.delete(f"{GUIDES_URL}/999999", headers=user.headers)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Guide not found"

    def test_повторное_удаление_даёт_404(self, client, superuser, make_guide):
        """Идемпотентность: второй DELETE того же id — 404."""
        g = make_guide(title="Т", owner_block="none")
        first = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
        second = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
        assert first.status_code == 200, first.text
        assert second.status_code == 404, second.text
        assert second.json()["detail"] == "Guide not found"

    @pytest.mark.parametrize("guide_id", ["abc", "1.5"])
    def test_нечисловой_id_422(self, client, superuser, guide_id):
        """Нечисловой path-параметр — 422."""
        r = client.delete(f"{GUIDES_URL}/{guide_id}", headers=superuser.headers)
        assert r.status_code == 422, r.text
        assert r.json()["detail"][0]["loc"] == ["path", "guide_id"]

    @pytest.mark.parametrize("kind", AUTH_KINDS)
    def test_авторизация_обязательна(self, client, make_guide, auth_cases, kind):
        """Полная матрица отказов аутентификации; гайд остаётся на месте."""
        g = make_guide(title="Т", owner_block="none")
        headers, status, detail = auth_cases[kind]
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=headers)
        assert r.status_code == status, f"{kind}: ожидался {status} ({r.text})"
        assert r.json()["detail"] == detail, f"{kind}: неверный текст ошибки"
        assert db.get_guide(g.guide_id) is not None, f"{kind}: гайд не должен быть удалён"

    def test_удаление_не_задевает_соседние_гайды(self, client, superuser, make_guide):
        """Удаляется ровно одна строка."""
        keep_1 = make_guide(title="Останется 1", owner_block="none")
        target = make_guide(title="Удалить", owner_block="none")
        keep_2 = make_guide(title="Останется 2", owner_block="Медиа")
        r = client.delete(f"{GUIDES_URL}/{target.guide_id}", headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert {g.guide_id for g in db.list_guides()} == {keep_1.guide_id, keep_2.guide_id}

    def test_удаление_гайда_не_трогает_блок(self, client, superuser, make_block, make_guide):
        """Удаление гайда не должно менять запись блока."""
        block = make_block(name="Медиа", master="Мастер Медиа", cnt_of_human=0)
        g = make_guide(title="Т", owner_block="Медиа")
        r = client.delete(f"{GUIDES_URL}/{g.guide_id}", headers=superuser.headers)
        assert r.status_code == 200, r.text
        assert db.get_block("Медиа") is not None, "Блок должен остаться"
        assert db.get_block("Медиа").master == block.master


# ═════════════════════════════════════════════════════════════
#  Сквозные сценарии
# ═════════════════════════════════════════════════════════════
def test_полный_жизненный_цикл_гайда_суперюзером(client, superuser, make_block, make_user_in_block):
    """Создание → чтение → правка → смена видимости → удаление, с проверкой видимости на каждом шаге."""
    make_block(name="Медиа", master="Мастер Медиа")
    member = make_user_in_block("Медиа")

    created = client.post(
        GUIDES_URL, json={"title": "Жизненный цикл", "owner_block": "Медиа"}, headers=superuser.headers
    )
    assert created.status_code == 200, created.text
    gid = created.json()["guide_id"]

    assert client.get(f"{GUIDES_URL}/{gid}").status_code == 403, "Пока гайд блочный — анонимусу нельзя"
    assert client.get(f"{GUIDES_URL}/{gid}", headers=member.headers).status_code == 200

    edited = client.patch(f"{GUIDES_URL}/{gid}", json={"description": "готово"}, headers=superuser.headers)
    assert edited.status_code == 200, edited.text
    assert edited.json()["description"] == "готово"

    published = client.put(f"{GUIDES_URL}/{gid}", json={"owner_block": "none"}, headers=superuser.headers)
    assert published.status_code == 200, published.text
    assert client.get(f"{GUIDES_URL}/{gid}").status_code == 200, "После публикации доступен всем"
    assert gid in ids_of(client.get(GUIDES_URL)), "Гайд должен появиться в анонимном списке"

    deleted = client.delete(f"{GUIDES_URL}/{gid}", headers=superuser.headers)
    assert deleted.status_code == 200, deleted.text
    assert db.get_guide(gid) is None
    assert client.get(f"{GUIDES_URL}/{gid}").status_code == 404


def test_полный_цикл_мастера(client, make_master):
    """Мастер создаёт гайд своего блока, правит его и удаляет."""
    master, _block = make_master(block_name="Медиа")

    created = client.post(GUIDES_URL, json={"title": "Гайд мастера"}, headers=master.headers)
    assert created.status_code == 200, created.text
    gid = created.json()["guide_id"]
    assert created.json()["owner_block"] == "Медиа", "Мастеру подставляется его блок"

    edited = client.patch(f"{GUIDES_URL}/{gid}", json={"text": "обновлено"}, headers=master.headers)
    assert edited.status_code == 200, edited.text
    assert db.get_guide(gid).text == "обновлено"

    assert client.delete(f"{GUIDES_URL}/{gid}", headers=master.headers).status_code == 200
    assert db.get_guide(gid) is None
