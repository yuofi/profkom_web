# PF-03, серверная часть: включить HTTP/2 в nginx

Это инструкция для агента, который выполнит PF-03 на сервере владельца, когда получит разрешение. Составлена 2026-10-31 и в тот же день прошла ревью. Каждое утверждение сверено с репозиторием. Патч и тесты перепроверены на временной копии вне репозитория, поведение nginx — на локальном nginx 1.31.8. К серверу и к сайтам никто не подключался.

**Обозначения:**
- `W` = `/Users/aleksmozhuhin/Documents/profkom_web/.local/worktrees/audit-20261031`, ветка `audit/qa-20261031`. Инструкция составлена на `1d70b11`, прошла ревью на `91a3339` и сохранена в репозиторий на `738ba4e` (слияние решений владельца). Файлы, которые меняет патч, между этими коммитами не менялись; в `architecture.md` абзац о gzip сдвинулся со строки 153 на 155. Обновлена 2026-10-31 в ветке `audit/fix-delivery` после PF-12 (gzip JSON-ответов `/api/`) и PF-25 (шрифты): патч пересобран на `2ba93f9`, его строки `+`/`-` не изменились, сдвинулись только контекст и номера строк; ссылки на строки и числа тестов ниже сверены заново.
- `T` = `/Users/aleksmozhuhin/Documents/profkom_web/.local/audit-20261031`.
- `PY` = `/Users/aleksmozhuhin/Documents/profkom_web/.local/env/py312/bin/python`.
- `NODE` = `/Users/aleksmozhuhin/Documents/profkom_web/.local/env/node24/bin/node`.
- `NGX` = `/Users/aleksmozhuhin/Documents/profkom_web/.local/env/nginx/bin/nginx`. Это локальный nginx 1.31.8 (OpenSSL 3.6.5), собранный с `--with-http_v2_module`.
- **STOP** — прекратить и больше ничего не менять. Если на сервере уже что-то изменено, сделать откат по разделу 12. Затем доложить владельцу, что видно и на каком шаге.
- Серверные команды рассчитаны на bash: в них используется `<(...)`.

**Готовые файлы** (проверены 2026-10-31):
- `W/docs/audit/PF-03/pf03-http2.patch` — патч репозитория: nginx.conf и два теста. sha256 `516801c65474052dbe2ef7eed251fc2e14f0b2be638b85040c12695276f55f4f`. `git apply --check` проходит на `2ba93f9` (`audit/fix-delivery`), то есть в W после слияния этой ветки. На `8b98c52` и раньше он не применяется (другой контекст тестов): тогда правки вручную по 3.2.
- `W/docs/audit/PF-03/add_http2.py` — sha256 `e2c00a1a95b1c505d02979dccfc98c5f5a4b88737764b63e7f5cdaeca7a3bc5a`.
  - Добавляет или убирает четыре строки PF-03 сразу после `    listen  443 ssl;`.
  - Если файл не такой, как ожидается, печатает `STOP` и ничего не меняет.
  - Содержимое файла не печатает.
  - Пишет в тот же файл (inode не меняется).
  - Проверено при ревью: add → remove возвращает файл байт в байт; повторный add отказывает; конфигурация 6eb9dea принимается.
  - Текст для вставки на сервере приведён в 6.2.
- `W/docs/audit/PF-03/h2_probe.mjs` — sha256 `a0f23dfdf7f878bc4297d915b188f475ce0dbe564fa024bfd2f24acfc338f150`. Делает холодные загрузки страницы одного сайта и записывает протокол каждого ответа и время. Запросы к другим адресам обрывает. `ignoreHTTPSErrors` включается только для 127.0.0.1 и localhost.

---

## 0. Разрешение владельца — до любого шага на сервере

AGENTS.md:5-19: вне локальной машины ничего не делается без явного одобрения владельца. Общее поручение «сделай PF-03» таким одобрением не является (AGENTS.md:17-19). DEPLOY.md:3 требует разрешения на каждый шаг на сервере.

**Без письменного разрешения можно только локальную часть (раздел 3).** Коммит и в ней делается, только если владелец его просил (3.6).

Разрешение нужно перед любым из этих действий:
- SSH, scp, любая команда на сервере;
- сборка образа и перезапуск;
- любое обращение к рабочему сайту с локальной машины: curl, openssl, браузер, а также DNS-запросы о нём (dig).

В разрешении должны быть названы:
1. **Сервер:** `profcom-cmc.ru`, SSH-порт 2006 (DEPLOY.md:49), пользователь. В выкладке 2026-10-30 это, судя по пути `/home/aleksmozz/…`, был `aleksmozz` (`.local/logs/attachment-layout-deploy-20261030/remote-operation.json:3`). Проект — `/home/yulov/profkom_web`, контейнер — `profkom_web-frontend-1`.
2. **Действия** — по пунктам запроса ниже.
3. **Окно времени.**
   - Путь 1 даёт простой в несколько секунд. На эти секунды пропадают сайт и всё, что nginx проксирует в Marzban: подписки и VPN-подключения через nginx. Открытые соединения рвутся.
   - Пути 2 и 4 обходятся без простоя.
   - Риск для VPN (2.5) одинаковый на всех путях. Поэтому окно выбирается такое, чтобы владелец мог сразу проверить VPN-клиенты.

**Прошлые разрешения не действуют.** Разрешения прошлых выкладок на эту задачу не переносятся. Если шаг не назван в разрешении, остановиться перед ним и спросить.

**Какой DEPLOY.md брать.** В основной рабочей копии `/Users/aleksmozhuhin/Documents/profkom_web` DEPLOY.md сейчас переписывается: правка не закоммичена, прежний текст перенесён в `docs/archive/operations/DEPLOY_20261025.md`. Эту копию не трогать. Инструкция опирается на:
- DEPLOY.md в W;
- правила новой редакции (её строки 32-41): свежий preflight, замена только целевого сервиса, без `docker compose down`, образы и бэкапы не удалять.

**Чего не делать ни на одном пути:**
- Не трогать backend, базу и `data/`.
- Не читать и не выводить `.env` и `backend/.env`.
- Не запускать `docker compose config` без `--images`: эта команда печатает значения из `.env` и `env_file`.
- Не править файлы рабочей копии на сервере, в том числе `frontend/nginx.conf`. В состоянии S-A шаг 2 выкладки v1.3 (DEPLOY.md:140-150) переносит все добавленные в этот файл строки в `nginx-extra/marzban.conf`. Строка `http2 on;` оказалась бы там второй, и nginx новой версии не запустился бы.
- Не выполнять `docker compose down`, `docker pull`, `git pull` и `git fetch`.
- Ничего не удалять: образы, файлы, бэкапы.

**Запрос владельцу** (заполнить):
> Прошу разрешение на PF-03 (HTTP/2 на рабочем сайте) в окно <дата, время MSK>:
> 1. SSH к profcom-cmc.ru (порт 2006, пользователь <…>). sudo — способом, который вы укажете; пароль не выводится. Диагностика по разделу 4 только читает:
>    - git, `docker ps`, `docker inspect`, `docker port`, `docker diff`, `docker logs`;
>    - `nginx -T`, из вывода печатаются только счётчики;
>    - ss;
>    - curl и openssl с сервера на его собственный порт 443.
> 2. Запросы к https://profcom-cmc.ru с моей машины: dig, curl, openssl и headless-браузер без входа, по 5 загрузок `/` и `/auth` до и после. На сервере — `backend/check_live.py --read-only` до и после. Без `--read-only` скрипт регистрирует пользователя в рабочей базе, поэтому так его не запускать.
> 3. Запись на сервере: папка `/home/yulov/profkom-backups/pf03-<время>`. В ней копии конфигурации, скрипт `add_http2.py` и записи.
> 4. Включение по пути <1 | 2 | 4>:
>    - путь 1 (простой несколько секунд):
>      - тег `profkom_web-frontend:before-pf03` на работающий образ;
>      - образ `profkom_web-frontend:pf03` поверх него, в котором заменён один файл — `/etc/nginx/conf.d/default.conf`;
>      - проверка `docker run --rm … nginx -t`;
>      - тег `profkom_web-frontend:latest` на pf03;
>      - пересоздание только контейнера `profkom_web-frontend-1`: `docker compose up -d --no-build --no-deps --force-recreate frontend`;
>    - путь 2 (без простоя): файл `nginx-extra/zz-pf03-http2.conf` и `nginx -s reload`. Файл нужно убрать перед следующей выкладкой, в nginx.conf которой `http2 on;` уже есть;
>    - путь 4 (без простоя): замена `/etc/nginx/conf.d/default.conf` внутри контейнера через `docker cp` и `nginx -s reload`. Действует до пересоздания контейнера.
> 5. Откат по разделу 12 без отдельного вопроса, если сработает критерий.
> 6. От вас:
>    - до и после проверить VPN: обновить подписки Marzban и переподключить каждый клиент;
>    - войти на сайт, открыть задачу и посмотреть в DevTools колонку Protocol.
>
> Отдельным разрешением, если понадобится: повторная проверка через сутки. Скачивание образов, push и перенос кода на сервер для PF-03 не нужны.

