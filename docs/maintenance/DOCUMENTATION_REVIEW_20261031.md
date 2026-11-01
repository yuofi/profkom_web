# Ревизия Markdown-записок — 31 октября 2026

## Объём и решения

Инвентаризированы **185 Markdown-файлов** в основном checkout, включая `.local/`
и инструкции skill. Зависимости, Git, виртуальные окружения, build/dist и cache
не считаются рабочими записками. Чужие репозитории и личная память Codex вне проекта
не изменялись. Все действия этой ревизии локальны; приложения и серверы не запускались.

- Устаревшие итерационные отчёты объединены по датам; frontend-планы и приёмки — по этапам.
- 39 прежних путей записок сведены к 19 адресам: 20 отдельных файлов устранены консолидацией, а уникальные тексты сохранены.
- Прежний ARCHITECTURE с большим исходным заданием сохранён в архиве; на его месте — актуальные архитектура, требования и образ результата.
- DEPLOY разделён на текущий порядок и архив конкретного cutover. В USER_GUIDE добавлены актуальные права, четыре статуса, ККР и файлы комментариев.
- Справка TRACKER_WORKFLOW переписана по текущим правилам; из TRACKER_STAGE2 убраны отменённые права исполнителя и восемь публичных статусов.
- Действующие инструкции, Markdown-данные приложения и локальные доказательства сохранены. Ранние CODEX-задания удалены по последующему прямому решению владельца как устаревшие, без создания новых копий.
- Активные планы не подменяются старой историей. Эта ревизия не создаёт нового согласованного roadmap.

## Как проверялась актуальность

Проверены назначение, заголовки, незавершённые пункты, повторяющиеся этапы и
ссылки записок; меняющиеся правила сверены с `tracker.py`, `tracker_status.py`,
`tracker_collaboration.py`, `tracker_stage2.py`, `accounting_batch.py`,
`season_coefficients.py`, центральным `access.py`, frontend-маршрутами и адресными
тестами. Числа старых тестов сохраняются только как исторические утверждения —
эта ревизия не повторяет все описанные в них эксперименты.

Самые существенные отменённые ранние решения: восемь публичных статусов,
редактирование описания/классификации обычным читателем/исполнителем, создание
очередей всеми и отсутствие глобальных ККР-прав у фактического заместителя HR.
Последующие правила находятся в [архитектуре](../../ARCHITECTURE.md) и
[workflow](../../backend/docs/TRACKER_WORKFLOW.md).

После удаления двух CODEX-заданий в корне осталось 5 Markdown-файлов вместо 22;
в проектной документации (без локальных доказательств и skill) — 56 вместо 71.

## Карта всех исходных записок проекта

