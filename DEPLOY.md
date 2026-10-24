# Выкладка v1.3 на сервер и откат

Переход рабочего сайта с 6eb9dea на ветку `release-1`. Каждое действие на сервере выполняется только с явного разрешения владельца на этот шаг (AGENTS.md). Секреты, значения `.env`, токены и персональные данные не выводятся. Из отчётов миграции показываются только ID и счётчики.

## 0. Что известно о сервере (проверено 2026-10-24)

- **Проект compose:** `/home/yulov/profkom_web`, контейнеры `profkom_web-backend-1` и `profkom_web-frontend-1`, docker compose 5.3.1. Рабочая копия стоит на `6eb9dea`, ветка `main`. Сеть `profkom_web_default`: 172.19.0.0/16, шлюз 172.19.0.1.
- **Локальные правки рабочей копии, которых нет в git:**
  - в `frontend/nginx.conf` — четыре блока location для Marzban. Это VPN на этом же сервере в сети host, блоки проксируют на шлюз 172.19.0.1. Их пути — секрет, в git они не попадают;
  - в `docker-compose.yml` — сертификаты из `/home/yulov/certs`.
- **Где хранятся местные настройки в новой версии:** `nginx.conf` подключает `nginx-extra/*.conf` (папка вне git), а путь к сертификатам берётся из `CERTS_DIR` в `.env`. Тогда рабочая копия совпадает с git, а выкладки не стирают блоки Marzban.
- **Сеть нельзя пересоздавать:** не выполнять `docker compose down`. Новая сеть может получить другую подсеть, и блоки Marzban перестанут работать. Остановка — только `stop`.
- **Ресурсы:**
  - 1 CPU, 961 МБ памяти; свободно около 400 МБ, swap занят наполовину;
  - на диске свободно 1,6 ГБ, кеш сборки Docker занимает 1,5 ГБ;
  - frontend на сервере не собирается: node не хватает памяти. `dist` собирается на другой машине, образ — по `frontend/Dockerfile.prebuilt`.
- **Образы для отката:**
  - backend работает на `a104a0c10f21` (это `profkom_web-backend:latest`);
  - образ, из которого создан frontend, удалён. Блоки Marzban внесены прямо в контейнер. Образ `78e8aa854a3e` (`profkom_web-frontend:latest`) совпадает с ним по конфигурации nginx и всем 32 файлам сайта, nginx новее на патч-версию.
- **Порт backend 8000 сейчас открыт наружу:** Docker обходит ufw. Новая версия слушает его только на 127.0.0.1.
- **База:** `<db>` в `/home/yulov/profkom_web/data` (`/app/data` в контейнере). Имя файла задаёт `DATABASE_PATH` в `backend/.env`.
- **Тестовый домен:** `test.profcom-cmc.online` ведёт на этот же сервер, порт 80 свободен и открыт в ufw.

## 1. Подготовка

1. **Ветка `release-1` в origin.** Если сервер не может забрать её из origin, код переносится файлом `git bundle` через scp.
2. **`VK_CLIENT_ID` в `backend/.env`.** Он должен совпадать с `VITE_APP_ID` из `frontend/.env`, без него новый backend не стартует. Значения не печатать, сравнивать так:

   ```sh
   [ "$(grep -h '^VK_CLIENT_ID=' backend/.env | cut -d= -f2)" = "$(grep -h '^VITE_APP_ID=' frontend/.env | cut -d= -f2)" ] && echo match
   ```

3. **`JWT_SECRET_KEY`.** `APP_ENV=production` задаёт образ backend. Ключ должен быть не короче 32 символов, иначе backend не стартует.
4. **`dist`.** Собирается на машине разработчика с теми же `VITE_*`, что в `frontend/.env` сервера, и переносится на сервер:

   ```sh
   cd frontend && npm ci && npm run build
   tar czf dist.tgz dist && scp -P 2006 dist.tgz <пользователь>@profcom-cmc.ru:
   ```

## 2. Репетиция на копии базы

