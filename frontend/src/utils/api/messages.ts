import { normalizeApiError, type ApiError } from "./request";
import type { SeasonBlocker } from "./contract";

/**
 * Russian texts of API errors, chosen by the stable `code` and then by status (FIX_PLAN
 * 2.13, A-FE-3). The server's English `message` is only a technical detail and never the
 * text itself. The owner approves these texts (decision 42).
 */
export const ERROR_TEXTS: Record<string, string> = {
  unauthenticated: "Сессия закончилась. Войдите снова.",
  forbidden: "Нет доступа к этому действию. Возможно, роль снята.",
  queue_access_required: "Для этой очереди нужен доступ. Можно отправить запрос её владельцу.",
  task_type_conflict: "Сначала удалите связи, несовместимые с новым типом задачи.",
  task_epic_conflict: "У задачи уже есть эпик. Удалите прежнюю связь, чтобы выбрать другой.",
  queue_key_conflict: "Этот ключ очереди уже занят. Выберите другой ключ.",
  not_found: "Объект не найден или недоступен.",
  conflict: "Запись изменилась. Обновите данные и проверьте ввод.",
  revision_conflict: "Запись изменилась. Обновите данные и проверьте ввод.",
  legacy_task_statuses: "У старых назначений разные исходы. Выберите совместимое действие, чтобы сохранить историю.",
  season_closed: "Сезон закрыт: эти данные больше не меняются.",
  season_not_ready: "Сезон пока нельзя закрыть.",
  planned_exists: "Запланированный сезон уже есть.",
  final_report_exists: "Итоговый отчёт этого экземпляра уже есть.",
  invalid_input: "Проверьте введённые данные.",
  validation_error: "Проверьте введённые данные.",
  registration_attempt_limit:
    "Лимит пяти отправок исчерпан. Для повторной подачи нужен сброс счётчика руководством.",
  master_conflicts: "У блоков уже есть другие мастера. Выберите, кто останется.",
  archive_scope_mapping_required: "Для прежних назначений выберите действующие блоки.",
  chair_transfer_required: "Сначала передайте пост председателя.",
  restore_deputy_limit: "Все места заместителей заняты. Освободите место перед восстановлением.",
  already_chair: "Этот участник уже председатель.",
  already_member: "Участник уже в блоке.",
  email_taken: "Эта почта уже зарегистрирована.",
  name_taken: "Блок с таким названием уже есть.",
  inactive_user: "Участник не активен: заявка не одобрена или аккаунт в архиве.",
  unknown_user: "Участник не найден.",
  deputy_limit: "Слишком много заместителей.",
  duplicate_users: "Один участник выбран дважды.",
  self_deputy: "Руководителя нельзя назначить своим заместителем.",
  identity_linked: "Этот аккаунт VK уже привязан к другому участнику.",
  vk_link_required: "Ваш VK ещё не привязан к аккаунту на сайте. Обратитесь к председателю или заму.",
  duplicate_files: "Один файл приложен дважды.",
  upload_transfer_failed: "Не удалось передать файл. Проверьте подключение и повторите загрузку.",
  upload_missing: "Файл не загрузился. Загрузите его снова.",
  upload_expired: "Время загрузки истекло. Загрузите файл снова.",
  unavailable: "Сервис временно недоступен. Повторите позже.",
  network_error: "Нет связи с сервером. Проверьте подключение и повторите.",
  unexpected: "Что-то пошло не так. Обновите страницу и повторите.",
  contract_mismatch: "Сервер ответил в неожиданном виде. Обновите страницу.",
  feedback_duplicate_key: "Этот запрос уже использован для другого обращения. Откройте форму заново.",
  support_queue_key_conflict: "Ключ очереди поддержки уже занят. Обратитесь к председателю.",
  template_archived: "Шаблон перенесён в архив. Выберите другой шаблон.",
  template_scope_mismatch: "Этот шаблон относится к другой команде. Выберите подходящий шаблон.",
  pagination_error: "Не удалось загрузить список целиком. Обновите страницу.",
};

const BY_STATUS: Record<number, string> = {
  400: ERROR_TEXTS.invalid_input,
  401: ERROR_TEXTS.unauthenticated,
  403: ERROR_TEXTS.forbidden,
  404: ERROR_TEXTS.not_found,
  409: ERROR_TEXTS.conflict,
  413: "Файл слишком большой.",
  422: ERROR_TEXTS.invalid_input,
  429: "Слишком много попыток. Подождите и повторите.",
  503: ERROR_TEXTS.unavailable,
};

