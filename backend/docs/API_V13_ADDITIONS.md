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

New PGAS entries require `file_url: "file:<file_id>"` for a completed contextual PGAS file. Its saved verified name/MIME are authoritative; arbitrary URL creation cannot bypass complete. Existing raw URLs remain readable through the legacy adapter. The response resolves that reference and existing configured-bucket URLs to temporary GET URLs. External legacy links stay unchanged; no remote content is downloaded by migration. Existing public bucket ACLs require an operator-side private-access rollout; changing a DTO does not revoke an old public URL.

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
