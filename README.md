# Сайт профкома ВМК (profkom_web)

> Актуальные изменения объединённого выпуска: [памятка пользователю](docs/USER_GUIDE_20261028.md) и [контракты API](backend/docs/API_V13_ADDITIONS.md). Старые разделы ниже сохраняют контекст предыдущих этапов; актуальные интерфейсы профиля, материалов и истории описаны по этим ссылкам.


Рабочее пространство профкома: аккаунты и заявки, блоки и составы, сезоны, мероприятия и подмероприятия, задачи и проверка результатов, отчёты, сводная и баллы, материалы и гайды, ПГАС. Версия API — 1.3.

| Папка | Что внутри |
| --- | --- |
| `backend/` | FastAPI, SQLAlchemy 2, SQLite. Описание — [backend/README.md](backend/README.md), проверки — [backend/TESTING.md](backend/TESTING.md) |
| `frontend/` | React 19, TypeScript, Vite. Описание — [frontend/README.md](frontend/README.md) |
| `docker-compose.yml` | Два контейнера: `backend` (uvicorn, база в `./data`) и `frontend` (nginx со сборкой, TLS и прокси `/api/`) |
| [DEPLOY.md](DEPLOY.md) | Выкладка на сервер и откат |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Задание и спецификация v1.3 |
| [AGENTS.md](AGENTS.md) | Правила работы с проектом |

## Локальный запуск

Нужны Python 3.12 и Node 24, зависимости ставятся в отдельные окружения.

```sh
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # DATABASE_PATH — отдельный файл для разработки
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
```

```sh
cd frontend
npm ci
cp .env.example .env        # VITE_DEMO_MODE=false — работать с локальным API, а не с демо-данными
npm run dev
```

Пустая база создаёт первого председателя из `ADMIN_NAME` и `ADMIN_PASSWORD` (пароль не короче 12 символов). В базе с аккаунтами председатель назначается только картой миграции по ID — см. [backend/docs/MIGRATION_V13.md](backend/docs/MIGRATION_V13.md).

## Проверки

```sh
cd backend && .venv/bin/python -m pytest          # весь backend
cd frontend && npm run lint && npm run build && npm test -- --run
```

Integration и браузерные проверки frontend идут только против одноразового API из `backend/tests/live_api.py` — порядок в [backend/TESTING.md](backend/TESTING.md). Настоящие VK и S3 в тестах не вызываются.

## Production

- В production (`APP_ENV=production` задаёт образ) backend стартует только с `JWT_SECRET_KEY` не короче 32 символов и с `VK_CLIENT_ID`, равным `VITE_APP_ID` сборки frontend.
- Файлы отдаются через `GET /api/files/{id}/content`: backend проверяет права, nginx забирает байты из хранилища по внутреннему `/_storage`. Ссылки на хранилище до браузера не доходят.
- Порт backend открыт только на 127.0.0.1, снаружи сайт доступен через nginx.
