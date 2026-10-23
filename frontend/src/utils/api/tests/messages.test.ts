import { AxiosError, AxiosHeaders, CanceledError } from "axios";
import { describe, expect, it } from "vitest";
import { ApiError } from "../request";
import { blockerText, ERROR_TEXTS, errorDetail, fieldMessage, isStale, userMessage } from "../messages";

const axiosError = (status: number | null, data?: unknown) =>
  new AxiosError("Request failed", undefined, undefined, undefined,
    status === null ? undefined : { status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data });

describe("userMessage (FIX_PLAN 2.13)", () => {
  it("shows the Russian text of every code, never the server message", () => {
    for (const [code, text] of Object.entries(ERROR_TEXTS)) {
      const shown = userMessage(new ApiError("Technical detail", 409, code));
      expect(shown, code).toBe(text);
      expect(shown).not.toContain("Technical");
    }
  });

  it("writes every text in Russian, addressing the user formally", () => {
    for (const [code, text] of Object.entries(ERROR_TEXTS)) {
      expect(text, code).toMatch(/[А-Яа-яЁё]/);
      expect(text, code).not.toMatch(/[A-Za-z]{3,}/);
      expect(text, code).not.toMatch(/(^|[^а-яё])(ты|тебя|тебе|твой|твоя|твоё|твои)([^а-яё]|$)/i);
      expect(text, code).toMatch(/\.$/);
    }
  });

  it("falls back to the status, then to a general text", () => {
    expect(userMessage(new ApiError("x", 401, "http_401"))).toBe(ERROR_TEXTS.unauthenticated);
    expect(userMessage(new ApiError("x", 403, "denied"))).toBe(ERROR_TEXTS.forbidden);
    expect(userMessage(new ApiError("x", 404, "http_404"))).toBe(ERROR_TEXTS.not_found);
    expect(userMessage(new ApiError("x", 413, "http_413"))).toBe("Файл слишком большой.");
    expect(userMessage(new ApiError("x", 429, "http_429"))).toMatch(/^Слишком много попыток/);
    expect(userMessage(new ApiError("x", 500, "http_500"))).toBe("Ошибка на сервере. Повторите позже.");
    expect(userMessage(new ApiError("x", 418, "http_418"))).toBe("Не удалось выполнить действие. Повторите позже.");
  });

  it("puts a screen's own text before the shared one", () => {
    const failure = new ApiError("Invalid credentials", 401, "unauthenticated");
    expect(userMessage(failure, { 401: "Неверная почта или пароль." })).toBe("Неверная почта или пароль.");
    expect(userMessage(failure, { unauthenticated: "Свой текст.", 401: "Другой." })).toBe("Свой текст.");
  });

  it("names the deputy limit the server sent", () => {
    expect(userMessage(new ApiError("At most 2", 422, "deputy_limit", { limit: 2 })))
      .toBe("Можно назначить не больше 2 заместителей.");
    expect(userMessage(new ApiError("At most", 422, "deputy_limit"))).toBe(ERROR_TEXTS.deputy_limit);
  });

  it("keeps the client's own Russian text and hides a client defect", () => {
    expect(userMessage(new ApiError("Сначала обновите данные.", 409))).toBe("Сначала обновите данные.");
    expect(userMessage(new Error("Файл не выбран"))).toBe("Файл не выбран");
    expect(userMessage(new TypeError("Cannot read properties of undefined"))).toBe(ERROR_TEXTS.unexpected);
    expect(userMessage(new CanceledError())).toBe("Запрос отменён");
  });

  it("reads every answer of the server through one normalizer", () => {
    expect(userMessage(axiosError(null))).toBe(ERROR_TEXTS.network_error);
    expect(userMessage(axiosError(401, { detail: "Invalid credentials" }))).toBe(ERROR_TEXTS.unauthenticated);
    expect(userMessage(axiosError(422, { detail: [{ loc: ["body", "x"], msg: "Field required", type: "missing" }] })))
      .toBe(ERROR_TEXTS.validation_error);
    expect(userMessage(axiosError(409, { detail: { code: "season_closed", message: "Conflict: season is closed" } })))
      .toBe(ERROR_TEXTS.season_closed);
    expect(userMessage(axiosError(503, { detail: "VK ID is unavailable" }))).toBe(ERROR_TEXTS.unavailable);
  });

  it("offers a refresh only when the data changed", () => {
    for (const code of ["conflict", "revision_conflict", "season_closed"])
      expect(isStale(new ApiError("x", 409, code)), code).toBe(true);
    for (const [status, code] of [[409, "master_conflicts"], [409, "inactive_user"], [422, "conflict"], [409, "planned_exists"]] as const)
      expect(isStale(new ApiError("x", status, code)), code).toBe(false);
  });

  it("keeps the server detail for «Подробнее» only", () => {
    expect(errorDetail(new ApiError("Task not found", 404, "not_found"))).toBe("not_found: Task not found");
    expect(errorDetail(new ApiError("Сначала обновите данные."))).toBeNull();
    expect(errorDetail(axiosError(null))).toBeNull();
  });
});

describe("fieldMessage", () => {
  it("keeps a Russian field text and replaces an English one", () => {
    expect(fieldMessage("Неверный телефон")).toBe("Неверный телефон");
    expect(fieldMessage("Invalid phone")).toBe("Проверьте значение.");
    expect(fieldMessage("Неверный format")).toBe("Проверьте значение.");
    expect(fieldMessage({ type: "value_error", msg: "Value error, Пароль слишком короткий" })).toBe("Пароль слишком короткий");
    expect(fieldMessage({ type: "missing", msg: "Field required" })).toBe("Заполните поле.");
    expect(fieldMessage({ type: "string_too_long", msg: "String should have at most 200 characters" })).toBe("Слишком длинное значение.");
    expect(fieldMessage({ type: "something_new", msg: "Whatever" })).toBe("Проверьте значение.");
    expect(fieldMessage(undefined)).toBe("Проверьте значение.");
  });
});

describe("blockerText (A-KKR-15)", () => {
  const blocker = (kind: string, extra = {}) =>
    ({ kind, owner_kind: "task", owner_id: "task-7f3a", title: "Assignment task-7f3a", ...extra }) as never;

  it("names the task and whose work it is, never the identifiers", () => {
    const lines = [
      blockerText(blocker("unfinished_assignment", { subject: "Афиша", assignee: "Иван Петров" })),
      blockerText(blocker("missing_assessment", { subject: "Афиша", assignee: "Иван Петров" })),
      blockerText(blocker("missing_final_report", { owner_kind: "subevent", subject: "Лекции" })),
      blockerText(blocker("missing_final_report", { owner_kind: "event", subject: "Посвят" })),
      blockerText(blocker("previous_season_not_closed", { subject: "Осень" })),
    ];
    expect(lines).toEqual([
      "Не завершено назначение в задаче «Афиша», исполнитель: Иван Петров",
      "Нет оценки назначения в задаче «Афиша», исполнитель: Иван Петров",
      "Нет итогового отчёта подмероприятия «Лекции»",
      "Нет итогового отчёта мероприятия «Посвят»",
      "Не закрыт предыдущий сезон «Осень»",
    ]);
    for (const line of lines) expect(line).not.toMatch(/task-|Assignment/);
  });

  it("stays readable without the optional fields and for a new kind", () => {
    expect(blockerText(blocker("unfinished_assignment"))).toBe("Не завершено назначение в задаче");
    expect(blockerText(blocker("something_else"))).toBe("Есть незавершённая работа сезона");
  });
});
