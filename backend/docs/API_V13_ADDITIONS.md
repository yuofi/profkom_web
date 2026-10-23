# Уточнения реализации API 1.3

Согласованные требования остаются в CODEX_FRONTEND.md/CODEX_BACKEND.md. Здесь зафиксированы технические read API и адаптеры, не расписанные отдельными путями в исходной карте.

## Версии сезонной сводной

- `GET /api/seasons/{season_id}/summary/versions` → `{items, next_cursor}`. Элемент: `version`, `changed_by: UserRef`, `changed_at`, `reason`, `previous_summary_version`.
- `GET /api/seasons/{season_id}/summary/versions/{version}` → те же метаданные + `summary: SeasonSummary`, `contributions`, `master_bonuses` — снимки этой версии.
- Только председатель, его действующие замы и мастер HR. Историческая версия не имеет прав редактирования.
- Закрытие сохраняет первую утверждённую версию. Каждая коррекция/разрешённая прямая правка closed-оценивания создаёт новую версию; состав, категории и база/получатель бонуса взяты из снимка закрытия.
- Вся команда correction выполняется одной транзакцией; объект другого сезона или ошибка любого элемента откатывают пакет полностью.

## Идентификация блоков

`block_id` — неизменяемый UUID, имя блока остаётся пользовательским названием. Новые DTO/входные данные используют UUID; совместимые старые ссылки по имени разрешаются на границе. Внутренние legacy-строки не являются источником прав. Переименование не меняет ID блока, членства или ссылки новых API.

## Привязка VK

`POST /api/auth/vk/link {access_token}` требует действующую авторизацию существующего аккаунта. Обычный VK-вход ищет только сохранённую внешнюю identity, не ФИО/совпадение почты. Фото VK не загружается.

## Legacy guides and storage

`GET /guides/{guide_id}/material` returns `{guide_id, material_id, revision}`. Legacy guide DTOs carry the same mapping and object capabilities. Old IDs are preserved. Legacy saves require `expected_revision` and refuse to overwrite an existing shared draft. New material publication updates the same old Guide row.

New PGAS entries require `file_url: "file:<file_id>"` for a completed contextual PGAS file. Its saved verified name/MIME are authoritative; arbitrary URL creation cannot bypass complete. Existing raw URLs remain readable through the legacy adapter. The response resolves that reference and old public upload URLs of the configured bucket (`pgas/`, `guides/`, `avatars/`, `<folder>/<uuid>.<ext>`) to temporary GET URLs; other bucket keys, including `private/` and `sealed/`, stay as written and unsigned. External legacy links stay unchanged; no remote content is downloaded by migration. Existing public bucket ACLs require an operator-side private-access rollout; changing a DTO does not revoke an old public URL.

## Ревизия обычного доступа в session

GET /session возвращает access_revision — стабильный непрозрачный отпечаток
обычных членств блоков и состава организаторов подмероприятий. Эти основания
доступа хранятся отдельно от RoleAssignment. Изменение отпечатка требует
удалить закрытый клиентский кэш и пересоздать его открытых наблюдателей.
Проверка выполняется при возврате к окну и периодически раз в 60 секунд.
Сам отпечаток не предоставляет права: каждый endpoint проверяет текущий ACL.

## Подтверждение версий закрытой коррекции

POST /seasons/{id}/summary/correct возвращает прежнюю сводную и дополнительный
массив applied_revisions: [{kind, id, revision}]. Эти номера читаются в той же
транзакции, что и успешная коррекция. Клиент удерживает версию сводной вместе
с исходной revision записи и использует подтверждение для следующей команды.

## Права выпуска 1

Правила доступа собраны в одной таблице `POLICY` в `backend/access.py`.
Серверные проверки и списки `capabilities` берут правила из неё, поэтому
capability выдаётся ровно тогда, когда сервер выполнит команду. Соответствие
проверяет `tests/test_access_matrix.py`: 16 ролей × все операции.

Новые capabilities:

- `view_meeting` у мероприятия и подмероприятия: можно открыть его созвон
  (`GET …/meeting`). Ссылку на созвон клиент показывает только при ней.
- `create_shared_material` в `/session`: можно создать КМБ или общий документ.
  Гайд создаёт тот, у кого есть `edit_block` в карточке блока.

Изменения ответов:

- `PATCH /tasks/{id}` проверяет право на область задачи. Тот, кто не может
  читать задачу, получает 404, а тот, кто читает, но не руководит областью, — 403.
  Revision сверяется после проверки прав.
- `GET /assignments/unresolved` без `view_unresolved_assignments` в `/session`
  отвечает 403, а не пустым списком.
- В закрытом сезоне задачи, оценивание, заслуги, решения сводной и коррекции
  правят председатель и замы. Отказ — 403 с префиксом `Forbidden` (раньше 422).
- `manage_deputies` у руководителя мероприятия или подмероприятия закрытого
  сезона не выдаётся: состав закрытого сезона не меняется.

## Хранилище, вход через VK и очистка (выпуск 1)

Ссылки на бакет в текстах материалов и гайдов (FIX_PLAN 0.2):

- При чтении подписываются только старые публичные загрузки: `pgas/`, `guides/`,
  `avatars/` и `<папка>/<uuid>.<расширение>`. Ссылки на `private/`, `sealed/` и
  прочие ключи остаются как записаны, без подписи (решение владельца 6). Закрытый
  файл открывается только через `GET /files/{id}/download` с проверкой прав.
- Редактор получает поле `source_content` — сохранённый текст: черновик, а если
  его нет, опубликованный текст. В нём `file:<id>` и ссылки без подписи. Поле
  выдаётся только тем, у кого есть `edit_material`. `published_content` — только
  для показа, в нём ссылки подписаны на 5 минут.
- `POST /materials`, `PATCH /materials/{id}`, публикация, `POST /guides` и
  сохранение старого гайда отвечают 422, если в тексте появилась новая ссылка на
  бакет, которой нет в опубликованном тексте. Новые файлы прикрепляются как
  `file:<id>`. Подписанная ссылка на вложение этого же материала сохраняется как
  `file:<id>`, подписанная ссылка на старую загрузку — без подписи.
- `POST /guides/{id}` без `text` не меняет текст гайда; «Админка → Гайды» при
  переименовании текст не отправляет.
- `scripts/repair_storage_links.py --database <путь> [--apply]` чинит тексты,
  в которые раньше попали подписанные ссылки. Без `--apply` база открывается только
  на чтение. Скрипт печатает только числа, повторный `--apply` меняет 0 строк.

Вход через VK (FIX_PLAN 0.3):

- Токен проверяет только VK ID (`id.vk.ru/oauth2/user_info` с `client_id` сайта).
  Запасной проверки через `users.get` нет (решение владельца 7). Отказ VK ID — 401,
  недоступность VK ID — 503; в обоих случаях вход не выполняется.
- `VK_CLIENT_ID` обязателен и должен совпадать с `VITE_APP_ID` сборки frontend.
  При `APP_ENV=production` без него backend не стартует, в других окружениях вход
  через VK отвечает 503. Значения по умолчанию в коде нет.

Очистка аккаунтов (FIX_PLAN 0.4, защитная часть): `scripts/cleanup_accounts.py
--apply` в выпуске 1 завершается с кодом 2 и ничего не меняет. Отчёт без `--apply`
работает. Подробности — в `ACCOUNT_RETENTION.md`.
