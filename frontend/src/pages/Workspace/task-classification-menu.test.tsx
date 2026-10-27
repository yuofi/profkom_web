// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskClassificationIcon, TaskClassificationMenu } from "./TaskClassificationMenu";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import { advanceOwn } from "../../components/Workspace/ownRevisions";
import type { Task } from "../../utils/api/contract";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
const task = (overrides: Partial<Task> = {}): Task => ({ ...createFixtures("chair").tasks[0], task_type: "task", priority: "normal", starts_at: "2026-10-01T00:00:00Z", capabilities: ["change_task_type", "change_task_priority"], ...overrides });
const popup = () => document.querySelector<HTMLElement>('[data-classification-menu]');
const options = () => [...(popup()?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
async function show(source: Task, field: "task_type" | "priority", iconOnly = false) {
  transport = installMockTransport("chair", { delay: 0 });let rowOpens = 0;
  page = await mountWorkspace(<table><tbody><tr onClick={() => rowOpens++} onKeyDown={() => rowOpens++}><td><TaskClassificationMenu task={source} field={field} iconOnly={iconOnly} /></td></tr></tbody></table>);await waitForPage(page);
  return { trigger: page.container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!, rowOpens: () => rowOpens };
}
it("opens a portalled radio menu, focuses its current value and supports arrows, Home, End and Escape", async () => {
  const { trigger, rowOpens } = await show(task({ task_type: "epic" }), "task_type", true);
  await act(async () => trigger.click());await waitForPage(page!);expect(popup()?.closest("table")).toBeNull();expect(popup()?.getAttribute("role")).toBe("menu");expect(options().map(item => item.textContent)).toEqual(["Задача", "Веха", "Эпик"]);expect(document.activeElement).toBe(options()[2]);expect(options()[2].getAttribute("aria-checked")).toBe("true");
  const press = async (key: string) => { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); };
  await press("ArrowUp");expect(document.activeElement).toBe(options()[1]);await press("Home");expect(document.activeElement).toBe(options()[0]);await press("End");expect(document.activeElement).toBe(options()[2]);await press("Escape");expect(popup()).toBeNull();expect(document.activeElement).toBe(trigger);expect(rowOpens()).toBe(0);
});
it("opens from the keyboard, preserves Russian priority labels and closes on outside press", async () => {
  const { trigger, rowOpens } = await show(task(), "priority");expect(trigger.textContent).toContain("Средний");
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));await waitForPage(page!);expect(options().map(item => item.textContent)).toEqual(["Низкий", "Средний", "Высокий", "Срочный"]);expect(document.activeElement).toBe(options()[3]);expect(options().map(item => item.querySelector('svg')?.getAttribute('data-value'))).toEqual(["low", "normal", "high", "urgent"]);
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));expect(popup()).toBeNull();expect(document.activeElement).toBe(trigger);expect(rowOpens()).toBe(0);
});
it("changes only type with the current revision, accepts the server-cleared start and records own revision", async () => {
  const source = task(), saved = { ...source, task_type: "milestone" as const, starts_at: null, revision: source.revision + 1 }, save = vi.spyOn(tasksApi, "update").mockResolvedValue(saved);
  const { trigger, rowOpens } = await show(source, "task_type");await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[1].click());await waitForPage(page!);
  expect(save).toHaveBeenCalledExactlyOnceWith(source.task_id, { expected_revision: source.revision, task_type: "milestone" });expect(page!.client.getQueryData(["tasks", source.task_id])).toEqual(saved);expect(advanceOwn(page!.client, `task:${source.task_id}`, source.revision)).toBe(saved.revision);expect(popup()).toBeNull();expect(rowOpens()).toBe(0);
});
it("sends only priority, closes selecting the current value without a command, and respects field capabilities", async () => {
  const source = task(), save = vi.spyOn(tasksApi, "update").mockResolvedValue({ ...source, priority: "urgent", revision: source.revision + 1 });const { trigger } = await show(source, "priority");
  await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[1].click());expect(save).not.toHaveBeenCalled();expect(popup()).toBeNull();await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[3].click());await waitForPage(page!);expect(save).toHaveBeenCalledExactlyOnceWith(source.task_id, { expected_revision: source.revision, priority: "urgent" });
  await page!.cleanup();page = undefined;transport!.restore();transport = undefined;const readonly = await show(task({ capabilities: ["change_task_type"] }), "priority", true);expect(readonly.trigger.disabled).toBe(true);await act(async () => readonly.trigger.click());expect(popup()).toBeNull();
});
it("keeps a failed revision conflict visible outside clipped cells and never rebases it as an own change", async () => {
  const source = task();vi.spyOn(tasksApi, "update").mockRejectedValue(new ApiError("Связи изменились", 409, "task_type_conflict"));const { trigger } = await show(source, "task_type");await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[2].click());await waitForPage(page!);
  const error = document.querySelector('[role="alert"]');expect(error).not.toBeNull();expect(error?.closest("table")).toBeNull();expect(advanceOwn(page!.client, `task:${source.task_id}`, source.revision)).toBe(source.revision);expect(page!.client.getQueryData(["tasks", source.task_id])).toBeUndefined();expect(trigger.getAttribute("aria-label")).toBe("Тип задачи: Задача");
});
it("renders distinct reusable decorative icons without introducing interactive controls", async () => {
  page = await mountWorkspace(<><TaskClassificationIcon field="task_type" value="task" /><TaskClassificationIcon field="task_type" value="milestone" /><TaskClassificationIcon field="task_type" value="epic" onBrand /><TaskClassificationIcon field="priority" value="urgent" /></>);await waitForPage(page);
  expect(page.container.querySelectorAll("svg")).toHaveLength(4);expect(page.container.querySelectorAll("button,a")).toHaveLength(0);expect([...page.container.querySelectorAll("svg")].every(icon => icon.getAttribute("aria-hidden") === "true")).toBe(true);expect(new Set([...page.container.querySelectorAll("svg")].map(icon => icon.innerHTML)).size).toBe(4);
});