Отдельная папка и отдельный проект compose. Рабочие контейнеры, файлы и база только читаются.

```sh
D=/home/yulov/profkom_web; H=/root/profkom-rehearsal; P="docker compose -p profkom-rehearsal"
BUNDLE=/home/<пользователь>/release-1.bundle; DIST=/home/<пользователь>/dist.tgz   # куда скопированы по scp
git clone --branch release-1 $BUNDLE $H          # или из origin
mkdir -p $H/data $H/nginx-extra
# Копия через backup API SQLite из соединения только для чтения: сайт продолжает работать.
python3 -c "import sqlite3, sys; s = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True); s.backup(sqlite3.connect(sys.argv[2]))" $D/data/<db> $H/data/site.db
sha256sum $H/data/site.db
```

Для репетиции в `$H/backend/.env` записываются:
- `APP_ENV=production`;
- новый случайный `JWT_SECRET_KEY`;
- `VK_CLIENT_ID` рабочего сайта;
- `DATABASE_PATH=/app/data/site.db`;
- `S3_ENDPOINT` и `S3_BUCKET_NAME` рабочего бакета, без ключей доступа: скрипты распознают старые ссылки, но в хранилище не ходят.

Блоки Marzban из локальной правки `nginx.conf` переносятся в `$H/nginx-extra/marzban.conf` (раздел 3, шаг 2).

```sh
cd $H && $P build backend
tar xzf $DIST -C frontend && docker build -q -f frontend/Dockerfile.prebuilt -t profkom-rehearsal-frontend frontend
docker run --rm --add-host backend:127.0.0.1 -v /home/yulov/certs:/etc/nginx/ssl:ro -v $H/nginx-extra:/etc/nginx/extra:ro profkom-rehearsal-frontend nginx -t
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

Репетиция пройдена, если:
- все команды завершились с кодом 0;
- повторный apply дал тот же `unresolved`;
- `schema` пустой;
- в `unresolved` осталось только принятое (раздел 4);
- `nginx -t` и `check_live` прошли;
- новый nginx содержит все location рабочего (раздел 3, шаг 2).

Время шагов записать: из него складывается окно простоя. Если репетиция не прошла, выкладка переносится (УВ-7). После неё удалить `$H` вместе с копией базы и образы `profkom-rehearsal-*`.

## 3. Окно выкладки

Шаги 1–4 идут, пока старая версия работает. Сайт стоит только на шагах 5–7.

```sh
D=/home/yulov/profkom_web; B=/home/yulov/profkom-backups; cd $D
BUNDLE=/home/<пользователь>/release-1.bundle; DIST=/home/<пользователь>/dist.tgz
G="git -c safe.directory=*"
# 1. Образы для отката и копии локальных правок.
docker tag a104a0c10f21 profkom_web-backend:6eb9dea
docker tag 78e8aa854a3e profkom_web-frontend:6eb9dea
mkdir -p $B/6eb9dea-local && cp frontend/nginx.conf docker-compose.yml .env $B/6eb9dea-local/
# 2. Блоки Marzban — в nginx-extra: строки, добавленные в nginx.conf после 6eb9dea, без закрывающей скобки сервера.
mkdir -p nginx-extra
python3 - <<'PY'
import difflib, subprocess
old = subprocess.run(["git", "-c", "safe.directory=*", "show", "6eb9dea:frontend/nginx.conf"], capture_output=True, text=True, check=True).stdout.splitlines()
new = open("frontend/nginx.conf").read().splitlines()
added = [l[1:] for l in difflib.unified_diff(old, new, lineterm="", n=0) if l.startswith("+") and not l.startswith("+++")]
while added and added[-1] in ("", "}"):
    added.pop()
