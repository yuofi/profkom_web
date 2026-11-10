# Backend: действующие контракты

[Общая документация](../../docs/README.md) · [Архитектура и требования](../../ARCHITECTURE.md)
· [Backend README](../README.md) · [Проверки](../TESTING.md)

| Область | Контракт |
| --- | --- |
| Публичная задача и приватное оценивание | [TRACKER_WORKFLOW](TRACKER_WORKFLOW.md) |
| Тип, приоритет, сроки, чеклист, связи, избранное | [TRACKER_STAGE2](TRACKER_STAGE2.md) |
| Вложения комментариев и доступ к байтам | [COMMENT_ATTACHMENTS](COMMENT_ATTACHMENTS.md) |
| Передача очереди при недоступном владельце | [QUEUE_OWNERSHIP](QUEUE_OWNERSHIP.md) |
| Аналитика, коэффициенты и сохранённые итоги | [SEASON_ANALYTICS](SEASON_ANALYTICS.md) |
| Профиль, достижения, шаблоны и внешние уведомления | [PROFILE_FEATURES](PROFILE_FEATURES.md) |
| Связь с ботом HereBot: очередь работы, отчёты, консоль | [BOT_API](BOT_API.md) |
| Сервисный аккаунт: вход по логину, права, невидимость, уведомления о входе | [SERVICE_ACCOUNT](SERVICE_ACCOUNT.md) |
| История и скрытие текстов версий | [HISTORY](HISTORY.md) |
| Кто и когда одобрил или отклонил регистрацию | [REGISTRATION_DECISIONS](REGISTRATION_DECISIONS.md) |
| Аватары блоков | [BLOCK_AVATARS](BLOCK_AVATARS.md) |
| Проекции чтения и производительность | [READ_PROJECTIONS](READ_PROJECTIONS.md) |
| Базовые уточнения API 1.3 и совместимость | [API_V13_ADDITIONS](API_V13_ADDITIONS.md); поздний тематический контракт имеет приоритет |
| Прежние гайды и их переход к материалам | [LEGACY_GUIDE_RETIREMENT](LEGACY_GUIDE_RETIREMENT.md) |
| Архивирование аккаунтов и retention | [ACCOUNT_RETENTION](ACCOUNT_RETENTION.md) |
| Репетиция миграции старой базы | [MIGRATION_V13](MIGRATION_V13.md) |

Последняя большая запись согласования — [30 октября](../../docs/decisions/2026-10-30-portal.md);
решения владельца по аудиту — [31 октября](../../docs/decisions/2026-10-31-qa-audit.md).
Исправление вложений комментариев принято позже и описано отдельным контрактом.
Изначальные аудиты и результаты приёмки перемещены в [архив](../../docs/archive/README.md).
Чтение старого отчёта не заменяет проверку текущего OpenAPI и тестов.
