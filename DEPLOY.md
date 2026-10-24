# Выкладка v1.3 на сервер и откат

Переход рабочего сайта с 6eb9dea на ветку `release-1`. Каждое действие на сервере выполняется только с явного разрешения владельца на этот шаг (AGENTS.md). Секреты, значения `.env`, токены и персональные данные не выводятся. Из отчётов миграции показываются только ID и счётчики.

## 0. Что известно о сервере

- Проект compose — `/home/yulov/profkom_web`, контейнеры `profkom_web-backend-1` и `profkom_web-frontend-1`. Рабочая копия Git стоит на `6eb9dea`, ветка `main`.
- База лежит в `/home/yulov/profkom_web/data`, в контейнере это `/app/data`. Имя файла задаёт `DATABASE_PATH` в `backend/.env`. Ниже оно обозначено `<db>`.
- Порты задают переменные `BACKEND_PORT` и `FRONTEND_PORT` в `.env` рядом с `docker-compose.yml`. Сертификаты лежат в `./certs`.
- Сборка frontend берёт `VITE_*` из `frontend/.env`.

Перед репетицией проверить и записать:
- имя `<db>`;
- версию `docker compose`;
- имена образов (`docker images`);
- `git status` рабочей копии (локальные правки на сервере не должны потеряться);
- что к порту backend не обращаются в обход nginx: новая версия слушает его только на 127.0.0.1. Подсчитать источники запросов в `docker logs profkom_web-backend-1` по подсетям, сами адреса не выводить;
- что на сервере проходит `git fetch` ветки `release-1`.

## 1. Подготовка

1. Ветка `release-1` отправлена в удалённый репозиторий (`git push`).
2. В `backend/.env` должен быть `VK_CLIENT_ID`, равный `VITE_APP_ID` из `frontend/.env`. Без него новый backend не стартует. Значения не печатать, сравнивать так:

   ```sh
   [ "$(grep -h '^VK_CLIENT_ID=' backend/.env | cut -d= -f2)" = "$(grep -h '^VITE_APP_ID=' frontend/.env | cut -d= -f2)" ] && echo match
   ```

3. `APP_ENV=production` задаёт образ backend. `JWT_SECRET_KEY` должен быть не короче 32 символов: при более коротком backend не стартует.

## 2. Репетиция на копии базы

Отдельная папка и отдельный проект compose. Рабочие контейнеры, файлы и база не меняются, наружу ничего не публикуется.

```sh
D=/home/yulov/profkom_web; H=~/profkom-rehearsal; P="docker compose -p profkom-rehearsal"
git clone --branch release-1 <удалённый репозиторий> $H        # или из $D после git fetch
mkdir -p $H/data
# Копия через backup API SQLite из соединения только для чтения: сайт продолжает работать.
python3 -c "import sqlite3, sys; s = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True); s.backup(sqlite3.connect(sys.argv[2]))" $D/data/<db> $H/data/site.db
sha256sum $H/data/site.db
```

Для репетиции в `$H/backend/.env` записываются:
- `APP_ENV=production`;
- новый случайный `JWT_SECRET_KEY`;
- `VK_CLIENT_ID` рабочего сайта;
- `DATABASE_PATH=/app/data/site.db`;
- `S3_BUCKET_NAME` и `S3_ENDPOINT` рабочего бакета без ключей доступа.

Без ключей скрипты распознают старые ссылки, но в хранилище не ходят.

```sh
cd $H && $P build backend
RUN="$P run --rm --no-deps -T --entrypoint python backend"
$RUN scripts/migrate_v13.py --database /app/data/site.db --report /app/data/dry.json
$RUN scripts/mapping_candidate.py --database /app/data/site.db --out /app/data/mapping.json --review /app/data/review.json
# Проверить карту и файл проверки (раздел 4), затем:
$RUN scripts/migrate_v13.py --database /app/data/site.db --apply --mapping /app/data/mapping.json --report /app/data/apply1.json
$RUN scripts/migrate_v13.py --database /app/data/site.db --apply --mapping /app/data/mapping.json --report /app/data/apply2.json
$RUN scripts/repair_storage_links.py --database /app/data/site.db            # потом с --apply
$RUN scripts/adopt_legacy_files.py --database /app/data/site.db              # потом с --apply
$RUN scripts/seal_completed_files.py --database /app/data/site.db --apply     # на базе 6eb9dea: 0 файлов
$P run -d --rm --no-deps --name profkom-rehearsal-api -p 127.0.0.1:18850:8000 backend   # обычный старт: preset_db + uvicorn
until curl -fs -o /dev/null http://127.0.0.1:18850/openapi.json; do sleep 1; done
python3 backend/check_live.py --url http://127.0.0.1:18850 --read-only
docker stop profkom-rehearsal-api
```