Путь 3 сейчас на сервере ничего не делает: он входит в разрешение на выкладку v1.3 (раздел 9).

---

## 1. Что сделать, коротко

- **Конфигурация.** В server-блок `frontend/nginx.conf`, сразу после `listen  443 ssl;`, добавить `http2 on;` с комментарием. Саму строку `listen` не менять. Больше ничего в nginx не трогать.
- **Тесты.** Обновить два теста, которые закрепляют конфигурацию (раздел 3).
- **Сервер.** Порядок такой:
  1. диагностика, только чтение (раздел 4);
  2. выбор пути по её результатам (раздел 5);
  3. замер до включения (раздел 6);
  4. переключение (разделы 7–10);
  5. проверка (раздел 11).

  Откат готов с самого начала (раздел 12).
- **Клиентская часть PF-03 уже сделана** в ветке аудита: `frontend/vite.config.ts:31-34`, `experimentalMinChunkSize: 10_000`, коммит 241de79. В release-1 (12dede0) её нет.

---

## 2. Что известно

### 2.1 Где завершается TLS
- **TLS завершает nginx внутри контейнера frontend.** `frontend/nginx.conf:7`: `listen  443 ssl;`. Сертификаты (`:10-11`) берутся из `/etc/nginx/ssl`.
- **Compose.** `docker-compose.yml:18` публикует `"${FRONTEND_PORT}:443"`. Строка `:21` монтирует сертификаты из `${CERTS_DIR:-./certs}`, строка `:23` — `./nginx-extra` только для чтения.
- **Имя образа.** У сервиса frontend нет ключа `image:`, только `build: ./frontend` (`docker-compose.yml:15`). Compose берёт образ `profkom_web-frontend:latest`; выкладка v1.3 собирает его под этим именем (DEPLOY.md:171).
- **Конфигурация запечена в образ, а не смонтирована:** `frontend/Dockerfile.prebuilt:6` (`COPY nginx.conf /etc/nginx/conf.d/default.conf`). Правка `frontend/nginx.conf` на сервере сама по себе ничего не меняет. Нужен один из трёх вариантов: новый образ, правка внутри контейнера или файл в nginx-extra.
- **nginx-extra подключается внутри server-блока** (`frontend/nginx.conf:15`). Значит, там допустимы директивы уровня server, в том числе `http2 on;` (проверено локально). Отдельный `server {}` там объявить нельзя.
- **Хостового nginx или прокси в репозитории нет.** Marzban — это VPN на том же сервере в сети host. Его блоки в nginx проксируют на шлюз 172.19.0.1 (DEPLOY.md:7, 9). Получается, что nginx контейнера стоит впереди сайта и тех путей Marzban, которые идут через него.
- **DNS.** Записи заведены в Cloudflare (DEPLOY.md:31). Проверка DEPLOY.md:52-57 ждёт, что имя указывает на собственные адреса сервера, — значит, проксирования через Cloudflare нет. Из репозитория это не доказать, проверить в 4.3. Есть известная проблема: 2026-10-24 IPv4-адрес сменился, а запись A осталась прежней (DEPLOY.md:31).
- **`FRONTEND_PORT`** записан в `.env`. Этот файл не читать, порт узнать через `docker port` (4.3).

### 2.2 Версия nginx и синтаксис
- **Версия не закреплена.** `FROM nginx:alpine` (`frontend/Dockerfile:10`, `frontend/Dockerfile.prebuilt:5`). DEPLOY.md:19 говорит только «nginx новее на патч-версию». Значение имеет версия nginx в работающем контейнере: путь 1 строит образ поверх него и версию не меняет. Узнать в 4.2.
- **nginx ≥ 1.25.1:** HTTP/2 включается отдельной директивой `http2 on;`, параметр `listen … http2` устарел. На nginx 1.31.8 `nginx -t` пишет `[warn] the "listen ... http2" directive is deprecated, use the "http2" directive instead` (проверено).
- **nginx < 1.25.1:** `http2 on;` даёт `[emerg] unknown directive "http2"`, и nginx не стартует. В этом случае STOP.
- **Желательна версия ≥ 1.25.3.** В ней улучшено распознавание HTTP/2-клиентов, которые злоупотребляют протоколом; это ответ на атаку rapid reset, CVE-2023-44487. На 1.25.1–1.25.2 доложить владельцу до включения.
- **Вариант `listen 443 ssl http2;` не годится и по другим причинам.** Строку `listen  443 ssl;` (с двумя пробелами) буквально заменяют `backend/tests/test_nginx_delivery.py:110` (проверка в `:118`) и скрипт тестового сайта `.local/scripts/step11/server-stage.sh:181`.
  - С этим вариантом не проходит ни один из 10 тестов nginx: 9 — на `assert old in server`, новый тест PF-03 — на своей проверке устаревшего `listen … http2` (проверено при обновлении: 4 failed, 6 errors в фикстуре `site`).
  - На тестовом сайте sed не найдёт строку, и при следующем `test-up` останется `listen 443 ssl http2;`. Строки `ssl_certificate` тот же sed удаляет, поэтому nginx теста упадёт с `[emerg] no "ssl_certificate" is defined for the "listen ... ssl" directive` (проверено при ревью).
- **Повтор директивы ломает старт.** Если `http2 on;` стоит и в nginx.conf, и в nginx-extra, nginx пишет `[emerg] "http2" directive is duplicate` и не стартует (проверено).
- **Поведение с `http2 on;` на локальном nginx 1.31.8** (проверено):
  - клиент с ALPN `h2,http/1.1` получает `h2`;
  - клиент с ALPN только `http/1.1` получает `http/1.1`;
  - `curl --http1.1` → `HTTP/1.1 200`, `curl --http2` → `HTTP/2 200`.
- **Без `http2 on;`** (проверено при ревью):
  - на предложение `h2,http/1.1` сервер отвечает `ALPN protocol: http/1.1`;
  - клиенту, который предлагает только `h2`, nginx (начиная с 1.21.4) обрывает рукопожатие сигналом `no application protocol` (alert 120). openssl при этом печатает и `No ALPN negotiated`, но соединения нет.
- **Откат через reload работает сразу.** После `nginx -s reload` без `http2 on;` новые соединения снова получают `http/1.1` (проверено при ревью). Браузеры не запоминают, что сервер умел h2.
- **Предпосылки TLS.** Для ALPN нужен OpenSSL ≥ 1.0.2; в nginx:alpine стоит OpenSSL 3. HTTP/2 требует TLS 1.2 или новее и не запрещённых для h2 шифров. Значения nginx по умолчанию подходят. Если в конфигурации заданы свои `ssl_protocols` или `ssl_ciphers`, это видно в 4.1.

### 2.3 Что стоит на проде (последние данные — 2026-10-30)
- **Прод на 2026-10-30 ещё не переведён на v1.3.** Данные из `preflight.json:29,34` выкладки 2026-10-30 (`.local/logs/attachment-layout-deploy-20261030/`):
  - `profkom_web-backend-1` работает на образе `a104a0c10f21…`;
  - `profkom_web-frontend-1` — на `78e8aa854a3e…`.

  Это образы старой версии 6eb9dea из DEPLOY.md:18-19. `REPORT.md:13`: прод-контейнеры не перезапускались.
- **Конфигурация на проде, судя по образу, старая.** Это 6eb9dea с блоками Marzban внутри (DEPLOY.md:9, 19), без `include /etc/nginx/extra` и без `/_storage`.
  - Блоки Marzban, по DEPLOY.md:19, могли быть внесены прямо в контейнер. Это видно в `docker diff` (4.1).
  - Строка `listen  443 ssl;` в 6eb9dea та же, поэтому `add_http2.py` к ней подходит.
  - Что изменилось после 2026-10-30, неизвестно; это определяет 4.1.
