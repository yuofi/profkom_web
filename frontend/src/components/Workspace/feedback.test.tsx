// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FeedbackProvider } from "./FeedbackButton";
import { MaterialContent } from "./MaterialContent";
import { clearDiagnostics, recordDiagnostic, snapshotDiagnostics } from "../../utils/diagnostics";
import { supportApi } from "../../utils/api/support.api";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, field, submit } from "../../test/workspace";
import { ApiError } from "../../utils/api/request";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;clearDiagnostics();vi.restoreAllMocks();vi.unstubAllGlobals(); });

it("keeps telemetry bounded, removes query secrets and records filter codes without values", () => {
  for (let index = 0; index < 120; index++) recordDiagnostic("api", "response", "/tasks/task-fixture?token=secret-value", "GET", 403);
  window.history.replaceState({}, "", "/tasks?status=in_progress&q=PRIVATESEARCH&tab=analytics");
  const diagnostic = snapshotDiagnostics("/tasks/task-fixture?token=secret-value");
  expect(diagnostic.events).toHaveLength(100);
  expect(diagnostic.route).toBe("/tasks/:id");
  expect(diagnostic.screen.filters).toEqual(["status", "search"]);
  expect(diagnostic.screen.active_tab).toBe("analytics");
  expect(JSON.stringify(diagnostic)).not.toContain("secret-value");
  expect(JSON.stringify(diagnostic)).not.toContain("PRIVATESEARCH");
});

it("retries a failed feedback submission with the same key and immutable payload", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const secure = vi.fn((bytes: Uint8Array) => { bytes.fill(231);return bytes; });vi.stubGlobal("crypto", { getRandomValues: secure });
  vi.spyOn(supportApi, "context").mockResolvedValue({ configured: false, revision: 1, block_id: null, queue_id: null, can_configure: false, can_manage_staff: false, can_triage: false, staff_user_ids: [] });
  const save = vi.spyOn(supportApi, "submit").mockRejectedValueOnce(Error("Synthetic failure")).mockResolvedValue({ report_id: "feedback-fixture", kind: "bug", state: "pending", task_id: null, task_key: null, revision: 1, diagnostics_expires_at: "2027-01-01" });
  page = await mountWorkspace(<FeedbackProvider><p>Синтетический экран</p></FeedbackProvider>);await settle();
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Сообщить об ошибке или предложить улучшение"]')!.click());await settle();
  const dialog = document.querySelector('[aria-modal="true"]')!;
  await change(field(dialog, "feedback-title"), "Synthetic bug");
  const body = dialog.querySelector("textarea")!;await change(body, "Synthetic steps");
  expect(secure).not.toHaveBeenCalled();
  await submit(dialog.querySelector("form")!);await settle();
  expect(save).toHaveBeenCalledTimes(1);expect(field(dialog, "feedback-title").matches(":disabled")).toBe(true);
  const first = structuredClone(save.mock.calls[0][0]);
  expect(first.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await submit(dialog.querySelector("form")!);await settle();
  expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[1][0]).toEqual(first);
  expect(secure).toHaveBeenCalledOnce();
  expect(dialog.textContent).toContain("Обращение сохранено");
  expect(dialog.querySelector('a[href^="/tasks/"]')).toBeNull();
});

it("keeps the form usable and shows a clear error when secure client IDs are unavailable", async () => {
  mock = installMockTransport("chair", { delay: 0 });vi.stubGlobal("crypto", undefined);
  const save = vi.spyOn(supportApi, "submit");
  page = await mountWorkspace(<FeedbackProvider><p>Синтетический экран</p></FeedbackProvider>);await settle();
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Сообщить об ошибке или предложить улучшение"]')!.click());await settle();
  const dialog = document.querySelector('[aria-modal="true"]')!;
  await change(field(dialog, "feedback-title"), "Проверка обычного HTTP");await change(dialog.querySelector("textarea")!, "Описание сохраняется в форме");
  await submit(dialog.querySelector("form")!);await settle();
  expect(save).not.toHaveBeenCalled();expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("защищённый номер запроса");
  expect(field(dialog, "feedback-title").value).toBe("Проверка обычного HTTP");expect(field(dialog, "feedback-title").disabled).toBe(false);
  expect(dialog.textContent).not.toContain("тот же номер запроса");
});