| Исходный путь | Решение / адрес |
| --- | --- |
| `AGENTS.md` | Сохранено без изменения: исходное задание / инструкция |
| `ARCHITECTURE.md` | [Объединено / перенесено](../archive/specifications/ARCHITECTURE_V13.md); исходный путь теперь содержит актуальный документ |
| `BUG_VALIDATION_20261026.md` | [Объединено / перенесено](../archive/iterations/20261026.md#source-bug-validation-20261026) |
| `CODEX_BACKEND.md` | Удалено по прямому решению владельца: устаревшее исходное задание |
| `CODEX_FRONTEND.md` | Удалено по прямому решению владельца: устаревшее исходное задание |
| `DEPLOY.md` | [Объединено / перенесено](../archive/operations/DEPLOY_20261025.md); исходный путь теперь содержит актуальный документ |
| `GEMINI-REPORT.md` | [Объединено / перенесено](../archive/backend/GEMINI-REPORT.md) |
| `GEMINI.md` | Сохранено без изменения: исходное задание / инструкция |
| `IMPROVEMENTS_20261026.md` | [Объединено / перенесено](../archive/iterations/20261026.md#source-improvements-20261026) |
| `INTERACTIVE_CHIPS_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-interactive-chips-20261027) |
| `ORGANIZATION_CALENDAR_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-organization-calendar-20261027) |
| `PICKER_REFRESH_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-picker-refresh-20261027) |
| `README.md` | [Действующий тематический документ](../../README.md) |
| `SEASON_WORKSPACE_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-season-workspace-20261027) |
| `TRACKER_CONTROLS_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-tracker-controls-20261027) |
| `TRACKER_FEEDBACK_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-tracker-feedback-20261027) |
| `TRACKER_IMPLEMENTATION_20261026.md` | [Объединено / перенесено](../archive/iterations/20261026.md#source-tracker-implementation-20261026) |
| `TRACKER_POLISH_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-tracker-polish-20261027) |
| `TRACKER_STAGE2_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-tracker-stage2-20261027) |
| `TRACKER_USABILITY_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-tracker-usability-20261027) |
| `TREE_MATERIALS_20261027.md` | [Объединено / перенесено](../archive/iterations/20261027.md#source-tree-materials-20261027) |
| `WORKSPACE_FOLLOWUP_20261028.md` | [Объединено / перенесено](../archive/iterations/20261028.md#source-workspace-followup-20261028) |
| `backend/README.md` | [Действующий тематический документ](../../backend/README.md) |
| `backend/TESTING.md` | [Действующий тематический документ](../../backend/TESTING.md) |
| `backend/docs/ACCOUNT_RETENTION.md` | [Действующий тематический документ](../../backend/docs/ACCOUNT_RETENTION.md) |
| `backend/docs/API_V13_ADDITIONS.md` | [Действующий тематический документ](../../backend/docs/API_V13_ADDITIONS.md) |
| `backend/docs/BACKEND_ACCEPTANCE_2026-10-19.md` | [Объединено / перенесено](../archive/backend/BACKEND_ACCEPTANCE_2026-10-19.md) |
| `backend/docs/BLOCK_AVATARS.md` | [Действующий тематический документ](../../backend/docs/BLOCK_AVATARS.md) |
| `backend/docs/COMMENT_ATTACHMENTS.md` | [Действующий тематический документ](../../backend/docs/COMMENT_ATTACHMENTS.md) |
| `backend/docs/CONTINUATION_AUDIT_2026-10-18.md` | [Объединено / перенесено](../archive/backend/CONTINUATION_AUDIT_2026-10-18.md) |
| `backend/docs/HISTORY.md` | [Действующий тематический документ](../../backend/docs/HISTORY.md) |
| `backend/docs/ITERATION_20261030.md` | [Объединено / перенесено](../decisions/2026-10-30-portal.md) |
| `backend/docs/LEGACY_GUIDE_RETIREMENT.md` | [Действующий тематический документ](../../backend/docs/LEGACY_GUIDE_RETIREMENT.md) |
| `backend/docs/MIGRATION_V13.md` | [Действующий тематический документ](../../backend/docs/MIGRATION_V13.md) |
| `backend/docs/PROFILE_FEATURES.md` | [Действующий тематический документ](../../backend/docs/PROFILE_FEATURES.md) |
| `backend/docs/QUEUE_OWNERSHIP.md` | [Действующий тематический документ](../../backend/docs/QUEUE_OWNERSHIP.md) |
| `backend/docs/READ_PROJECTIONS.md` | [Действующий тематический документ](../../backend/docs/READ_PROJECTIONS.md) |
| `backend/docs/SEASON_ANALYTICS.md` | [Действующий тематический документ](../../backend/docs/SEASON_ANALYTICS.md) |
| `backend/docs/TRACKER_STAGE2.md` | [Действующий тематический документ](../../backend/docs/TRACKER_STAGE2.md) |
| `backend/docs/TRACKER_WORKFLOW.md` | [Действующий тематический документ](../../backend/docs/TRACKER_WORKFLOW.md) |
| `backend/md/КМБ.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `backend/md/гайды.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `docs/USER_GUIDE_20261028.md` | [Переименовано и актуализировано](../USER_GUIDE.md) |
| `docs/design/master-block-variants-20261029/README.md` | [Объединено / перенесено](../archive/design/master-block-variants-20261029/README.md) |
| `docs/design/master-block-variants-v2-20261029/README.md` | [Объединено / перенесено](../archive/design/master-block-variants-v2-20261029/README.md) |
| `docs/planning/IMPLEMENTATION_LOG_20261028.md` | [Объединено / перенесено](../archive/planning/IMPLEMENTATION_LOG_20261028.md) |
| `docs/planning/UNIFIED_RELEASE_PLAN_20261028.md` | [Объединено / перенесено](../archive/planning/UNIFIED_RELEASE_PLAN_20261028.md) |
| `frontend/GEMINI.md` | Сохранено без изменения: исходное задание / инструкция |
| `frontend/README.md` | [Действующий тематический документ](../../frontend/README.md) |
| `frontend/docs/ACCEPTANCE.md` | [Объединено / перенесено](../archive/frontend/INITIAL_FRONTEND.md#source-acceptance) |
| `frontend/docs/AUDIT_FIXES_ACCEPTANCE.md` | [Объединено / перенесено](../archive/frontend/FRONTEND_FOLLOWUP.md#source-audit-fixes-acceptance) |
| `frontend/docs/CHECKLIST.md` | [Объединено / перенесено](../archive/frontend/INITIAL_FRONTEND.md#source-checklist) |
| `frontend/docs/FOLLOWUP_ACCEPTANCE.md` | [Объединено / перенесено](../archive/frontend/FRONTEND_FOLLOWUP.md#source-followup-acceptance) |
| `frontend/docs/FOLLOWUP_PLAN.md` | [Объединено / перенесено](../archive/frontend/FRONTEND_FOLLOWUP.md#source-followup-plan) |
| `frontend/docs/INTEGRATION_AUDIT_2026-10-19.md` | [Объединено / перенесено](../archive/frontend/INTEGRATION_20261019.md#source-integration-audit-2026-10-19) |
| `frontend/docs/INTEGRATION_STATUS_2026-10-19.md` | [Объединено / перенесено](../archive/frontend/INTEGRATION_20261019.md#source-integration-status-2026-10-19) |
| `frontend/docs/LOCAL_FIXES_ACCEPTANCE_2026-10-19.md` | [Объединено / перенесено](../archive/frontend/INTEGRATION_20261019.md#source-local-fixes-acceptance-2026-10-19) |
| `frontend/docs/MOCKS.md` | [Действующий тематический документ](../../frontend/docs/MOCKS.md) |
| `frontend/docs/PLAN.md` | [Объединено / перенесено](../archive/frontend/INITIAL_FRONTEND.md#source-plan) |
| `frontend/docs/READ_PATHS.md` | [Действующий тематический документ](../../frontend/docs/READ_PATHS.md) |
| `frontend/docs/REQUIREMENTS.md` | [Объединено / перенесено](../archive/frontend/INITIAL_FRONTEND.md#source-requirements) |
| `frontend/docs/REQUIREMENTS_AUDIT_2026-10-18.md` | [Объединено / перенесено](../archive/frontend/FRONTEND_FOLLOWUP.md#source-requirements-audit-2026-10-18) |
| `frontend/docs/UNIFIED_EVIDENCE_20261028.md` | [Объединено / перенесено](../archive/frontend/UNIFIED_EVIDENCE_20261028.md) |
| `frontend/docs/WHOLE_SITE_AUDIT_2026-10-19.md` | [Объединено / перенесено](../archive/frontend/INTEGRATION_20261019.md#source-whole-site-audit-2026-10-19) |
| `frontend/docs/audit-evidence/2026-10-19/README.md` | [Объединено / перенесено](../archive/frontend/audit-evidence/2026-10-19/README.md) |
| `frontend/public/md/KMB.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `frontend/public/md/guides.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `frontend/public/md/information.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `frontend/src/scripts/md/KMB.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `frontend/src/scripts/md/guides.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |
| `frontend/src/scripts/md/information.md` | Сохранено без изменения: текст/ресурс приложения, не рабочая записка |