- **Выигрыш на старом проде, скорее всего, мал.** В старой сборке всего 32 файла сайта (DEPLOY.md:19). Основной выигрыш ожидается на сборке v1.3 с правками аудита. Там страница задачи и после склейки чанков грузит 21 скрипт на F5 (`T/results/impl_result.json`, PF-03).

### 2.4 Тестовый сайт test.profcom-cmc.online
- **Работает по чистому HTTP на порту 80**, без TLS (DEPLOY.md:249, 252). Контейнер `profkom-test-web-1` публикует `80:80` (`server-stage.sh:196`).
- **Серверная часть PF-03 тестовому сайту ничего не даёт.** Браузеры используют HTTP/2 только поверх TLS, h2c они не поддерживают. Там помогают только склейка чанков из ветки аудита и ускорение backend.
  - Склейка на тест ещё не выложена: тест стоит на 12dede0 (`REPORT.md:3`).
  - Проверка аудита пришла к тому же выводу: `audit_raw.json`, perf-frontend, verify, nginx-no-http2, вердикт `partially`.
- **Строка попадёт на тест только при новом `test-up`, и это безвредно.** Конфигурацию теста генерирует `sed` из `frontend/nginx.conf` при `test-up` (`server-stage.sh:181-184`); `test-update` её не пересоздаёт (`:274-296`). Проверено локально на копии с `http2 on;` (повторно при обновлении — на `2ba93f9` с патчем, где есть и PF-12; sed выполнен perl и Python с одинаковым результатом, GNU sed на этой машине нет):
  - `nginx -t` проходит;
  - HTTP/1.1 и Basic Auth не меняются: 401 без пароля, 200 с паролем;
  - h2c с предварительным знанием не включается, потому что `default_server` на порту 80 (`server-stage.sh:177-179`) работает без http2 (при ревью: `curl --http2-prior-knowledge` не получает ответа, HTTP/1.1 даёт 200).
  - Настоящим GNU sed конфигурация не собиралась: на этой машине его нет, скачивать нельзя. Обе эмуляции дают один и тот же файл байт в байт, при ревью их сверили с правилами GNU sed. Остаток риска ловит сам `test-up`: до `docker compose up` он проверяет созданную конфигурацию `nginx -t` и при ошибке останавливается (`server-stage.sh:205-206`), после запуска печатает коды страницы без пароля и с паролем (`:210`). Ждать 401 и 200.
- **Чтобы тест получил h2, нужен TLS для `test.profcom-cmc.online`:** сертификат и TLS-порт. Порт 443 занят рабочим контейнером, а nginx-extra не может держать отдельный `server {}`. Это отдельное решение владельца, вне PF-03. В этой задаче тестовый сайт не трогать.

### 2.5 Marzban и VPN-транспорты — главный риск
- **Где они могут быть.** В git-конфигурации нет `Upgrade`, `grpc_pass` и `http2` (проверено поиском по `frontend/nginx.conf`). Всё это может встретиться только в блоках Marzban.
- **Почему может сломаться VPN.**
  - С `http2 on;` nginx выбирает h2 для любого клиента, который предлагает h2 в ALPN.
  - WebSocket и HTTPUpgrade через nginx работают только по HTTP/1.1: поверх HTTP/2 nginx их не поддерживает.
  - Значит, VPN-клиент, который ходит через nginx по такому транспорту и при этом предлагает h2, перестанет подключаться. Так бывает, например, при отпечатке браузера в uTLS или при явно заданном ALPN h2.
  - XHTTP/SplitHTTP при h2 может перейти на другой режим передачи и тоже повести себя иначе.
- **Что не пострадает.**
  - Клиенты, которые предлагают только `http/1.1`, работают как раньше (проверено локально). Браузеры для WebSocket предлагают только http/1.1.
  - Подписки Marzban — обычные GET-запросы, они работают и по h2.
  - Клиенты, которые предлагают только h2, сейчас не подключаются совсем (2.2). После включения они подключатся, и это не регрессия.
  - Блоки с `grpc_pass` без HTTP/2 сейчас работать не могут. После включения они заработают; это тоже не регрессия, но изменение.
- **Проверять с переподключением.** После `nginx -s reload` уже открытые соединения доживают на старых процессах nginx по старым правилам. Поломка проявится только при новом подключении. Поэтому каждый клиент проверяется с переподключением.
- **Когда проверять:** до включения (4.4, 6.3) и после (раздел 11).

### 2.6 Как аудит измерял h2 (для воспроизведения)

**nginx-no-http2** (`audit_raw.json`, элемент [2] audit.findings[7]; `T/agents/perf-frontend/findings.json:148`):
- Скрипт `T/agents/perf-frontend/perf2.mjs`, режим `hard`: полная загрузка страницы, сначала холодная (`Network.clearBrowserCache`), потом тёплая.
- Условия: роль chair, задержка 80 мс, 2,5 МБ/с вниз и 1 МБ/с вверх, CPU ×4 (`perf2.mjs:58-60`).
- Маршруты: home, tasks, task, event, blocks, materials, material, merits.
- Метрики:
  - `visual` — последняя мутация DOM;
  - `lastApiEnd` — конец последнего ответа `/api/`;
  - кроме того, `firstApi`, `dcl` и `waves`.
- Серверы: Node TLS из `T/agents/perf-frontend/serve_tls.mjs` с той же политикой кеша и gzip, что была тогда в nginx.conf (до PF-12: API без gzip).
  - `h1` (`https.createServer`) на порту 26444;
  - `h2` (`http2.createSecureServer`, `allowHTTP1`) на порту 26443;
  - оба отдавали одну и ту же сборку, ещё до склейки чанков, с самоподписанным сертификатом из `agents/perf-frontend/nginx/certs`.
- Настоящий nginx 1.31.8 с двумя server-блоками (`agents/perf-frontend/nginx/nginx.conf:16, 21-22`) HTTP/2 отдавал. Под нагрузкой браузера на macOS он падал с ошибками `kevent()`, поэтому сравнение делали на Node (`probes.log:46-48`).

Результаты холодной загрузки (`hard-h1-l80c4.log` и `hard-h2-l80c4.log`, сверены при ревью):

| Маршрут | Метрика | HTTP/1.1, мс | HTTP/2, мс |
|---|---|---|---|
| task | visual | 1480 | 1114 |
| tasks | visual | 1061 | 862 |
| event | visual | 966 | 818 |
| blocks | visual | 845 | 725 |
| materials | visual | 1020 | 881 |
| material | visual | 1007 | 841 |
| merits | lastApiEnd | 1513 | 1201 |
| home | visual | 627 | 675 (без выигрыша) |

Тёплая загрузка почти не меняется: task 584 → 573 мс.

**v-route-chunks-http1** (`audit_raw.json`, элемент [3] verify.missed[1]; скрипт `T/agents/verify-func-tracker/chunks.mjs`):
- Роль org1, клик из `/tasks` в задачу при RTT 150 мс.
- 31 JS/CSS-файл приходит волнами по 6: на 196, 348, 507, 674, 812 и 958 мс.
- `GET /api/tasks/:id` стартует примерно на 1000 мс, карточка видна на 1318 мс. С тёплым кешем — 225 мс.

**После склейки чанков** (`impl_result`, PF-03):
- JS-файлов стало 43 вместо 72.
- У страницы задачи 37 файлов вместо 50.
- Скриптов до показа страницы на F5: у задачи 21 вместо 35, у `/tasks` 7 вместо 17.
- Поэтому сейчас выигрыш от h2, вероятно, меньше 25%. Цифры аудита сняты на сборке до склейки; на текущей сборке их никто не перемерял.
- Единственная точка на текущей сборке — прогон `h2_probe.mjs` на `T/dists/final` через `serve_tls.mjs`: страница `/auth`, 80 мс и CPU ×4, 3 прогона. Медиана до последнего файла — 543 мс по h1 и 491 мс по h2. Вывод этого прогона не сохранён, ревью его не перепроверяло.

---

## 3. Локальная часть (разрешение на сервер не нужно)

### 3.0 Предусловия
Ветку для коммита называет владелец; по умолчанию это `audit/qa-20261031` в W. Основную рабочую копию не трогать. Применять патч, только когда в W нет незавершённого слияния и в индексе пусто:
```sh
cd $W
git rev-parse -q --verify MERGE_HEAD && echo 'STOP: слияние не завершено, ждать оркестратора'
git diff --cached --quiet || echo 'STOP: в индексе чужие изменения'
git status --short     # чужие правки не трогать и не включать (на момент ревью: docs/audit/QA_AUDIT_20261031.md)
```