/** Codes after which rereading the data is the way on: the form offers «Обновить данные». */
const STALE = new Set(["conflict", "revision_conflict"]);
export const isStale = (error: unknown) => {
  const e = normalizeApiError(error);
  return e.status === 409 && STALE.has(e.code);
};

function withFields(e: ApiError) {
  if (e.code === "upload_transfer_failed" && [401, 403].includes(e.status))
    return "Сервис загрузки отклонил файл. Повторите загрузку; если ошибка сохраняется, сообщите руководству.";
  if (e.code === "upload_transfer_failed" && e.status >= 500)
    return "Сервис загрузки временно недоступен. Повторите загрузку позже.";
  if (e.code === "deputy_limit" && typeof e.fields.limit === "number")
    return `Можно назначить не больше ${e.fields.limit} заместителей.`;
  return undefined;
}

/**
 * Text to show for an error. `overrides` give a screen its own text for a code or a status,
 * e.g. {401: "Неверная почта или пароль."} on the login form.
 */
export function userMessage(
  error: unknown,
  overrides: Partial<Record<string | number, string>> = {},
): string {
  const e = normalizeApiError(error);
  // Our own Russian text: a check in the client, a cancelled request, a broken list.
  if (e.code === "client_error") return e.message;
  const message = (
    overrides[e.code] ??
    overrides[e.status] ??
    withFields(e) ??
    ERROR_TEXTS[e.code] ??
    BY_STATUS[e.status] ??
    (e.status >= 500
      ? "Ошибка на сервере. Повторите позже."
      : "Не удалось выполнить действие. Повторите позже.")
  );
  const stage = e.fields.upload_stage;
  if (stage === "intent") return `Не удалось начать загрузку файла. ${message}`;
  if (stage === "complete") return `Файл передан, но сохранение не завершено. ${message}`;
  return message;
}

/** The server's detail, for the collapsed «Подробнее»: only when it says something more. */
export function errorDetail(error: unknown): string | null {
  const e = normalizeApiError(error);
  if (e.code === "client_error" || !e.status || !e.message) return null;
  return `${e.code}: ${e.message}`;
}

const cyrillic = /[А-Яа-яЁё]/;
const latinWord = /[A-Za-z]{3,}/;
const FIELD_TEXTS: Record<string, string> = {
  missing: "Заполните поле.",
  string_too_short: "Слишком короткое значение.",
  string_too_long: "Слишком длинное значение.",
  too_long: "Слишком много значений.",
  int_parsing: "Введите целое число.",
  int_type: "Введите целое число.",
  float_parsing: "Введите число.",
  greater_than_equal: "Значение слишком маленькое.",
  less_than_equal: "Значение слишком большое.",
  literal_error: "Выберите значение из списка.",
  enum: "Выберите значение из списка.",
  value_error: "Проверьте значение.",
};

/**
 * Text of one field error: from FastAPI (`type`, `msg`) or a string the server put into
 * `fields`. A server text in Russian only is ours, written for the screen; English is not.
 */
export function fieldMessage(item: unknown): string {
  if (typeof item === "string")
    return cyrillic.test(item) && !latinWord.test(item) ? item : "Проверьте значение.";
  const issue = (item ?? {}) as { type?: unknown; msg?: unknown };
  const text = String(issue.msg ?? "").replace(/^Value error, /, "");
  if (cyrillic.test(text) && !latinWord.test(text)) return text;
  return FIELD_TEXTS[String(issue.type ?? "")] ?? "Проверьте значение.";
}

/** One line per obstacle to closing a season, whose it is included (2.13, A-KKR-15). */
export function blockerText(b: SeasonBlocker): string {
  const subject = b.subject ? `«${b.subject}»` : "";
  const whose = b.assignee ? `, исполнитель: ${b.assignee}` : "";
  switch (b.kind) {
    case "unfinished_assignment":
      return `Не завершено назначение в задаче ${subject}${whose}`.trim();
    case "missing_assessment":
      return `Нет оценки назначения в задаче ${subject}${whose}`.trim();
    case "missing_final_report":
      return `Нет итогового отчёта ${b.owner_kind === "subevent" ? "подмероприятия" : "мероприятия"} ${subject}`.trim();
    case "previous_season_not_closed":
      return `Не закрыт предыдущий сезон ${subject}`.trim();
    default:
      return "Есть незавершённая работа сезона";
  }
}