it("builds a table of contents from rendered headings without treating code as a section", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<MaterialContent body={'# First\n\n## Same\n\n## Same\n\n```text\n# Not a heading\n```'} />);await settle();
  const toc = page.container.querySelector('[aria-label="Содержание материала"]')!;
  const links = [...toc.querySelectorAll("a")];
  expect(links.map(link => link.textContent)).toEqual(["First", "Same", "Same"]);
  expect(new Set(links.map(link => link.hash)).size).toBe(3);
  for (const link of links) expect(document.getElementById(decodeURIComponent(link.hash.slice(1)))).not.toBeNull();
});

async function openFeedback() {
  vi.spyOn(supportApi, "context").mockResolvedValue({ configured: false, revision: 1, block_id: null, queue_id: null, can_configure: false, can_manage_staff: false, can_triage: false, staff_user_ids: [] });
  page = await mountWorkspace(<FeedbackProvider><p>Синтетический экран</p></FeedbackProvider>);await settle();
  await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Сообщить об ошибке или предложить улучшение"]')!.click());await settle();
  return document.querySelector<HTMLElement>('[aria-modal="true"]')!;
}
const receipt = { report_id: "feedback-fixture", kind: "bug" as const, state: "pending", task_id: null, task_key: null, revision: 1, diagnostics_expires_at: "2027-01-01" };
const describedError = (element: Element) => document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent;
async function choose(dialog: HTMLElement, bytes: number[], name = "screen.png") {
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!, file = new File([new Uint8Array(bytes)], name, { type: "image/png" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] });input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 20; i++) await settle();
}
const PNG_HEAD = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];

it("checks trimmed fields before sending and reopens the form after a definite refusal with a fresh key", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const save = vi.spyOn(supportApi, "submit")
    .mockRejectedValueOnce(new ApiError("Too many feedback reports", 429, "http_429"))
    .mockRejectedValueOnce(new ApiError("Проверьте заполнение полей", 422, "validation_error", { errors: [{ loc: ["body", "title"], type: "string_too_short", msg: "short" }] }))
    .mockResolvedValue(receipt);
  const dialog = await openFeedback(), title = field(dialog, "feedback-title"), body = dialog.querySelector("textarea")!;
  await change(title, "   ");await change(body, "Шаги воспроизведения");
  await submit(dialog.querySelector("form")!);
  expect(save).not.toHaveBeenCalled();expect(title.getAttribute("aria-invalid")).toBe("true");expect(describedError(title)).toBe("Заполните поле.");
  await change(title, "Кнопка не работает");expect(title.hasAttribute("aria-invalid")).toBe(false);
  await submit(dialog.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(1);expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Подождите минуту");
  expect(title.disabled).toBe(false);expect(body.disabled).toBe(false);expect(dialog.textContent).toContain("Отправить обращение");
  await submit(dialog.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(2);expect(describedError(title)).toBe("Заполните поле.");expect(title.disabled).toBe(false);
  await change(title, "Кнопка «Сохранить» не работает");await submit(dialog.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(3);expect(save.mock.calls[2][0].title).toBe("Кнопка «Сохранить» не работает");
  expect(new Set(save.mock.calls.map(call => call[0].idempotency_key)).size).toBe(3);
  expect(dialog.textContent).toContain("Обращение сохранено");
});

it("checks the screenshot locally and shows a refused size at the image, which can still be removed", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const save = vi.spyOn(supportApi, "submit").mockRejectedValueOnce(new ApiError("Request Entity Too Large", 413, "http_413")).mockResolvedValue(receipt);
  const dialog = await openFeedback(), file = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(file.hidden).toBe(true);
  const choice = [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Выбрать изображение"))!;expect(choice).toBeDefined();
  await choose(dialog, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], "fake.png");
  expect(describedError(choice)).toContain("не PNG");expect(dialog.querySelector("img")).toBeNull();
  await choose(dialog, PNG_HEAD);
  expect(dialog.querySelector("img")).not.toBeNull();expect(choice.hasAttribute("aria-invalid")).toBe(false);expect(dialog.textContent).toContain("screen.png");
  await change(field(dialog, "feedback-title"), "Скриншот");await change(dialog.querySelector("textarea")!, "Описание");
  await submit(dialog.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(1);expect(describedError(choice)).toContain("Изображение слишком большое");
  const remove = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Убрать изображение")!;
  expect(remove.disabled).toBe(false);await act(async () => remove.click());await settle();
  expect(dialog.querySelector("img")).toBeNull();
  await submit(dialog.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[1][0].screenshot).toBeNull();
});