### 3.1 Применить патч
```sh
git apply --check $W/docs/audit/PF-03/pf03-http2.patch && git apply $W/docs/audit/PF-03/pf03-http2.patch
git diff --stat -- frontend/nginx.conf frontend/scripts/buildAssets.test.ts backend/tests/test_nginx_delivery.py
```
Если `--check` не проходит (ветка ушла вперёд), внести те же правки вручную по 3.2.

### 3.2 Точный diff
Проверено при составлении, при ревью и после обновления (копия `2ba93f9` с патчем): backend-тесты nginx — 10 passed, 0 skipped; buildAssets — 6 passed.
```diff
--- a/frontend/nginx.conf
+++ b/frontend/nginx.conf
@@ -5,6 +5,10 @@
 
 server {
     listen  443 ssl;
+    # HTTP/2 (ALPN h2) multiplexes the route's chunks and API calls in one connection
+    # instead of six at a time (PF-03). nginx >= 1.25.1 syntax; clients that offer only
+    # http/1.1 (WebSocket transports of server-local blocks) keep HTTP/1.1.
+    http2 on;
     server_name  profcom-cmc.ru;
 
     ssl_certificate /etc/nginx/ssl/fullchain.pem;
--- a/frontend/scripts/buildAssets.test.ts
+++ b/frontend/scripts/buildAssets.test.ts
@@ -87,7 +87,11 @@
   // No gzip at the server level: /_storage and the redirects into it inherit none.
   expect(conf.match(/gzip on;/g)).toHaveLength(4);
   expect(own("= /_storage")).not.toMatch(/gzip/);
-  expect(conf).not.toMatch(/http2/);
+  // PF-03: HTTP/2 over TLS with the nginx >= 1.25.1 directive; `listen 443 ssl;` stays as it is
+  // (the backend nginx test and the test-site script replace that exact line).
+  expect(conf).toMatch(/^ {4}http2 on;$/m);
+  expect(conf).toMatch(/^ {4}listen {2}443 ssl;$/m);
+  expect(conf).not.toMatch(/listen[^;]*\bhttp2\b/);
 });
--- a/backend/tests/test_nginx_delivery.py
+++ b/backend/tests/test_nginx_delivery.py
@@ -11,6 +11,7 @@
 import re
 import shutil
 import socket
+import ssl
 import subprocess
@@ -25,6 +26,7 @@
 NGINX = os.environ.get("NGINX_BIN") or shutil.which("nginx")
+OPENSSL = shutil.which("openssl")
 pytestmark = pytest.mark.skipif(not NGINX, reason="nginx is not installed")
@@ -104,12 +106,18 @@
-def nginx_conf(backend_port, port, html, ca, extra):
+def nginx_conf(backend_port, port, html, ca, extra, tls=None):
+    """The repo's server block on loopback; with tls (a folder with cert.pem and key.pem) it
+    keeps `listen ... ssl` and its http2 setting, as on the production host."""
     server = CONF.read_text()
+    listen = (("listen  443 ssl;", f"listen 127.0.0.1:{port} ssl;"),
+              ("/etc/nginx/ssl/fullchain.pem", f"{tls}/cert.pem"),
+              ("/etc/nginx/ssl/privkey.pem", f"{tls}/key.pem")) if tls else (
+              ("listen  443 ssl;", f"listen 127.0.0.1:{port};"),
+              ("    ssl_certificate /etc/nginx/ssl/fullchain.pem;\n", ""),
+              ("    ssl_certificate_key /etc/nginx/ssl/privkey.pem;\n", ""))
     for old, new in (
-        ("listen  443 ssl;", f"listen 127.0.0.1:{port};"),
-        ("    ssl_certificate /etc/nginx/ssl/fullchain.pem;\n", ""),
-        ("    ssl_certificate_key /etc/nginx/ssl/privkey.pem;\n", ""),
+        *listen,
         ("http://backend:8000/api/", f"http://127.0.0.1:{backend_port}/api/"),
@@ (в конец файла)
+def alpn(port, offered):
+    """The protocol nginx picks in the TLS handshake for a client that offers these."""
+    context = ssl.create_default_context()
+    context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
+    context.set_alpn_protocols(offered)
+    with socket.create_connection(("127.0.0.1", port)) as raw, context.wrap_socket(raw) as tls:
+        return tls.selected_alpn_protocol()
+
+
+@pytest.mark.skipif(not OPENSSL, reason="openssl is not installed")
+def test_nginx_offers_http2_over_tls_and_keeps_http1_clients(tmp_path):
+    """PF-03: browsers multiplex a route's chunks over one HTTP/2 connection; a client that
+    offers only http/1.1 (curl --http1.1, WebSocket transports of server-local blocks) keeps
+    HTTP/1.1 on the same port."""
+    import certifi
+
+    conf = CONF.read_text()
+    assert re.search(r"^    http2 on;$", conf, re.M), "http2 on; in the server block"
+    assert not re.search(r"listen[^;]*\bhttp2\b", conf), "listen ... http2 is deprecated since nginx 1.25.1"
+    for name in ("temp", "html", "extra", "tls"):
+        (tmp_path / name).mkdir()
+    (tmp_path / "html/index.html").write_text("<p>SPA</p>")
+    subprocess.run([OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
+                    "-keyout", str(tmp_path / "tls/key.pem"), "-out", str(tmp_path / "tls/cert.pem")],
+                   check=True, capture_output=True)
+    port = free_port()
+    (tmp_path / "nginx.conf").write_text(
+        nginx_conf(free_port(), port, tmp_path / "html", certifi.where(), tmp_path / "extra", tls=tmp_path / "tls"))
+    checked = subprocess.run([NGINX, "-t", "-p", str(tmp_path), "-c", "nginx.conf"], capture_output=True, text=True)
+    assert checked.returncode == 0 and "deprecated" not in checked.stderr, checked.stderr
+    nginx = subprocess.Popen([NGINX, "-p", str(tmp_path), "-c", "nginx.conf", "-g", "daemon off;"],
+                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
+    try:
+        wait_for(port)
+        assert alpn(port, ["h2", "http/1.1"]) == "h2"
+        assert alpn(port, ["http/1.1"]) == "http/1.1"
+        page = httpx.get(f"https://127.0.0.1:{port}/some/page", verify=False)
+        assert page.http_version == "HTTP/1.1" and page.status_code == 200 and page.text == "<p>SPA</p>"
+    finally:
+        nginx.terminate()
+        nginx.wait(10)
```
Это сокращённая запись; точный применяемый текст лежит в `pf03-http2.patch`.

**Почему тесты меняются именно так:**
- **Frontend.** `buildAssets.test.ts:90` сейчас прямо запрещает `http2` (добавлено в 010a1aa). Без правки frontend-набор падает: проверено, 1 из 6 тестов.
- **Старые backend-тесты.** `nginx_conf()` заменяет `listen  443 ssl;` на порт без TLS, а `http2 on;` при этом остаётся. Обычные HTTP/1.1-запросы nginx ≥ 1.25.1 на этом порту обслуживает как раньше, поэтому 9 прежних тестов проходят, в том числе два теста PF-12 о gzip (проверено).
- **Новый тест** поднимает nginx с TLS на сертификате из `openssl req` и проверяет четыре вещи:
  - `nginx -t` проходит без «deprecated»;
  - клиент с `h2,http/1.1` получает ALPN `h2`;
  - клиент только с `http/1.1` получает `http/1.1`;
  - страница по HTTP/1.1 отдаётся с кодом 200.
- **Почему ALPN проверяется через `ssl`.** Пакета `h2` для httpx в окружении нет, а ставить его нельзя. Поэтому ALPN проверяет модуль `ssl` из стандартной библиотеки.