function deferredTask() {
  let resolve!: (value: Task) => void;const promise = new Promise<Task>(done => { resolve = done; });return { promise, resolve };
}
it("keeps the trigger focused and focusable while saving and after a deferred success", async () => {
  const source = task(), deferred = deferredTask();vi.spyOn(tasksApi, "update").mockReturnValue(deferred.promise);const { trigger } = await show(source, "priority");
  await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[3].click());
  expect(popup()).toBeNull();expect(trigger.disabled).toBe(false);expect(trigger.getAttribute("aria-disabled")).toBe("true");expect(trigger.getAttribute("aria-busy")).toBe("true");expect(document.activeElement).toBe(trigger);
  await act(async () => deferred.resolve({ ...source, priority: "urgent", revision: source.revision + 1 }));await waitForPage(page!);expect(document.activeElement).toBe(trigger);expect(trigger.getAttribute("aria-disabled")).toBe("false");expect(trigger.getAttribute("aria-busy")).toBe("false");
});
it("never steals focus from another control when a deferred save finishes", async () => {
  const source = task(), deferred = deferredTask();vi.spyOn(tasksApi, "update").mockReturnValue(deferred.promise);const { trigger } = await show(source, "task_type");
  await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[1].click());expect(document.activeElement).toBe(trigger);
  const other = document.createElement("button");other.type = "button";other.textContent = "Другое действие";page!.container.append(other);other.focus();
  await act(async () => deferred.resolve({ ...source, task_type: "milestone", starts_at: null, revision: source.revision + 1 }));await waitForPage(page!);expect(document.activeElement).toBe(other);
});
it("blocks repeated pointer and keyboard activation while the current command is pending", async () => {
  const source = task(), deferred = deferredTask(), save = vi.spyOn(tasksApi, "update").mockReturnValue(deferred.promise);const { trigger, rowOpens } = await show(source, "priority");
  await act(async () => trigger.click());await waitForPage(page!);await act(async () => options()[2].click());
  await act(async () => { trigger.click();trigger.click();trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(save).toHaveBeenCalledTimes(1);expect(popup()).toBeNull();expect(rowOpens()).toBe(0);
  await act(async () => deferred.resolve({ ...source, priority: "high", revision: source.revision + 1 }));await waitForPage(page!);expect(save).toHaveBeenCalledTimes(1);
});
