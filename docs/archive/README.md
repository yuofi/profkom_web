# Архив записок и доказательств

[Действующая документация](../README.md) · [Карта перемещений](../maintenance/DOCUMENTATION_REVIEW_20261031.md)

Это история, а не текущий backlog. Права, старые порты, ветки, счётчики тестов и
разрешения на поставку внутри записей относятся к их дате. Исторические команды
не нужно повторять без чтения действующих правил и проверки окружения.

## Итерации интерфейса и трекера

- [BUG_VALIDATION_20261026.md](iterations/20261026.md#source-bug-validation-20261026)
- [IMPROVEMENTS_20261026.md](iterations/20261026.md#source-improvements-20261026)
- [INTERACTIVE_CHIPS_20261027.md](iterations/20261027.md#source-interactive-chips-20261027)
- [ORGANIZATION_CALENDAR_20261027.md](iterations/20261027.md#source-organization-calendar-20261027)
- [PICKER_REFRESH_20261027.md](iterations/20261027.md#source-picker-refresh-20261027)
- [SEASON_WORKSPACE_20261027.md](iterations/20261027.md#source-season-workspace-20261027)
- [TRACKER_CONTROLS_20261027.md](iterations/20261027.md#source-tracker-controls-20261027)
- [TRACKER_FEEDBACK_20261027.md](iterations/20261027.md#source-tracker-feedback-20261027)
- [TRACKER_IMPLEMENTATION_20261026.md](iterations/20261026.md#source-tracker-implementation-20261026)
- [TRACKER_POLISH_20261027.md](iterations/20261027.md#source-tracker-polish-20261027)
- [TRACKER_STAGE2_20261027.md](iterations/20261027.md#source-tracker-stage2-20261027)
- [TRACKER_USABILITY_20261027.md](iterations/20261027.md#source-tracker-usability-20261027)
- [TREE_MATERIALS_20261027.md](iterations/20261027.md#source-tree-materials-20261027)
- [WORKSPACE_FOLLOWUP_20261028.md](iterations/20261028.md#source-workspace-followup-20261028)

Вместо 14 отдельных корневых отчётов — три сборника по датам. У каждой исходной
записки есть собственный якорь; внутренние ссылки переведены на него.

## Первоначальная реализация и интеграция

- [План, чеклист, карта требований и приёмка frontend](frontend/INITIAL_FRONTEND.md).
- [Доработки, аудит A01–A09 и их приёмка](frontend/FRONTEND_FOLLOWUP.md).
- [Интеграционные аудиты и локальные исправления 19 октября](frontend/INTEGRATION_20261019.md).
- [Доказательства объединённого frontend-кандидата 28–29 октября](frontend/UNIFIED_EVIDENCE_20261028.md).
- [Синтетические диагностические примеры 19 октября](frontend/audit-evidence/2026-10-19/README.md).
- [Ранний backend-аудит](backend/CONTINUATION_AUDIT_2026-10-18.md), [его приёмка](backend/BACKEND_ACCEPTANCE_2026-10-19.md).
- [Ранний отчёт BE-01/BE-02](backend/GEMINI-REPORT.md): утверждения об этапах и проверках на тот момент.

## Исходные решения, планы и дизайн

- [Первоначальная спецификация под прежним именем ARCHITECTURE.md](specifications/ARCHITECTURE_V13.md). Это исходное задание v1.3, а не обзор текущей архитектуры.
- [План объединённого выпуска 28 октября](planning/UNIFIED_RELEASE_PLAN_20261028.md).
- [Ход реализации и приёмки](planning/IMPLEMENTATION_LOG_20261028.md).
- [Первые варианты оформления блока мастера](design/master-block-variants-20261029/README.md).
- [Варианты D/E/F](design/master-block-variants-v2-20261029/README.md). Позднее владелец выбрал F с короной; фраза «не применено» внутри эскиза относится ко времени его подготовки.
- [Старый cutover и наблюдения сервера 24–25 октября](operations/DEPLOY_20261025.md). Текущий порядок — в [DEPLOY](../../DEPLOY.md). Разделы 1–5 cutover со шагами аудита 31 октября остаются процедурой перехода production с `6eb9dea` на `release-1` (DEPLOY, раздел 5).

Первоначальные `CODEX_FRONTEND.md` и `CODEX_BACKEND.md` удалены по решению
владельца как устаревшие задания, без создания новых архивных копий. Упоминания
их имён и номеров строк внутри старых отчётов — исторические ссылки. Сохранённая
выше спецификация ARCHITECTURE_V13 относится к тому же раннему этапу; действующие
правила описаны в [текущей архитектуре](../../ARCHITECTURE.md) и тематической справке.

## Локальные доказательства: .local/logs

Эти ссылки доступны в рабочей копии владельца, но не в свежем клоне. Журналы,
хэши и пакеты поставки не перемещались и не переписывались. Сводный реестр всех
Markdown-файлов этой области — в [ревизии](../maintenance/DOCUMENTATION_REVIEW_20261031.md).

| Что найти | Локальный отчёт |
| --- | --- |
| Первичная диагностика производительности | [REPORT.md](../../.local/logs/performance-eca8586-20261029/REPORT.md) |
| Первый пакет ускорений | [REPORT.md](../../.local/logs/performance-3950cfb-20261029/REPORT.md) |
| Второй проход и парные замеры | [REPORT.md](../../.local/logs/performance-round2-20261029/REPORT.md) |
| Фильтры и зависание редактора отметок | [RESULT.md](../../.local/logs/kkr-analytics-fix-892fce5-20261030/RESULT.md) |
| Масштабирование сохранения отметок | [REPORT.md](../../.local/logs/mark-scale-after-20261030/REPORT.md) |
| Вложения комментариев | [REPORT.md](../../.local/logs/comment-attachments-20261030/REPORT.md) |
| Рабочее пространство A и мероприятия C | [REPORT.md](../../.local/logs/workspace-events-layout-20261030/REPORT.md) |
| Последняя завершённая поставка 12dede0 | [REPORT.md](../../.local/logs/attachment-layout-deploy-20261030/REPORT.md) |
| Переезд в единственный checkout | [RESULT.md](../../.local/migration-20261030/RESULT.md) |
| Историческая ревизия диска и веток | [REPORT.md](../../.local/logs/storage-and-branches-20261029/REPORT.md) |

Для замера учитывать указанную в отчёте среду, число повторов, источник данных
и ограничения. Старое измерение не доказывает скорость сайта или свободное место
на сервере сегодня. Состояние теста в этой ревизии повторно не проверялось.