### 3.3 Документация
- **`.agents/skills/profkom-web/references/architecture.md:155` — в коммит PF-03.** В конце абзаца, после фраз «nginx gzips static files … guarded validation/rollback.», добавить: «nginx serves the site over HTTP/2 (`http2 on;`, nginx ≥ 1.25.1); the literal `listen  443 ssl;` line is rewritten by the nginx test and the test-site script, so the protocol is never set on the listen line.»
- **DEPLOY.md ветки — только после включения на сервере** и только с фактическими данными: дата, версия nginx, выбранный путь. Это отдельный коммит, либо тот же, если коммит делается уже после серверного шага. В W пункт идёт в раздел «0. Что известно о сервере».

  В основной рабочей копии DEPLOY.md переписывается, и раздел 0 уходит в архив. При слиянии пункт нужно перенести в новую редакцию, а не в архив. Заготовка (оставить вариант выбранного пути):
  > - **HTTP/2 (PF-03):** с <дата> nginx отдаёт рабочий сайт по HTTP/2 (`http2 on;` в `frontend/nginx.conf`, nginx <версия>), включено путём <1 | 2 | 4>. Строку `listen  443 ssl;` не менять: её заменяют `backend/tests/test_nginx_delivery.py` и скрипт тестового сайта. Клиенты, которые предлагают только http/1.1 (WebSocket-транспорты VPN), остаются на HTTP/1.1. Тестовый сайт работает без TLS, HTTP/2 там не используется.
  > - Путь 1: образ `profkom_web-frontend:latest` на сервере — это прежний образ с заменённым `default.conf`. Выкладка из коммита без PF-03 молча вернёт HTTP/1.1. Откат: `docker tag profkom_web-frontend:before-pf03 profkom_web-frontend:latest`, затем `docker compose up -d --no-build --no-deps --force-recreate frontend`.
  > - Путь 2: в `nginx-extra/zz-pf03-http2.conf` лежит `http2 on;`. Убрать этот файл ДО запуска образа, в nginx.conf которого уже есть `http2 on;`, иначе nginx не стартует из-за дубля. Откат: убрать файл, затем `nginx -t` и `nginx -s reload`.
  > - Путь 4: правка внутри контейнера, при пересоздании контейнера пропадёт. HTTP/2 сохранится, только если выкладка v1.3 несёт коммит PF-03.
- Политику gzip не менять: сжатие JSON-ответов `/api/` (PF-12) уже в ветке, патч его не трогает.

### 3.4 Проверки
```sh
NGINX_BIN=$NGX $PY $T/focus.py $W pytest tests/test_nginx_delivery.py -q -rs   # 10 passed, 0 skipped
$PY $T/focus.py $W vitest scripts/buildAssets.test.ts                          # 6 passed
PROFKOM_REPO=$W $PY $T/check.py frontend
NGINX_BIN=$NGX PROFKOM_REPO=$W $PY $T/check.py backend                         # около 15 минут
```
**Без `NGINX_BIN` все тесты nginx молча пропускаются.** nginx нет в PATH, а `check.py` переменную не задаёт, но и не убирает. В базовом прогоне 2026-10-31 так и было — `7 skipped` (`T/results/baseline-test.txt:12`).

Новому тесту нужен `openssl` в PATH. На этой машине он есть: `/Users/aleksmozhuhin/miniconda3/bin/openssl`.

### 3.5 (По желанию) локальный замер h1 и h2 на текущей сборке
Только на синтетическом стенде. Условия:
- не запускать одновременно с полными наборами тестов, иначе цифры будут неточными;
- порты 15173 и 18000 не занимать;
- перед запуском убедиться, что порты свободны: `lsof -nP -iTCP:<порт> -sTCP:LISTEN`.
```sh
mkdir -p $T/agents/pf03-h2
cd $T && $PY stand.py clone --name pf03-h2 --api-port 28751 --web-port 28752
sed 's#/stands/perf-frontend/#/stands/pf03-h2/#g' $T/agents/perf-frontend/perf2.mjs > $T/agents/pf03-h2/perf2.mjs
cd $T/agents/perf-frontend      # serve_tls.mjs ищет сертификат по относительному пути nginx/certs
$NODE serve_tls.mjs 28753 28751 $T/dists/final h1 > $T/agents/pf03-h2/tls-h1.log 2>&1 &
$NODE serve_tls.mjs 28754 28751 $T/dists/final h2 > $T/agents/pf03-h2/tls-h2.log 2>&1 &
cd $T/agents/pf03-h2; R=home,tasks,task,event,blocks,materials,material,merits
NOROUTE=1 $NODE perf2.mjs https://127.0.0.1:28753 chair hard-h1.json hard 80 4 $R | tee hard-h1.log
NOROUTE=1 $NODE perf2.mjs https://127.0.0.1:28754 chair hard-h2.json hard 80 4 $R | tee hard-h2.log
pkill -f 'serve_tls.mjs 2875[34]'; cd $T && $PY stand.py down --name pf03-h2
```
`NOROUTE=1` обязателен по двум причинам:
- запуск браузера в `perf2.mjs` с этой переменной ставит `ignoreHTTPSErrors` (`perf2.mjs:16-17`), а в `T/browser.mjs` этого нет;
- без неё Playwright отключает HTTP-кеш (`perf2.mjs:11-12`).

Сравнивать строки `cold`. Этот прогон никто не выполнял, ожидаемых чисел на текущей сборке нет.

### 3.6 Коммит
- Коммитить, только если владелец просил коммит.
- Файлы добавлять поимённо, без `git add -A`: в W лежат чужие правки. Перед коммитом проверить индекс:
```sh
git add frontend/nginx.conf frontend/scripts/buildAssets.test.ts backend/tests/test_nginx_delivery.py .agents/skills/profkom-web/references/architecture.md
git diff --cached --name-only    # ровно эти 4 файла; иначе STOP
```
- Сообщение — в стиле репозитория:
```
perf(nginx): serve the site over HTTP/2 (PF-03)

- http2 on; right after listen 443 ssl; (nginx >= 1.25.1 syntax). Clients that
  offer only http/1.1 keep HTTP/1.1 on the same port. The listen line stays
  literal: the nginx test and the test-site script rewrite it.
- The nginx test checks ALPN h2 and http/1.1 over TLS; the static test no longer
  forbids http2.

Audit: PF-03
```
- Push и bundle — только с отдельного разрешения. Путям 1, 2 и 4 коммит на сервере не нужен:
  - в путях 1 и 4 строки вставляет `add_http2.py` в копию конфигурации из контейнера;
  - в пути 2 строка лежит в отдельном файле nginx-extra.

---

## 4. Сервер: диагностика, только чтение

**Правила для всего раздела:**
- Здесь ничего не создаётся и не меняется.
- Docker-команды и `ss -p` выполняются от root, способом из разрешения.
- `.env` и пароли не выводить.
- Вывод `nginx -T` целиком **не печатать**: в нём секретные пути Marzban (DEPLOY.md:9). Печатать только счётчики, как в командах ниже.
- Время каждого шага записывать в UTC.
```sh
D=/home/yulov/profkom_web; B=/home/yulov/profkom-backups; C=profkom_web-frontend-1
G="git -c safe.directory=*"; NT() { docker exec $C nginx -T 2>/dev/null; }
cd $D; date -u +%FT%TZ
```

### 4.1 Состояние кода и контейнеров
```sh
$G rev-parse --short HEAD; $G branch --show-current
$G status --short                                   # только имена файлов
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E '^profkom'
docker inspect -f '{{.Image}} {{.Config.Image}} {{.Created}} {{.State.Status}} restarts={{.RestartCount}}' $C
docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}} {{index .Config.Labels "com.docker.compose.service"}}' $C
                                                    # ожидается: profkom_web /home/yulov/profkom_web frontend
docker image ls profkom_web-frontend --format '{{.Tag}} {{.ID}} {{.CreatedSince}}'
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} {{.Mode}}{{println}}{{end}}' $C
docker diff $C | grep -E '^[ACD] /etc/nginx(/|$)'   # только пути: что меняли внутри контейнера
docker diff $C | grep -cx 'C /etc/nginx/conf.d/default.conf'   # 1 — конфигурацию правили прямо в контейнере
NT | grep -c 'include /etc/nginx/extra'             # S-B: 1, S-A: 0
NT | grep -c 'location = /_storage'                 # S-B: 1, S-A: 0
NT | grep -cE '^\s*server\s*\{'                     # ожидается 1
NT | grep -cE '^\s*listen\s+443\s+ssl;'             # ожидается 1
NT | grep -c 'http2'                                # до включения 0
NT | grep -E '^\s*ssl_(protocols|ciphers)\b'        # ожидается пусто: значения по умолчанию подходят для h2
NT | grep -cE '^\s*access_log\s+off'                # > 0: счётчики по логу (4.4) видят не все запросы
NT | grep '^# configuration file'                   # список файлов; имена не секретны
df -h /; docker system df
```

### 4.2 Версия nginx
```sh
docker exec $C nginx -V 2>&1 | grep -E '^(nginx version|built with)'   # нужен ≥ 1.25.1, желательно ≥ 1.25.3; OpenSSL
docker exec $C nginx -V 2>&1 | grep -c -- '--with-http_v2_module'      # 1
docker image inspect nginx:alpine --format '{{.Id}} {{.Created}}' 2>/dev/null || echo 'nginx:alpine нет в кеше'
```
Для путей 1, 2 и 4 важна только версия в контейнере: путь 1 строит образ поверх работающего и версию nginx не меняет. `nginx:alpine` в кеше записывается для следующей выкладки по `Dockerfile.prebuilt` (раздел 9).

