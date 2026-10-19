# Отчет о реализации доработок по ТЗ BE-03 (ARCHITECTURE.md)

В данном документе фиксируются результаты выполнения каждого шага по устранению выявленных недоработок и дефектов в модуле BE-03 («Трекер, сдачи, комментарии, файлы и ККР»).

---

## План работ
1. **Шаг 1**: Исправление ошибок в эндпоинте списка задач (`GET /api/tasks`) и логике отзыва баллов при возврате на доработку (`_recalculate_assignment_contribution`).
2. **Шаг 2**: Разграничение прав доступа (ACL) и изоляция областей задач (создание, просмотр, проверка волонтеров вне области).
3. **Шаг 3**: Реализация внутренних уведомлений (назначение задачи, запрос помощи лидам, возврат на доработку).
4. **Шаг 4**: Добавление категории участника (`category`) и автоматическое повышение джунов до активистов при закрытии сезона.
5. **Шаг 5**: Создание набора тестов `test_be03_tracker_kkr.py`, верификация и обновление knowledge graph (`graphify update .`).

---

### Шаг 1: Исправление ошибок в эндпоинтах и логике пересчета баллов — ВЫПОЛНЕНО
- **Исправление параметра `mine` в `GET /api/tasks`**:
  - В файле [`backend/main.py`](file:///home/pavel/Desktop/web/profkom-service/backend/main.py#L2766) исправлен вызов `db.list_tasks`: вместо некорректного `mine=mine` передается `mine_user_id=cur.user_id if mine else None`.
  - Устранена потенциальная ошибка `TypeError`, возникавшая при запросе своих задач (`GET /api/tasks?mine=true`).
- **Корректный отзыв начисления при возврате на доработку / изменении статуса**:
  - В функции [`_recalculate_assignment_contribution`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L1222) доработано условие удаления начисления: теперь, если статус назначения меняется на любой статус, отличный от `accepted` и `not_completed` (включая `needs_revision`, `in_progress`, `cancelled`), либо если итоговый балл равен `None`, существующая запись `ContributionORM` незамедлительно удаляется.
  - Это предотвращает утечку баллов в сезонную сводную ККР за задачи, отправленные руководителем на доработку.

---

### Шаг 2: Разграничение прав доступа (ACL) и изоляция областей задач — ВЫПОЛНЕНО
- **Контроль прав на создание задач**:
  - В методе [`create_task`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3826) добавлена проверка полномочий создателя `can_manage_scope(created_by_user_id, scope_kind, scope_id)` (мастер/замы блока, ответственные/замы подмероприятия, главорги родительского мероприятия, тачки). При отсутствии прав возвращается ошибка `403 Forbidden`.
- **Изоляция чужих задач в `get_task` и `list_tasks`**:
  - В [`get_task`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3913) добавлена проверка `can_view_scope`: участники одного блока или подмероприятия не могут просматривать чужие задачи, зная их `task_id` (`403 Forbidden`). Глобальные роли (председатель, замы, HR-мастер) имеют полный доступ.
  - В [`list_tasks`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3920) добавлена проверка запрошенной области (`scope_kind` + `scope_id`), а также серверная фильтрация общего списка: рядовые участники видят задачи только своих областей, что строго выполняет требование ТЗ «операции и списки не раскрывают чужие подмероприятия; результаты видны всей команде области».
  - В [`backend/main.py`](file:///home/pavel/Desktop/web/profkom-service/backend/main.py#L2752) для эндпоинтов `GET /tasks` и `GET /tasks/{task_id}` добавлена корректная трансляция исключений `Forbidden` в HTTP `403`.
- **Валидация получателей волонтерских заслуг**:
  - В [`create_merit`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L4720) добавлена проверка для `block_volunteer` и `subevent_volunteer`: если указанный получатель уже состоит в составе области (`is_member_or_leader_in_scope`), запрос отклоняется (`422/ValueError`). Это гарантирует, что волонтерские начисления вносятся строго участникам вне состава области, в соответствии с ТЗ.

---

### Шаг 3: Реализация внутренних уведомлений (Notifications) — ВЫПОЛНЕНО
- **Уведомление при назначении задачи (`kind="task_assignment"`)**:
  - При создании задачи в [`create_task`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3826) каждому назначенному исполнителю генерируется запись `NotificationORM` с метаданными (`task_id`, `assignment_id`, `title`, `deadline_at`).
  - При переназначении в [`reassign_assignment`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L4328) новому исполнителю также создается уведомление `task_assignment`.
- **Уведомление всем лидам области при запросе помощи (`kind="task_help_required"`)**:
  - Реализован вспомогательный метод [`get_scope_leads`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3813), возвращающий список мастеров/замов блока или ответственных/замов подмероприятия.
  - В [`request_help_assignment`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L4058) реализована рассылка уведомлений всем руководителям и заместителям соответствующей области о том, что исполнитель запросил помощь (с защитой от повторных уведомлений при повторе команды благодаря проверке перехода состояния).
- **Уведомление исполнителю при возврате на доработку (`kind="task_revision_requested"`)**:
  - В методе [`request_revision_assignment`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L4220) создается запись `NotificationORM` для исполнителя задачи с текстом замечания руководителя (`review_note`).

---

### Шаг 4: Добавление категории участника (`category`) и автоматическое повышение при закрытии сезона — ВЫПОЛНЕНО
- **Поле `category` у пользователя**:
  - В модели [`UserORM`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L76) и датаклассе [`User`](file:///home/pavel/Desktop/web/profkom-service/backend/models.py#L40) добавлено поле `category` (значения `"junior"` / `"activist"`, по умолчанию `"junior"`).
  - Реализован миграционный хелпер [`_ensure_sqlite_users_category_column`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L717), автоматически добавляющий колонку в существующие базы данных SQLite с безопасным значением по умолчанию.
- **Автоматическое повышение джунов при `close_season`**:
  - В методе [`close_season`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L2800) реализован регламент закрытия:
    1. Сначала в неизменяемом виде фиксируется утвержденная сезонная сводная `SeasonSummaryORM` с категориями на момент завершения сезона.
    2. Затем в рамках той же транзакции вычисляется порог стажа (`threshold = duration / 2`), и активные джуны автоматически переводятся в категорию `activist`.
    3. Создается запись аудита `AuditLogORM` с основанием повышения (`season_id`, `participation`, `threshold`), предотвращая повторные или некорректные переходы.---

### Шаг 5: Комплексное тестирование и валидация регрессии — ВЫПОЛНЕНО
- **Создан специализированный набор тестов `backend/tests/test_be03_tracker_kkr.py`**:
  - `test_создание_задачи_мастером_и_контроль_прав`: создание задачи мастером блока, валидация привязки исполнителей к блоку, проверка прав посторонних (403), генерация уведомления `task_assignment`.
  - `test_изоляция_просмотра_задач`: проверка изоляции детального просмотра задачи (`GET /api/tasks/{task_id}`) и листинга с фильтрацией по скоупу (`GET /api/tasks?scope_kind=block&scope_id=...`) для посторонних лиц.
  - `test_полный_цикл_назначения_сдача_приемка_доработка`: сквозной сценарий работы: `start` -> `request-help` (с уведомлением лидов) -> `submit` -> `request-revision` (с отзывом баллов и уведомлением исполнителю) -> `submit` -> `accept` (начисление баллов ККР).
  - `test_формула_ккр_граничные_значения`: проверка коэффициентов критериев ($1.2 \times 1.3 \times 1.1 \times 1.2 \times 1.1$), понижающего коэффициента за просрочку ($decay=0.5$), нулевой оценки ($0.0$) и штрафа ($-1.0$).
  - `test_волонтерские_заслуги_только_вне_блока`: отклонение волонтерских заслуг внутри скоупа (422) и успешное начисление внешним волонтерам.
  - `test_переназначение_задачи_новому_исполнителю`: сценарий отмены/переназначения задачи на нового исполнителя с отправкой уведомления новому назначенцу.
  - `test_закрытие_сезона_бонус_мастера_и_повышение_категории`: проверка автоматического бонуса мастера ($bonus = \text{avg\_eval} \times 0.25 \times \text{sum\_hours}$) и повышения джуниоров в активисты при стаже $\ge 50\%$ сезона.
- **Исправление выявленных дефектов маршрутизации**:
  - В [`main.py`](file:///home/pavel/Desktop/web/profkom-service/backend/main.py#L2833) исправлен порядок аргументов в вызове `db.request_help_assignment`: `cur.user_id` передан третьим позиционным аргументом.
  - В [`main.py`](file:///home/pavel/Desktop/web/profkom-service/backend/main.py#L2866) исправлен порядок аргументов в вызове `db.submit_assignment`: `cur.user_id` передан третьим позиционным аргументом.
  - В [`database.py`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L2649) добавлен метод-алиас `is_chair_deputy` для совместимости с `is_deputy_chair`.
- **Результаты прогона тестов**:
  - Набор BE-03: `7 passed in 4.94s` (100% успешно).
  - Полный регрессионный сьют проекта: `2398 passed, 21 skipped, 0 failed in 292.26s` (полное отсутствие регрессий).
---

# Отчет по реализации ТЗ BE-04: «Отчёты, рабочая страница, календарь, уведомления»

### 1. Модели данных, миграции и датаклассы
- **Модели ORM**:
  - В модель [`ReportORM`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L408) добавлены поля для ведения черновиков: `draft_title`, `draft_content_json`, `draft_files_json`.
  - Создана таблица и ORM-модель [`ReportVersionORM`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L427) для хранения неизменяемых опубликованных версий (`version`, `title`, `content_json`, `files_json`, `published_at`, `published_by_user_id`).
  - Создана таблица и ORM-модель [`ReportEditorORM`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L440) для фиксации исторических редакторов отчётов при закрытии сезона (`season_id`, `owner_kind`, `owner_id`, `report_id`, `user_id`, `role`, `created_at`).
  - Реализован автоматический SQLite-мигратор [`_ensure_sqlite_reports_columns`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L797) для безопасного добавления колонок черновика.
- **Датаклассы**:
  - В датакласс [`Report`](file:///home/pavel/Desktop/web/profkom-service/backend/models.py#L416) добавлены поля `draft_title`, `draft_content`, `draft_files`.
  - Добавлены датаклассы [`ReportVersion`](file:///home/pavel/Desktop/web/profkom-service/backend/models.py#L433) и [`Notification`](file:///home/pavel/Desktop/web/profkom-service/backend/models.py#L444).

### 2. Бизнес-логика отчетов (Reports) в слое БД
- **Управление отчетами и контроль доступа**:
  - Метод [`is_report_editor`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3254): проверяет статус аккаунта (`active`, не забанен), роли руководителя/зама в соответствующей области (`event`/`subevent`), авторство, а для закрытых сезонов — наличие записи в снимке `ReportEditorORM`. Тачки и HR не имеют автоматического права записи в отчеты без соответствующей локальной роли.
  - Метод [`can_read_report`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3282): черновики видны только редакторам; опубликованные отчеты доступны тачкам, руководителям/замам мероприятия и подмероприятий, а рядовые орги видят только опубликованные отчеты своего подмероприятия.
  - [`create_report`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3312): создание отчета со статусом `draft`; сезон и серия автоматически выводятся из владельца; ограничение на один `final` отчет на экземпляр (возврат 409 Conflict при попытке создания дубликата).
  - [`get_report`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3386) и [`list_reports`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3397): изоляция черновиков (для обычных читателей поля `draft_*` скрыты, возвращается `None`).
  - [`patch_report`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3428): для опубликованных отчетов редактируются только поля черновика (`draft_title`, `draft_content_json`, `draft_files_json`), опубликованное содержимое не затрагивается до момента явной публикации; инкрементируется `revision`.
  - [`publish_report`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3466): копирует черновик в опубликованные поля, создает запись в `ReportVersionORM`, инкрементирует `published_version`; повторная публикация без изменений идемпотентна и не создает дублирующих версий.
  - [`list_report_versions`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3517): возвращает список всех опубликованных версий с проверкой прав доступа.
  - [`list_report_history`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3527): возвращает опубликованные исторические отчеты за все годы по серии. Главорг/замы имеют доступ к главной серии и дочерним сериям подмероприятий; ответственный видит только свою серию; тачки видят всё; черновики скрыты.
- **Фиксация исторических редакторов при закрытии сезона**:
  - В методе [`close_season`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3159) формируется неизменяемый снимок всех действующих руководителей, замов и авторов отчетов сезона в `ReportEditorORM`.
  - Сохраненные редакторы имеют право править и публиковать новые версии своих старых отчетов после закрытия сезона, не открывая сезон заново и не влияя на ККР. Новые руководители следующего года по этой серии имеют доступ только к чтению истории.

### 3. Рабочая страница (Dashboard), Календарь и Уведомления
- **Рабочая страница**:
  - Метод [`get_dashboard`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3579) агрегирует личные активные задачи пользователя, доступные предстоящие созвоны, блоки и мероприятия с ролями, а также счетчик назначений в очереди ревью (`help_required`, `submitted`).
- **Календарь**:
  - Метод [`get_calendar`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3671) объединяет дедлайны назначений пользователя (и задач в руководимых скоупах) и разрешенные созвоны в заданном диапазоне дат. Рядовой орг подмероприятия видит созвон своего подмероприятия, но главный созвон мероприятия для него скрыт (MEETING-01, CALENDAR-01).
- **Внутренние уведомления**:
  - Метод [`list_notifications`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3734): возвращает уведомления пользователя с повторной проверкой доступа к объекту. Если пользователь утратил права на задачу/скоуп, уведомление скрывается, предотвращая утечку закрытого объекта (NOTIFY-01).
  - Методы [`mark_notification_read`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3772) и [`mark_all_notifications_read`](file:///home/pavel/Desktop/web/profkom-service/backend/database.py#L3782): пометка прочитанным одного/всех уведомлений с защитой от изменения чужих записей.

### 4. API Эндпоинты в `backend/main.py`
- Добавлены Pydantic-схемы: `ReportCreateIn`, `ReportPatchIn`, `ReportPublishIn`, `ReportOut`, `ReportVersionOut`, `NotificationOut`, `DashboardTaskOut`, `DashboardMeetingOut`, `DashboardBlockOut`, `DashboardEventOut`, `DashboardOut`, `CalendarItemOut`.
- Реализованы эндпоинты:
  - `POST /api/reports`
  - `GET /api/reports`
  - `GET /api/reports/{report_id}`
  - `PATCH /api/reports/{report_id}`
  - `POST /api/reports/{report_id}/publish`
  - `GET /api/reports/{report_id}/versions`
  - `GET /api/report-history`
  - `GET /api/dashboard`
  - `GET /api/calendar`
  - `GET /api/notifications`
  - `POST /api/notifications/{notification_id}/read`
  - `POST /api/notifications/read-all`
- Обновлен контрактный реестр API `API_ROUTES` и вспомогательная функция `url_for` в [`test_api_contract.py`](file:///home/pavel/Desktop/web/profkom-service/backend/tests/test_api_contract.py#L45).

### 5. Тестирование и валидация
- Разработан сьют тестов [test_be04_reports_dashboard_calendar.py](file:///home/pavel/Desktop/web/profkom-service/backend/tests/test_be04_reports_dashboard_calendar.py) (7 сценариев, покрывающих REPORT-01..06, MEETING-01, CALENDAR-01, NOTIFY-01, SEASON-04).
- **Результаты тестирования**:
  - `pytest tests/test_be04_reports_dashboard_calendar.py`: **7 passed** в 6.26s.
  - `pytest tests/test_api_contract.py`: **1149 passed** в 3.06s.
  - Полный регрессионный сьют `pytest tests/`: **2525 passed, 21 skipped, 0 failed** в 298.76s.
