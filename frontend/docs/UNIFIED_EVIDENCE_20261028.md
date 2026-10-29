# Итоговая локальная проверка объединённого кандидата

Состояние после финального перезапуска 29.10.2026. Рабочий журнал: `../../docs/planning/IMPLEMENTATION_LOG_20261028.md`; инструкция: `../../docs/USER_GUIDE_20261028.md`.

| Проверка | Непосредственный результат |
| --- | --- |
| Полный backend |3610 passed,7 skipped;2 предупреждения зависимостей |
| Последние изменения истории/поддержки/материалов |32/32 адресных backend |
| Последняя защита общих аватаров |21/21, включая10 случаев жизненного цикла;без S3 |
| Полный frontend unit |636/636 |
| Настоящий HTTP на двух свежих БД |82/82 и82/82 |
| TypeScript app/node/e2e, ESLint, сборка |Без ошибок |
| Общий браузер1440/390 |116 проверок+8 функциональных групп+2 проверки контактов, всё PASS |
| Повторный импорт candidate |Все строки69таблиц/схема и18файлов неизменны |
| Проверка после перезапуска |8 входов,64 чтения PASS |

Срез полного backend предшествует последним адресно проверенным изменениям скрытия истории, сохранения триггеров и общих аватаров. Их результаты приведены отдельно; числа перекрывающихся прогонов не суммируются. CI, реальный VK/S3, серверный Docker и production этим прогоном не проверялись и не запускались. Старые значения истории могут показывать технические коды иISO-дату; это косметическая оговорка, не изменение учётных значений.

Ниже сохранена адресная квалификация старых критериев; она не заменяется общим числом тестов.

---

# Локальные доказательства frontend — 2026-10-28

Область этого среза: сводная ККР, фильтры начислений, готовность сезона,
перенос между сезонами, бывшие карточки и восстановление архивных назначений.
Общий статус согласованного релиза ведётся в
[журнале реализации](../../docs/planning/IMPLEMENTATION_LOG_20261028.md).
Общий full suite пока ожидает завершения root.

| Проверка | Измеренный результат | Граница подтверждения |
| --- | --- | --- |
| Первый пакет: [accounting acceptance](../src/pages/Workspace/accounting-acceptance.test.tsx), существующие summary-followup, summary-history и messages | 32/32 Vitest; адресный ESLint прошёл | Включает 7 новых сценариев с синтетическим transport: совместные фильтры, стабильный ID обезличенного участника, отдельная колонка прошлых отметок, серверные параметры, перенос и preview, готовность до close, запрет приватных GET без доступа. |
| Допакет: [архив и версии карточек](../src/pages/Workspace/directory-archive-contract.test.tsx) | 6 новых синтетических тестов прошли | Missing/stale revision не меняют карточку; повторное сохранение использует новую версию; ввод переживает конфликт. Сопоставление архивной роли с блоком выбирается явно и сохраняется после master_conflicts; название не подставляет ID. Мок readiness использует общий с close расчёт препятствий и приватный workflow. |
| Расширенный адресный прогон 7 файлов | 91/92 до исправления теста порядка blockers | Этот прогон не был полностью успешным. Единственный отказ: старый [contract-тест](../src/utils/api/tests/contract.test.ts) закреплял первый элемент списка препятствий. Проверка заменена на наличие нужного препятствия, порядок контрактом не гарантируется. |
| Проверка после изменения contract-теста | 7/7 прошли, 51 пропущен фильтром; адресный ESLint и git diff --check прошли | Повторены изменённый сценарий blockers и 6 новых тестов архива. Полный прогон 92 тестов повторно не выполнялся. |
| TypeScript / production build / общий frontend full suite | Общая проверка ожидает root | Последний локальный tsc этого допакета сообщал две ошибки вне новых веток: nullable deadline в другом участке transport и funding в PgasPage. После чужих исправлений эти проверки здесь не повторялись. |
| Live HTTP, desktop/mobile browser | **NOT RUN для новых изменений** | В [INT-03](../src/pages/Workspace/integration-acceptance.integration.test.tsx) добавлены проверки текущей и исторической седьмой колонки по настоящим DTO. Новые assertions ещё не запускались против API. Готовность, фильтры и восстановление требуют проверки на disposable synthetic API. |

Команды Vitest выполнялись Node 24 с `--configLoader native` локально.
Прогоны пересекаются: их числа нельзя суммировать в новое число прошедших тестов.
В этом пакете серверы не запускались; SSH, внешние сервисы и реальные данные
не использовались. Исторические заявления об интеграции в прежних документах
относятся к указанным там версиям и датам.

## UI follow-up 2026-10-29

Owner-approved compact two-list workspace layout; text block links and backdrop-close
contacts; real approval actors by stage; compact event lists; PGAS year/period filters;
separate profile settings and season templates; icon award popovers; shared day/week/month
calendar and empty Today time grid. Existing access and accounting boundaries are retained.

Final unit: 669/669 across 90 files; TypeScript app/node/e2e + ESLint clean. Build captures
435 source files /150 output files without source changes. Backend focused approvals23,
API inventory2082 and ACL46 pass; profile realHTTP/DOM5 pass on a disposable API. These
sets overlap the broader historical suites and must not be added into a new full-suite total.

Read-only browser groups on local synthetic candidate25688/API50688: contacts/PGAS20,
calendar/events/home14, profile18 at1440 and390; runtime errors, external requests and
attempted mutations0. Selected/unselected calendar filters44px, no document overflow;
award header/close remain visible at scrollTop0. Detailed reports:

- /private/tmp/profkom-ui-refine-browser-20261029/root-report.json
- /private/tmp/profkom-calendar-refine-20261029/final-report.json
- /private/tmp/profkom-profile-compact-qa-20261029/result.json
- /private/tmp/profkom-refine-published-manifest.json

Generation2 restart preserved current69-table content/schema and all18 object files;
8role logins/72 reads passed, original candidate proof and old25678/API49688 untouched.
Full backend was not rerun for this read-projection/UI-only package. No external rollout.

## UI follow-up, second request 2026-10-29

- Explicit framed subevent entries and safe Event/Subevent action placement below the
  decorative header cutout; mobile event content resets the inherited22rem flex basis.
- Full day/week use document scrolling; compact Today keeps its original bounded hours.
- Only the global fixed feedback button remains; separate dashboard widget/context removed.
- Master-block background is pending owner selection. Three real synthetic screenshot/CSS
  proposals are saved in docs/design/master-block-variants-20261029 outside frontend/public.

Full unit673/673,90files; TypeScript app/node/e2e and ESLint clean. Build435sources/150files,
source hashes stable. No backend changes or external operations in this package.
Calendar browser6/6 (1440/390) proves actual wheel/page deltas, no initial page jump,
local mobile horizontal scroll, compact Today internal wheel and one global bug button.
Event browser15/15 (1440/612/390) plus3/3 explicit date/announcement read-response fixtures.
The final mobile-only CSS adjustment is separately rechecked after rebuild.

Final second-request follow-up: Event/Subevent mobile4/4 after natural-basis fix;
contacts6/6 at1440/390 after owner removed role text/underlines/highlighter fill.
Focus, aria-description, no hover underline and no page overflow verified.
Unit673/673 and all TypeScript/ESLint remain clean; final435/150 build matches source.
Rejected A/B/C retained as history; D/E/F proposals without backgrounds live under
`docs/design/master-block-variants-v2-20261029`. Proposed styles are not imported into
production UI. No background was selected automatically.