### 4.3 Где TLS и кто слушает 443
На сервере:
```sh
docker port $C                                   # ожидается 443/tcp -> 0.0.0.0:443 (и [::]:443)
HP=$(docker port $C 443/tcp | head -1 | awk -F: '{print $NF}'); echo $HP
ss -ltnpH '( sport = :443 )'                     # docker-proxy → T-1; nginx/haproxy/caddy/xray хоста → T-2
ss -ltnpH '( sport = :80 )'                      # здесь тестовый сайт profkom-test-web-1
curl -V | grep -qw HTTP2 && echo 'curl умеет h2' || echo 'curl без h2: проверять через openssl'
curl -sS -o /dev/null -w '%{http_version} %{http_code}\n' --http2 --resolve profcom-cmc.ru:$HP:127.0.0.1 https://profcom-cmc.ru:$HP/   # до: 1.1 200
openssl s_client -connect 127.0.0.1:$HP -servername profcom-cmc.ru -alpn h2,http/1.1 </dev/null 2>/dev/null | grep -E '^(ALPN protocol|No ALPN negotiated|New,)'   # до: http/1.1
# DNS указывает на этот сервер (DEPLOY.md:52-57): обе строки должны напечатать match
[ "$(getent ahostsv4 profcom-cmc.ru | awk '{print $1; exit}')" = "$(ip -4 -o addr show ens3 | awk '{print $4}' | cut -d/ -f1)" ] && echo match
ip -6 -o addr show ens3 scope global | awk '{print $4}' | cut -d/ -f1 | grep -qxF "$(getent ahostsv6 profcom-cmc.ru | awk '{print $1; exit}')" && echo match
```
Пояснения:
- `ss` ничего не показывает на 443, а `docker port` показывает 443 — значит, у Docker выключен userland-proxy и проброс идёт через iptables. Это тоже случай T-1.
- `docker port` показывает конкретный адрес, а не `0.0.0.0` — подставить его вместо `127.0.0.1`.

С локальной машины (пункт 2 разрешения):
```sh
dig +short profcom-cmc.ru A; dig +short profcom-cmc.ru AAAA
curl -sSI https://profcom-cmc.ru/ | grep -iE '^(server|cf-ray|via|alt-svc):'
```

### 4.4 Marzban и VPN (печатаются только числа)
```sh
docker logs --tail 1 $C 2>/dev/null | awk '{print NF, $8, $9}'   # формат: $8 — протокол вида HTTP/1.1", $9 — трёхзначный статус
NT | grep -ciE 'proxy_set_header\s+upgrade'
NT | grep -ciE '\bgrpc_pass\b'
NT | grep -ciE 'proxy_http_version\s+1\.1'
docker logs --since 72h $C 2>/dev/null | awk '$9==101' | wc -l               # WebSocket/HTTPUpgrade-рукопожатия за 3 дня
docker logs --since 72h $C 2>/dev/null | awk '{print $8}' | sort | uniq -c   # протоколы запросов
docker logs --since 72h $C 2>/dev/null | awk '$9>=500' | wc -l               # фон 5xx
for w in 1h; do                                                            # окно для сравнения после (раздел 11)
  docker logs --since $w $C 2>/dev/null | awk '$9==101' | wc -l
  docker logs --since $w $C 2>/dev/null | awk '$9>=400 && $9<500' | wc -l
  docker logs --since $w $C 2>/dev/null | awk '$9>=500' | wc -l
  docker logs --since $w $C 2>&1 >/dev/null | grep -cE '\[(emerg|alert|crit)\]'
done
```
**Когда счётчики ничего не говорят:**
- `$8`/`$9` в первой строке не похожи на протокол и статус — формат лога другой;
- в 4.1 есть `access_log off`.

В обоих случаях счётчики не доказывают, что VPN работает. Остаётся только проверка владельца.

### 4.5 Что записать
Записать в отчёт:
- время и HEAD с веткой рабочей копии;
- ID образа контейнера, `Config.Image`, метки compose, теги `profkom_web-frontend`, mounts;
- `docker diff` по `/etc/nginx` и счётчики из 4.1;
- `nginx -v`, OpenSSL и модуль v2 контейнера; `nginx:alpine` в кеше;
- вывод `docker port` и `ss`;
- результаты curl и openssl;
- результат DNS-проверки (match или нет) и заголовок `server:`;
- счётчики 4.4.

---

## 5. Таблицы решений

### 5.1 Состояние прода

| Признак | S-A: старая версия 6eb9dea | S-B: v1.3 (release-1 и новее) |
|---|---|---|
| Образ `$C` | `sha256:78e8aa85…` или другой старый | новый |
| `include /etc/nginx/extra` | 0 | 1 |
| `location = /_storage` | 0 | 1 |
| Монтирование `/etc/nginx/extra` | нет | есть, папка `./nginx-extra` |
| `docker diff` по `default.conf` | может быть 1 (блоки Marzban в контейнере) | 0 |
| HEAD рабочей копии | `6eb9dea`, ветка main | коммит release-1 |
| Путь | 3 (по умолчанию) или 4 | 1 (по умолчанию) или 2 |

- Признаки противоречат друг другу → STOP и доклад владельцу.
- `/etc/nginx/conf.d/default.conf` смонтирован с хоста (виден в списке mounts из 4.1) → STOP на любом пути. Монтирование перекрывает файл образа, поэтому путь 1 ничего не изменит. Путь 4 по DEPLOY.md:32 потребовал бы перезапуска.
- S-B, но `docker diff` показывает изменённый `default.conf` → STOP: путь 1 при пересоздании потеряет правки, сделанные внутри контейнера.
- S-A: путь 1 запрещён. Пересоздание контейнера в S-A теряет правки внутри него и запускает compose 6eb9dea — это работа выкладки v1.3. Путь 2 в S-A невозможен: нет ни include, ни монтирования.

### 5.2 Где TLS

| Что видно | Случай | Что делать |
|---|---|---|
| `docker port` показывает 443; на :443 docker-proxy или пусто; DNS — match по обоим адресам; `Server: nginx/<та же версия, что nginx -v>` | T-1: TLS в контейнере | Продолжать |
| :443 держит другой процесс хоста, контейнер опубликован на другом порту | T-2: TLS снаружи контейнера | STOP. HTTP/2 включается там, где завершается TLS, а это вне репозитория. Доложить, что слушает 443, не печатая чужие конфиги |
| `dig` даёт адреса Cloudflare, есть `cf-ray` или `server: cloudflare` | T-3: прокси Cloudflare | STOP. Браузер говорит с Cloudflare, и протокол на этом участке задаёт Cloudflare (HTTP/2 у него включён по умолчанию). `http2 on;` в nginx повлияет только на участок Cloudflare → сервер. Доложить |
| Признаков Cloudflare нет, но DNS по IPv4 или IPv6 не match | Неверная запись DNS | STOP. Известно с 2026-10-24: запись A осталась на прежнем IPv4 (DEPLOY.md:31). Внешние проверки ушли бы на чужой адрес. Доложить; владелец исправляет DNS или разрешает проверки только по совпадающему семейству адресов |

### 5.3 Выбор пути
Путь называет владелец в разрешении. Если названный путь не подходит к состоянию из 5.1, STOP.

| Путь | Когда | Простой | Что остаётся на сервере |
|---|---|---|---|
| 1. Образ поверх работающего (раздел 7) | S-B, по умолчанию | несколько секунд | `latest` = pf03, тег `before-pf03` для отката. Ловушек нет. Выкладка из коммита без PF-03 вернёт HTTP/1.1 |
| 2. Файл в nginx-extra (раздел 8) | S-B, если простой недопустим | нет | Файл `zz-pf03-http2.conf`. **Ловушка:** его надо убрать до запуска образа с PF-03 в nginx.conf, иначе дубль и nginx не стартует |
| 3. Вместе с выкладкой v1.3 (раздел 9) | S-A, по умолчанию | — (окно v1.3) | Ничего сейчас |
| 4. Правка внутри контейнера (раздел 10) | S-A, если нужно до v1.3 | нет | Правка в контейнере до его пересоздания |

---

## 6. Перед включением (пути 1, 2, 4)

### 6.1 Папка для копий
```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ); P=$B/pf03-$STAMP; mkdir -p $P && chmod 700 $P; echo "P=$P"
```
Значение `P` записать: при обрыве SSH переменные пропадут.

