# Тестирование бэкенда Профком ВМК

Два независимых инструмента:

| | что делает | когда нужен |
|---|---|---|
| **`./run_tests.sh`** | Полный набор pytest-тестов на временной базе, без сети | перед коммитом, в CI, после правок кода |
| **`python3 check_live.py`** | Проверяет **запущенный** сервер по HTTP | после деплоя, при отладке прода, чтобы убедиться «сайт живой» |

Ни один из них не трогает `data/profcom.db`.

---

## 1. Набор тестов (`run_tests.sh`)

```bash
./run_tests.sh
```

Скрипт сам создаст `.venv`, если его нет, доставит `pytest` и `httpx` и прогонит всё.

Тесты поднимают приложение **внутри процесса** через `TestClient` — сервер запускать не нужно. Каждый тест стартует с пустой временной базы SQLite (`$TMPDIR/profkom_test_*.db`), которая удаляется после прогона. S3 и VK API замоканы и никогда не вызываются по-настоящему.

### Частые команды

```bash
./run_tests.sh -k guides
```

```bash
./run_tests.sh tests/test_auth_tokens.py -v
```

```bash
./run_tests.sh --cov
```

Последняя команда положит HTML-отчёт о покрытии в `htmlcov/index.html`.

### Как устроено

```
tests/
  conftest.py              фикстуры: клиент, пользователи, роли, моки S3 и VK
  test_auth_register.py    POST /api/auth/register
  test_auth_login.py       POST /api/auth/login, /api/auth/change-password
  test_auth_tokens.py      refresh, logout, logout-all, семантика access-токена
  test_auth_vk.py          POST /api/auth/vk
  test_profile.py          /api/profile/me и /api/profile/{id} (GET/PATCH/DELETE)
  test_guides.py           гайды: список, чтение, создание, правка, удаление
  test_blocks.py           блоки: CRUD + вход/выход
  test_contacts.py         /api/contacts и /api/contacts/filter
  test_upload.py           /api/upload/presigned-url
  test_api_contract.py     карта маршрутов, матрица прав, CORS, OpenAPI
```

`conftest.py` подменяет `DATABASE_PATH` **до** импорта приложения и падает с понятной ошибкой, если подключение всё-таки ушло не на временную базу. Это защита от того, чтобы прогон тестов не стёр боевые данные.

### Основные фикстуры

```python
def test_пример(client, make_user, superuser, make_block, make_guide):
    u = make_user(name="Иван", surname="Петров", admin=True)
    r = client.get("/api/profile/me", headers=u.headers)
    assert r.status_code == 200
```

- `client` — `TestClient` поверх настоящего приложения
- `make_user(**kw)` — пользователь с любыми флагами (`admin`, `super_user`, `banned`, `password=None` для VK-аккаунта); возвращает `Actor` с готовым `.headers`
- `user`, `admin`, `superuser`, `banned_user` — готовые роли
- `make_block`, `make_master`, `make_hr`, `make_guide` — доменные объекты
- `mock_s3` — включён всегда, пишет вызовы в `mock_s3["presigned"]` и `mock_s3["upload"]`
- `mock_vk(...)` — настраиваемый ответ VK
- `expired_access_token`, `refresh_typed_token`, `foreign_signed_token`, `expired_refresh_token` — заведомо негодные токены

### Про `xfail`

Часть тестов помечена так:

```python
@pytest.mark.xfail(strict=True, reason="БАГ: ...")
```

Это тесты, которые проверяют **правильное** поведение там, где бэкенд сейчас ведёт себя неправильно. Набор остаётся зелёным, но как только баг починят, тест начнёт «неожиданно проходить» и pytest об этом сообщит (`strict=True`) — маркер надо будет снять. Так известные дефекты не забываются.

---

## 2. Проверка живого сервера (`check_live.py`)

Отдельный процесс без зависимостей — только стандартная библиотека Python 3.9+. Ни pytest, ни venv не нужны.

```bash
python3 check_live.py
```

По умолчанию идёт на `http://127.0.0.1:8000`.

```bash
python3 check_live.py --url https://profkom.example.ru --read-only
```

### Режимы

| ключ | смысл |
|---|---|
| `--url` | адрес сервера (или переменная окружения `PROFKOM_API`) |
| `--read-only` | ничего не создавать и не менять — только чтение |
| `--email` / `--password` | войти существующей учёткой вместо регистрации временной |
| `--insecure` | не проверять TLS-сертификат (самоподписанный на стенде) |
| `--timeout` | таймаут запроса, по умолчанию 15 с |

**Важно.** Без `--read-only` и без `--email` скрипт **регистрирует временного пользователя** `healthcheck_*@example.com`, чтобы проверить защищённые маршруты. На боевом сервере запускайте либо с `--read-only`, либо с учёткой существующего пользователя.

Код возврата `0` — всё прошло, `1` — есть провалы, поэтому скрипт годится для мониторинга и CI:

```bash
python3 check_live.py --url https://profkom.example.ru --read-only || echo "бэкенд сломан"
```

### Что проверяет

Публичная часть: схема OpenAPI отдаётся, список блоков и гайдов приходит в правильной форме, аноним **не** видит гайды закрытых блоков, несуществующий путь даёт 404, защищённый маршрут без токена даёт 401, CORS не отражает произвольный `Origin`, справочник контактов не открыт всему миру.

Авторизация: регистрация, повторная регистрация даёт 409, валидация группы и телеграма даёт 422, вход с неверным паролем и с неизвестным email даёт 401.

Защищённая часть: профиль, ротация refresh-токена и отзыв старого, чтение гайдов, правка своего профиля, и главное — что обычному пользователю **отказано** в создании гайдов, создании блоков, фильтре контактов, удалении и правке чужого профиля, загрузке в папку `guides`.

---

## Запуск обоих разом

```bash
./run_tests.sh && ./run_tests.sh --live --read-only
```