open("nginx-extra/marzban.conf", "w").write("\n".join(added) + "\n")
PY
echo "CERTS_DIR=/home/yulov/certs" >> .env
$G checkout HEAD -- frontend/nginx.conf docker-compose.yml  # правка nginx.conf добавлена в индекс; копии — в $B/6eb9dea-local
# 3. Код.
$G fetch $BUNDLE release-1 && $G checkout -b release-1 FETCH_HEAD   # или git fetch origin release-1
# backend/.env: добавить VK_CLIENT_ID (раздел 1)
# 4. Образы.
tar xzf $DIST -C frontend
docker compose build backend
docker build -q -f frontend/Dockerfile.prebuilt -t profkom_web-frontend frontend
# Все location рабочего nginx есть в новом: строк «<» быть не должно, «>» — только /_storage и @storage_failed.
diff <(docker exec profkom_web-frontend-1 nginx -T 2>/dev/null | grep -E '^\s*location' | sort -u) \
     <(docker run --rm --add-host backend:127.0.0.1 -v /home/yulov/certs:/etc/nginx/ssl:ro -v $D/nginx-extra:/etc/nginx/extra:ro profkom_web-frontend nginx -T 2>/dev/null | grep -E '^\s*location' | sort -u)
# 5. Остановка и резервная копия.
docker compose stop backend frontend                        # не down: сеть с шлюзом 172.19.0.1 нужна Marzban
python3 -c "import sqlite3, sys; s = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True); s.backup(sqlite3.connect(sys.argv[2]))" data/<db> $B/backup-6eb9dea.db
sha256sum data/<db> $B/backup-6eb9dea.db
# 6. Миграция.
RUN="docker compose run --rm --no-deps -T --entrypoint python backend"
$RUN scripts/migrate_v13.py --database /app/data/<db> --report /app/data/dry.json
$RUN scripts/mapping_candidate.py --database /app/data/<db> --out /app/data/mapping.json --review /app/data/review.json
# Карта должна совпасть с проверенной на репетиции (сравнить diff). Затем:
$RUN scripts/migrate_v13.py --database /app/data/<db> --apply --mapping /app/data/mapping.json --report /app/data/apply.json
$RUN scripts/repair_storage_links.py --database /app/data/<db> --apply
$RUN scripts/adopt_legacy_files.py --database /app/data/<db> --apply
$RUN scripts/seal_completed_files.py --database /app/data/<db> --apply
# 7. Запуск и проверка.
docker compose up -d --no-build
python3 backend/check_live.py --url https://profcom-cmc.ru --read-only
```

Проверку после запуска делают председатель и владелец:
- вход по паролю и через VK;
- справочник, блоки, материалы и КМБ, ПГАС;
- аватары и файлы открываются;
- VPN работает: подписки Marzban открываются.

Отчёты миграции остаются в `data/`, резервная копия и прежние файлы — в `/home/yulov/profkom-backups`.

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
- `email_case_groups` и `incomplete_user_ids` на рабочей базе пусты по проверке 2026-10-20. Если нет — остановиться и показать владельцу.

## 5. Откат

Решение об откате принимается в окне или сразу после него: всё, что записано на новой версии, при откате пропадает.

```sh
D=/home/yulov/profkom_web; B=/home/yulov/profkom-backups; cd $D
docker compose stop backend frontend                         # не down: сеть с шлюзом 172.19.0.1 нужна Marzban
rm -f data/<db>-journal data/<db>-wal data/<db>-shm          # чужой журнал не должен лечь на восстановленную базу
cp $B/backup-6eb9dea.db data/<db>                             # сверить sha256 с записанным
git -c safe.directory='*' checkout main                       # main = 6eb9dea
cp $B/6eb9dea-local/nginx.conf frontend/nginx.conf
cp $B/6eb9dea-local/docker-compose.yml docker-compose.yml
cp $B/6eb9dea-local/.env .env
docker tag profkom_web-backend:6eb9dea profkom_web-backend
docker tag profkom_web-frontend:6eb9dea profkom_web-frontend
docker compose up -d --no-build
```

Если бакет уже стал приватным, сначала вернуть прежнюю политику доступа: старый код отдаёт файлы по публичным ссылкам. `VK_CLIENT_ID` в `backend/.env` старому коду не мешает.