### 6.2 Скрипт `add_http2.py` (пути 1 и 4)
Вставить текст как есть:
```sh
cat > $P/add_http2.py <<'PY'
# PF-03: add or remove the HTTP/2 lines right after "    listen  443 ssl;" in an nginx server file.
# Usage: python3 add_http2.py add|remove <file>. Prints only the result, never the file.
import sys
mode, path = sys.argv[1], sys.argv[2]
text = open(path).read()
anchor = "    listen  443 ssl;\n"
block = ("    # HTTP/2 (ALPN h2) multiplexes the route's chunks and API calls in one connection\n"
         "    # instead of six at a time (PF-03). nginx >= 1.25.1 syntax; clients that offer only\n"
         "    # http/1.1 (WebSocket transports of server-local blocks) keep HTTP/1.1.\n"
         "    http2 on;\n")
if mode == "add":
    if text.count(anchor) != 1 or "http2" in text:
        sys.exit("STOP: expected exactly one '    listen  443 ssl;' and no 'http2' in " + path)
    text = text.replace(anchor, anchor + block)
elif mode == "remove":
    if text.count(anchor + block) != 1:
        sys.exit("STOP: the PF-03 lines are not where they were added in " + path)
    text = text.replace(anchor + block, anchor)
else:
    sys.exit("usage: add_http2.py add|remove <file>")
open(path, "w").write(text)
print(mode, "ok:", path)
PY
sha256sum $P/add_http2.py   # e2c00a1a95b1c505d02979dccfc98c5f5a4b88737764b63e7f5cdaeca7a3bc5a, иначе STOP
```
Проверено при ревью: вставка через heredoc даёт ровно этот sha256.

### 6.3 Замер до
- **Сервер:** записи 4.3 и 4.4 уже есть. Дополнительно — `python3 backend/check_live.py --url https://profcom-cmc.ru --read-only`, только с `--read-only`. Записать итог.
- **Локально** (пункт 2 разрешения):
```sh
O=$T/agents/pf03-live; mkdir -p $O
curl -sS -o /dev/null -w '%{http_version} %{http_code}\n' https://profcom-cmc.ru/            # до: 1.1 200
$NODE $W/docs/audit/PF-03/h2_probe.mjs https://profcom-cmc.ru $O/before.json 5 0 1 /,/auth | tee $O/before.log   # doc=http/1.1
```
- **Владелец** до включения:
  - составляет список VPN-клиентов и проверяет, что каждый подключается заново и обновляет подписку;
  - смотрит в DevTools на странице задачи колонку Protocol (`http/1.1`) и время.

---

## 7. Путь 1 — образ поверх работающего (S-B, по умолчанию)

Новый образ — это работающий образ с одним заменённым файлом `/etc/nginx/conf.d/default.conf`. Сборка сайта, `dist`, node и `nginx:alpine` не нужны. Версия nginx не меняется, скачивать ничего не надо.

### 7.1 Предусловия
```sh
CUR=$(docker inspect -f '{{.Image}}' $C); echo $CUR
[ "$(docker image inspect -f '{{.Id}}' profkom_web-frontend:latest)" = "$CUR" ] && echo ok || echo 'STOP: latest не тот образ, что работает'
case "$(docker inspect -f '{{.Config.Image}}' $C)" in profkom_web-frontend|profkom_web-frontend:latest) echo ok;; *) echo STOP;; esac
[ "$(docker diff $C | grep -cx 'C /etc/nginx/conf.d/default.conf')" = 0 ] && echo ok || echo 'STOP: конфигурацию правили в контейнере'
docker image inspect profkom_web-frontend:before-pf03 >/dev/null 2>&1 && echo 'STOP: тег before-pf03 уже есть, спросить'
docker compose config --images                   # только имена образов; ожидается profkom_web-frontend среди них
```

### 7.2 Сборка
```sh
docker tag $CUR profkom_web-frontend:before-pf03
mkdir -p $P/build
docker cp $C:/etc/nginx/conf.d/default.conf $P/default.conf.before
cp $P/default.conf.before $P/build/default.conf
python3 $P/add_http2.py add $P/build/default.conf         # add ok; иначе STOP
diff $P/default.conf.before $P/build/default.conf           # только 4 строки PF-03 с «>»; других отличий нет
printf 'FROM profkom_web-frontend:before-pf03\nCOPY default.conf /etc/nginx/conf.d/default.conf\n' > $P/build/Dockerfile
docker build -q -t profkom_web-frontend:pf03 $P/build      # без --pull
```
Если сборка пытается что-то скачать (`pull access denied`, `failed to resolve source metadata`), это STOP. Pull не делать.

### 7.3 Проверка нового образа до переключения
Проверка идёт с теми же mounts, без публикации портов, как в DEPLOY.md:174:
```sh
CERTS=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/ssl"}}{{.Source}}{{end}}{{end}}' $C)
EXTRA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/extra"}}{{.Source}}{{end}}{{end}}' $C)
RUNT() { docker run --rm --add-host backend:127.0.0.1 -v "$CERTS":/etc/nginx/ssl:ro -v "$EXTRA":/etc/nginx/extra:ro profkom_web-frontend:pf03 nginx "$@"; }
RUNT -t 2>&1 | tail -2                            # syntax is ok / test is successful; без emerg и deprecated
RUNT -v 2>&1                                      # та же версия, что в 4.2
RUNT -T 2>/dev/null | grep -cE '^\s*http2 on;'    # 1
diff <(NT) <(RUNT -T 2>/dev/null) | grep -c '^<'  # 0
diff <(NT) <(RUNT -T 2>/dev/null) | grep -c '^>'  # 4 — только строки PF-03
```
Любое отклонение → STOP. Ничего ещё не переключено, тег `latest` не тронут.

### 7.4 Переключение
```sh
date -u +%FT%TZ                                   # S = время переключения, в отчёт
docker tag profkom_web-frontend:pf03 profkom_web-frontend:latest
docker compose up -d --no-build --no-deps --force-recreate frontend   # только frontend; не down
docker inspect -f '{{.Image}} {{.State.Status}} restarts={{.RestartCount}}' $C
[ "$(docker inspect -f '{{.Image}}' $C)" = "$(docker image inspect -f '{{.Id}}' profkom_web-frontend:pf03)" ] && echo pf03
docker port $C; docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} {{.Mode}}{{println}}{{end}}' $C   # как в 4.1/4.3
```
Если через 30 секунд контейнер не `running`, перезапускается или порты и mounts отличаются от 4.1/4.3 — сразу откат 12.2. Если работа прервалась между `docker tag` и `compose up`, вернуть тег `latest` на `before-pf03` (12.2).

Дальше — раздел 11.

---

## 8. Путь 2 — файл в nginx-extra (S-B, без простоя)

```sh
EXTRA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/extra"}}{{.Source}}{{end}}{{end}}' $C); echo $EXTRA
[ -d "$EXTRA" ] || echo 'STOP: nginx-extra не смонтирован папкой'
ls -1 "$EXTRA"                                     # только имена
[ -e "$EXTRA/zz-pf03-http2.conf" ] && echo 'STOP: файл уже есть'
cat > "$EXTRA/zz-pf03-http2.conf" <<'EOF'
# PF-03: HTTP/2 for profcom-cmc.ru (nginx >= 1.25.1). Remove this file BEFORE starting a frontend
# image whose nginx.conf already has "http2 on;": nginx refuses a duplicate and does not start.
http2 on;
EOF
chmod 644 "$EXTRA/zz-pf03-http2.conf"; cp "$EXTRA/zz-pf03-http2.conf" $P/
docker exec $C nginx -t 2>&1 | tail -2             # ok; при ошибке: mv "$EXTRA/zz-pf03-http2.conf" $P/zz-pf03-http2.conf.failed, STOP
date -u +%FT%TZ                                    # S = время переключения
docker exec $C nginx -s reload
```
Новые файлы в папке nginx-extra видны сразу, поэтому достаточно reload (DEPLOY.md:32). Дальше — раздел 11. Ловушку из 5.3 записать в отчёт и в DEPLOY.md (3.3).

---

## 9. Путь 3 — вместе с выкладкой v1.3 (S-A, по умолчанию)

Сейчас на сервере ничего не делается. HTTP/2 придёт с выкладкой v1.3, если коммит PF-03 будет в выкладываемой ветке; это решает владелец. Шаги для той выкладки, по DEPLOY.md раздела 3:
- **Шаг 2** (`nginx-extra/marzban.conf` из правок рабочей копии):
  - сразу после него `grep -c http2 nginx-extra/marzban.conf` должен дать 0, иначе STOP (будет дубль);
  - рабочую копию `frontend/nginx.conf` до этого шага не править.