Из конфигурации проверить `docker compose config` и `nginx -t` в образе frontend:
- путь к сертификатам `/etc/ssl/certs/ca-certificates.crt`;
- резолвер Docker `127.0.0.11`.

Если `$P run` не подхватывает `./data` из `docker-compose.yml`, добавить `-v $H/data:/app/data`.

Репетиция пройдена, если:
- все команды завершились с кодом 0;
- повторный apply дал тот же `unresolved`;
- `schema` пустой;
- в `unresolved` осталось только принятое (раздел 4);
- `check_live` прошёл.

Время шагов записать: из него складывается окно простоя. Если репетиция не прошла, выкладка переносится (УВ-7). После неё удалить `$H` вместе с копией базы.

## 3. Окно выкладки

```sh
cd /home/yulov/profkom_web
docker compose stop backend frontend
docker compose run --rm --no-deps --entrypoint python backend -c "import sqlite3; sqlite3.connect('/app/data/<db>').backup(sqlite3.connect('/app/data/backup-6eb9dea.db'))"
sha256sum data/<db> data/backup-6eb9dea.db
mkdir -p ~/profkom-backups && cp data/backup-6eb9dea.db ~/profkom-backups/
docker tag profkom_web-backend profkom_web-backend:6eb9dea      # имена образов — из проверки раздела 0
docker tag profkom_web-frontend profkom_web-frontend:6eb9dea
git fetch origin release-1 && git checkout -b release-1 FETCH_HEAD
# backend/.env: добавить VK_CLIENT_ID (раздел 1)
docker compose build
RUN="docker compose run --rm --no-deps --entrypoint python backend"
$RUN scripts/migrate_v13.py --database /app/data/<db> --report /app/data/dry.json
$RUN scripts/mapping_candidate.py --database /app/data/<db> --out /app/data/mapping.json --review /app/data/review.json
# Карта должна совпасть с проверенной на репетиции (сравнить diff). Затем:
$RUN scripts/migrate_v13.py --database /app/data/<db> --apply --mapping /app/data/mapping.json --report /app/data/apply.json
$RUN scripts/repair_storage_links.py --database /app/data/<db> --apply
$RUN scripts/adopt_legacy_files.py --database /app/data/<db> --apply
$RUN scripts/seal_completed_files.py --database /app/data/<db> --apply
docker compose up -d
python3 backend/check_live.py --url https://profcom-cmc.ru --read-only
```

Проверку после запуска делают председатель и владелец:
- вход по паролю и через VK;
- справочник, блоки, материалы и КМБ, ПГАС;
- аватары и файлы открываются.

Отчёты миграции и резервная копия остаются в `data/` и `~/profkom-backups/`.

Бакет переводится в приватный только после этой проверки и отдельным действием. Точную команду и её откат владелец утверждает отдельно. До этого старые публичные ссылки продолжают работать.

## 4. Что проверить в отчёте и карте

- `chair_user_id` — единственный `super_user` (АВ-16). `hr_block_id` — блок HR.
- `vk_identities` — только из файла проверки: ID из сохранённой ссылки старого входа через VK, без общих ID.
- Принятое владельцем для выпуска 1:
  - `unmapped_blocks` — мастеров назначат вручную (УВ-1);
  - `without_documented_participation` — стаж не придумывается (решение 36);
  - `ambiguous_vk_copy` — фото не сбрасываются, если владелец не назвал ID (решение 34);
  - четыре аккаунта без ссылки VK (решение владельца от 2026-10-24).
- Категории: одобренные — `activist`, составы — `member` (решение 36).
- `email_case_groups` и `incomplete_user_ids` на рабочей базе пусты по проверке 2026-10-20; если нет, остановиться и показать владельцу.

## 5. Откат

Решение об откате принимается в окне или сразу после него: всё, что записано на новой версии, при откате пропадает.

```sh
cd /home/yulov/profkom_web
docker compose down
rm -f data/<db>-journal data/<db>-wal data/<db>-shm   # чужой журнал не должен лечь на восстановленную базу
cp ~/profkom-backups/backup-6eb9dea.db data/<db>        # сверить sha256 с записанным
git checkout 6eb9dea                                     # затем при желании git switch main
docker tag profkom_web-backend:6eb9dea profkom_web-backend
docker tag profkom_web-frontend:6eb9dea profkom_web-frontend
docker compose up -d --no-build
```

Если бакет уже стал приватным, сначала вернуть прежнюю политику доступа: старый код отдаёт файлы по публичным ссылкам. `VK_CLIENT_ID` в `backend/.env` старому коду не мешает.