## Инструкции проектного skill

| Путь | Решение |
| --- | --- |
| `.agents/skills/profkom-web/SKILL.md` | Сохранено без изменения |
| `.agents/skills/profkom-web/references/architecture.md` | Обновлена только ссылка на действующую справку и вход в документацию |
| `.agents/skills/profkom-web/references/verification.md` | Сохранено без изменения |

## Игнорируемые локальные материалы

Все **111** исходных `.local/**/*.md` сохранены с прежними путями и байтами.
Это журналы и доказательства, миграционные/релизные пакеты, копии legacy и тексты
приложения в артефактах. Удалять их как «дубли .md» нельзя без проверки целостности
всего пакета и его хэшей. В общий рабочий вход они не включены; важные отчёты
перечислены в [указателе](../archive/README.md).

| Путь | Класс |
| --- | --- |
| `.local/HANDOFF-2026-10-25.md` | Локальная рабочая инструкция |
| `.local/README.md` | Локальная рабочая инструкция |
| `.local/design/workspace-events-20261030/README.md` | Локальный дизайн |
| `.local/legacy/backend-6eb9dea/README.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-6eb9dea/TESTING.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-6eb9dea/md/КМБ.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-6eb9dea/md/гайды.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-bfc2b874/README.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-bfc2b874/TESTING.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-bfc2b874/md/КМБ.md` | Сохранённый исходный снимок |
| `.local/legacy/backend-bfc2b874/md/гайды.md` | Сохранённый исходный снимок |
| `.local/logs/attachment-layout-deploy-20261030/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/comment-attachments-20261030/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/cors-20261026/journal-cors-applied.md` | Историческое доказательство / журнал |
| `.local/logs/improvements-20261026/journal-addition.md` | Историческое доказательство / журнал |
| `.local/logs/interactive-chips-20261027/CUTOVER.md` | Историческое доказательство / журнал |
| `.local/logs/interactive-chips-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/kkr-analytics-fix-892fce5-20261030/DEPLOYMENT.md` | Историческое доказательство / журнал |
| `.local/logs/kkr-analytics-fix-892fce5-20261030/README.md` | Историческое доказательство / журнал |
| `.local/logs/kkr-analytics-fix-892fce5-20261030/RESULT.md` | Историческое доказательство / журнал |
| `.local/logs/kkr-followup-20261030/DEPLOYED.md` | Историческое доказательство / журнал |
| `.local/logs/kkr-followup-browser-20261030T102853Z-5a6167/RESULT.md` | Историческое доказательство / журнал |
| `.local/logs/kkr-mark-probe-20261030/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/mark-scale-after-20261030/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/organization-calendar-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-3950cfb-20261029/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-3950cfb-20261029/evidence/browser/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-3950cfb-20261029/evidence/local-comparison/COMPARISON.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/backend/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/backend/seed200-report.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/frontend/actual-static-addendum.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/frontend/final-test-addendum.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/frontend/frontend-audit.md` | Историческое доказательство / журнал |
| `.local/logs/performance-eca8586-20261029/frontend/render-probe.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/deployment-test-58dbffa/COMPARISON.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/deployment-test-58dbffa/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/evidence/frontend/BEFORE.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/evidence/notifications/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/evidence/root/AUDIT_PLAN.md` | Историческое доказательство / журнал |
| `.local/logs/performance-round2-20261029/evidence/root/paired-backend/RESULTS.md` | Историческое доказательство / журнал |
| `.local/logs/picker-refresh-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/picker-refresh-20261027/detail-HANDOFF.md` | Историческое доказательство / журнал |
| `.local/logs/season-workspace-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/season-workspace-20261027/season-ui/HANDOFF.md` | Историческое доказательство / журнал |
| `.local/logs/season-workspace-20261027/task-accounting/HANDOFF.md` | Историческое доказательство / журнал |
| `.local/logs/server-role-http-207e75b-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/step11/RELEASE_LOG.before-server-part.md` | Историческое доказательство / журнал |
| `.local/logs/storage-and-branches-20261029/BRANCH_AUDIT.md` | Историческое доказательство / журнал |
| `.local/logs/storage-and-branches-20261029/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/storage-and-branches-20261029/STORAGE_REVIEW.md` | Историческое доказательство / журнал |
| `.local/logs/test-deploy-207e75b-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/test-update-20261026-7a1dc58/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-20261026/IMPLEMENTATION_PLAN.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-20261026/TRACKER_IMPLEMENTATION_20261026.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-20261026/TRACKER_WORKFLOW.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-20261026/backend-status-inventory.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-controls-20261027/CUTOVER.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-controls-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-feedback-20261027/TRACKER_FEEDBACK_20261027.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-feedback-20261027/TRACKER_WORKFLOW.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-feedback-20261027/audit/queue-access-independent-review.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-feedback-20261027/detail/HANDOFF.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-hr-notifications-20261027/CUTOVER.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-hr-notifications-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-polish-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-stage2-20261027/CUTOVER.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-stage2-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-usability-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-usability-20261027/audit/final-version-isolation.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-usability-20261027/audit/public-private-independent-review.md` | Историческое доказательство / журнал |
| `.local/logs/tracker-usability-20261027/detail/HANDOFF.md` | Историческое доказательство / журнал |
| `.local/logs/tree-materials-20261027/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/tree-materials-20261027/demo-data/README.md` | Историческое доказательство / журнал |
| `.local/logs/validation-20261026/BUG_VALIDATION_20261026.md` | Историческое доказательство / журнал |
| `.local/logs/workspace-events-layout-20261030/REPORT.md` | Историческое доказательство / журнал |
| `.local/logs/workspace-followup-5ccfea2-20261028/BROWSER_HANDOFF.md` | Историческое доказательство / журнал |
| `.local/logs/workspace-followup-5ccfea2-20261028/REPORT.md` | Историческое доказательство / журнал |
| `.local/migration-20261030/RESULT.md` | Доказательство переезда |
| `.local/planning/iteration-20261030/architecture.md` | Историческая подготовка |
| `.local/planning/kkr-followup-20261030/README.md` | Историческая подготовка |
| `.local/planning/kkr-followup-20261030/architecture.md` | Историческая подготовка |
| `.local/planning/workspace-events-layout-20261030/README.md` | Историческая подготовка |
| `.local/scripts/step11/release-log-entry.md` | Историческая заготовка журнала |
| `.local/scripts/step11/release-log-server.md` | Историческая заготовка журнала |
| `.local/transfer/dist-prod/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-prod/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-prod/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test.before-7a1dc58/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test.before-7a1dc58/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test.before-7a1dc58/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test.prev-1726/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test.prev-1726/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test.prev-1726/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/dist-test/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/prod-430e3ae-20261026/README.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-12dede0-20261030/dist-test/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-12dede0-20261030/dist-test/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-12dede0-20261030/dist-test/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-2886a8a-20261030/dist-test/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-2886a8a-20261030/dist-test/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-2886a8a-20261030/dist-test/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-72793aa-20261030/dist-test/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-72793aa-20261030/dist-test/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-72793aa-20261030/dist-test/md/information.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-7a1dc58-20261026/dist-test/md/KMB.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-7a1dc58-20261026/dist-test/md/guides.md` | Артефакт поставки / ресурс внутри него |
| `.local/transfer/test-7a1dc58-20261026/dist-test/md/information.md` | Артефакт поставки / ресурс внутри него |

## Проверка результата

Итоги проверки ссылок, неизменности защищённых файлов, сохранения содержимого
сборников и отсутствия изменений кода записываются в
`.local/logs/docs-review-20261031/verification.json`. Там же `before.json` хранит
исходный перечень и SHA256, а `moves.json` — машиночитаемую карту адресов.
Проверка не запускает приложение, внешние сервисы или HTTP тестового сайта.

После удаления CODEX-заданий повторная проверка ссылок и сохранности остальных
файлов записана отдельно в `.local/logs/docs-review-20261031/remove-obsolete-specs/verification.json`.
Первоначальные результаты ревизии выше сохранены как доказательство предыдущего этапа.