- **Шаг 4** (сборка по `Dockerfile.prebuilt` на `nginx:alpine` из кеша): проверка DEPLOY.md:174 с `nginx -T` должна пройти.
  - На `nginx:alpine` < 1.25.1 будет `unknown directive "http2"` → STOP; pull только с отдельного разрешения.
  - Дополнительно: `docker run --rm --add-host backend:127.0.0.1 -v /home/yulov/certs:/etc/nginx/ssl:ro -v $D/nginx-extra:/etc/nginx/extra:ro profkom_web-frontend nginx -T 2>/dev/null | grep -cE '^\s*http2 on;'` → 1.
- **После шага 7** — проверки раздела 11. Владелец проверяет VPN; DEPLOY.md:202 и так это требует.
- **Откат только HTTP/2 после v1.3** — как в разделе 10, но в режиме `remove`: `docker cp` файла из контейнера в `$P`, `add_http2.py remove`, `docker cp` обратно, `nginx -t`, `nginx -s reload`. Строку `http2 off;` добавлять нельзя: рядом с `http2 on;` это дубль. Полный откат v1.3 — по DEPLOY.md раздела 5.

---

## 10. Путь 4 — правка внутри контейнера (S-A, без простоя, временно)

```sh
[ -z "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d/default.conf"}}x{{end}}{{end}}' $C)" ] || echo 'STOP: файл смонтирован'
docker cp $C:/etc/nginx/conf.d/default.conf $P/default.conf.before   # в S-A внутри секретные пути Marzban: файл не печатать
cp $P/default.conf.before $P/default.conf.pf03
python3 $P/add_http2.py add $P/default.conf.pf03            # add ok; иначе STOP
diff $P/default.conf.before $P/default.conf.pf03             # только 4 строки PF-03 с «>»
docker cp $P/default.conf.pf03 $C:/etc/nginx/conf.d/default.conf
docker exec $C nginx -t 2>&1 | tail -2
# при ошибке: docker cp $P/default.conf.before $C:/etc/nginx/conf.d/default.conf; docker exec $C nginx -t; STOP
date -u +%FT%TZ                                              # S = время переключения
docker exec $C nginx -s reload
```
**Сколько живёт правка.** Она переживает `docker restart` и перезагрузку сервера, но пропадает при пересоздании контейнера, в том числе при выкладке v1.3. Записать это в отчёт.

Дальше — раздел 11.

---

## 11. Проверка после включения

Делать сразу (T+0), через 10 минут и через 60 минут. `S` — время переключения в UTC, например `2026-11-01T10:00:00Z`.

**На сервере:**
```sh
cd $D; HP=$(docker port $C 443/tcp | head -1 | awk -F: '{print $NF}')
docker inspect -f '{{.Image}} {{.State.Status}} restarts={{.RestartCount}}' $C    # running, restarts=0
NT | grep -cE '^\s*http2 on;'                                                    # 1
for v in --http2 --http1.1; do curl -sS -o /dev/null -w "$v %{http_version} %{http_code}\n" $v --resolve profcom-cmc.ru:$HP:127.0.0.1 https://profcom-cmc.ru:$HP/; done   # 2 200 и 1.1 200
for a in h2,http/1.1 http/1.1; do printf '%s: ' $a; openssl s_client -connect 127.0.0.1:$HP -servername profcom-cmc.ru -alpn $a </dev/null 2>/dev/null | grep -E '^(ALPN protocol|No ALPN negotiated)'; done   # h2 и http/1.1
python3 backend/check_live.py --url https://profcom-cmc.ru --read-only           # только --read-only; итог как до (6.3)
docker logs --since $S $C 2>/dev/null | awk '{print $8}' | sort | uniq -c       # появляется HTTP/2.0"
docker logs --since $S $C 2>/dev/null | awk '$9==101' | wc -l
docker logs --since $S $C 2>/dev/null | awk '$9>=400 && $9<500' | wc -l
docker logs --since $S $C 2>/dev/null | awk '$9>=500' | wc -l
docker logs --since $S $C 2>&1 >/dev/null | grep -cE '\[(emerg|alert|crit)\]'   # 0
```
Если curl на сервере без h2 (4.3), строку `--http2` пропустить и опираться на openssl. Счётчики сравнивать с окном той же длины из 4.4. На пути 1 логи нового контейнера начинаются с момента пересоздания.

**Локально:**
```sh
curl -sS -o /dev/null -w '%{http_version} %{http_code}\n' https://profcom-cmc.ru/            # 2 200
curl -sS -o /dev/null -w '%{http_version} %{http_code}\n' --http1.1 https://profcom-cmc.ru/  # 1.1 200
$NODE $W/docs/audit/PF-03/h2_probe.mjs https://profcom-cmc.ru $O/after.json 5 0 1 /,/auth | tee $O/after.log   # doc=h2, все ответы h2
```
На `/auth` выигрыш будет небольшим (2.3). Главный критерий — ничего не сломалось.

**Владелец:**
- каждый VPN-клиент из списка 6.3 переподключить, подписки обновить;
- войти на сайт; на странице задачи колонка Protocol должна показывать `h2`;
- вход, файлы и аватары открываются.

---

## 12. Откат

### 12.1 Когда (без отдельного вопроса, пункт 5 разрешения)
Достаточно любого из признаков:
- VPN-клиент, который работал в проверке 6.3, после переподключения не подключается, или подписка Marzban не обновляется;
- сайт не открывается, вход сломан, `check_live --read-only` проваливается, хотя до включения проходил;
- 4xx или 5xx заметно выше фона за окно той же длины;
- 101 за 60 минут — 0, хотя в 4.4 они шли регулярно;
- контейнер не `running` или перезапускается;
- `nginx -t` с ошибкой, в логе ошибок есть `[emerg]`, `[alert]` или `[crit]`;
- владелец просит откатить.

### 12.2 Как
- **Путь 1** (простой несколько секунд):
```sh
docker tag profkom_web-frontend:before-pf03 profkom_web-frontend:latest
docker compose up -d --no-build --no-deps --force-recreate frontend
[ "$(docker inspect -f '{{.Image}}' $C)" = "$(docker image inspect -f '{{.Id}}' profkom_web-frontend:before-pf03)" ] && echo 'rolled back'
```
  Если остановились между `docker tag … latest` и `compose up` (7.4), достаточно первой строки: контейнер ещё на прежнем образе.
- **Путь 2** (без простоя):
```sh
mv "$EXTRA/zz-pf03-http2.conf" $P/zz-pf03-http2.conf.removed
docker exec $C nginx -t && docker exec $C nginx -s reload
```
- **Путь 4** (без простоя):
```sh
docker cp $P/default.conf.before $C:/etc/nginx/conf.d/default.conf
docker exec $C nginx -t && docker exec $C nginx -s reload
```
- **Путь 3** — раздел 9.

### 12.3 После отката
- Повторить раздел 11 с обратными ожиданиями:
  - `NT | grep -c http2` → 0;
  - ALPN `http/1.1`;
  - `curl --http2` → `1.1 200`.
- Владелец переподключает VPN-клиенты.
- Ничего не удалять: образы `before-pf03` и `pf03`, папку `$P`, убранный файл nginx-extra.
- Доложить владельцу, что сработало.

---

## 13. После: отчёт, документация, следующие выкладки

- **Отчёт владельцу:**
  - состояние (S-A или S-B, T-1), путь, время переключения;
  - версия nginx;
  - числа до и после: протоколы, медианы `h2_probe`, счётчики 4.4 и раздела 11;
  - результат проверки VPN, был ли откат, путь `$P`.

  Локальные файлы — в `T/agents/pf03-live/`. Секретов, путей Marzban и строк логов с адресами в отчёте нет.
- **Документация:** пункт DEPLOY.md по 3.3 с фактическими данными.
- **Что остаётся для следующих выкладок:**
  - путь 1: следующая выкладка из коммита без PF-03 вернёт HTTP/1.1;
  - путь 2: перед выкладкой образа с PF-03 в nginx.conf убрать `nginx-extra/zz-pf03-http2.conf`;
  - путь 4: правка пропадёт при пересоздании контейнера, HTTP/2 сохранится только с коммитом PF-03 в выкладке v1.3.
- **Повторная проверка через сутки** (раздел 11 и VPN) — только с отдельного разрешения.
