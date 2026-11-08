// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TaskQueuePage, TaskQueuesPage } from "./TaskQueuePages";
import { TrackerListPage } from "./TrackerList";
import { createFixtures, type MockRole } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import type { TaskQueueAccessRequest, TaskQueueCreation } from "../../utils/api/contract";
import { queueCreationNotice, queueCreationShort } from "./queuePlace";
import { ApiError } from "../../utils/api/request";
import { mountWorkspace, waitForPage, change, submit } from "../../test/workspace";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
async function mount(path: string, role: MockRole = "leader") {
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<TrackerListPage />} /><Route path="/tasks/queues" element={<TaskQueuesPage />} /><Route path="/tasks/queues/:id" element={<TaskQueuePage />} /></Routes>, { path, role });
  await waitForPage(page);
}
function button(label: string) { return [...page!.container.querySelectorAll("button")].find(p => p.textContent?.trim() === label)!; }
it("shows a locked queue in the directory without its owner or scope", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;transport.state.queues[0].owner = transport.state.people[3];
  await mount("/tasks/queues?access=all", "organizer");
  const card = page!.container.querySelector<HTMLAnchorElement>('a[href="/tasks/queues/queue-tasks"]')!.closest('tr')!;
  expect(card.textContent).toContain("TASK");expect(card.textContent).toContain("Нет доступа");expect(card.textContent).not.toContain(transport.state.people[3].display_name);expect(card.querySelector("img")).toBeNull();
  // Nor its team or season (owner 2026-11-08, В8).
  expect(card.textContent).toContain("Скрыта");expect(card.textContent).not.toContain("Лекции и встречи");expect(card.textContent).not.toContain("Осень и зима 2026");expect(card.querySelector('a[href^="/seasons/"]')).toBeNull();
});
it("shows a queue's team and its season with its state in the directory and beside the queue's title (owner 2026-11-08, В8, variant В)", async () => {
  transport = installMockTransport("leader", { delay: 0 });
  await mount("/tasks/queues");
  const row = page!.container.querySelector<HTMLAnchorElement>('a[href="/tasks/queues/queue-tasks"]')!.closest("tr")!, pill = row.querySelector<HTMLAnchorElement>('a[href="/seasons/season-1"]')!;
  expect(row.textContent).toContain("Лекции и встречи");expect(pill.textContent).toBe("Осень и зима 2026 · открыт");expect(pill.dataset.state).toBe("open");expect(pill.title).toBe("Сезон «Осень и зима 2026» открыт");
  const block = page!.container.querySelector<HTMLAnchorElement>(`a[href="/tasks/queues/queue-${transport.state.blocks[0].block_id}"]`)!.closest("tr")!;
  expect(block.textContent).toContain(transport.state.blocks[0].name);expect(block.querySelector('a[href^="/seasons/"]')).toBeNull();
  await page!.cleanup();
  await mount("/tasks/queues/queue-tasks");
  const header = page!.container.querySelector("header")!, title = header.querySelector("h1")!;
  // The team and the season stand in the title's row; the old «Команда» and «Сезон» captions are gone.
  expect(title.textContent).toBe("Задачи встречи");expect(title.parentElement!.textContent).toMatch(/^Задачи встречи.*Лекции и встречи.*Осень и зима 2026 · открыт$/);
  expect(title.parentElement!.querySelector<HTMLAnchorElement>('a[href="/seasons/season-1"]')?.dataset.state).toBe("open");expect(header.textContent).not.toContain("Сезон");
  expect(page!.container.querySelector('a[title="Создать задачу"]')).not.toBeNull();expect(page!.container.querySelector('button[aria-disabled="true"]')).toBeNull();expect(page!.container.textContent).not.toContain("не создаются");
  await page!.cleanup();
  // A block queue shows its team only.
  await mount(`/tasks/queues/queue-${transport.state.blocks[0].block_id}`);
  const blockTitle = page!.container.querySelector("header h1")!;
  expect(blockTitle.parentElement!.textContent).toContain(transport.state.blocks[0].name);expect(page!.container.querySelector('header a[href^="/seasons/"]')).toBeNull();expect(page!.container.querySelector('a[title="Создать задачу"]')).not.toBeNull();
});
it.each([
  ["closed", "Сезон «Осень и зима 2026» закрыт — новые задачи в этой очереди создать нельзя.", "Осень и зима 2026 · закрыт", "Сезон закрыт: новые задачи не создаются"],
  ["summarizing", "Сезон «Осень и зима 2026» подводит итоги — новые задачи в этой очереди создать нельзя.", "Осень и зима 2026 · подводит итоги", "Сезон подводит итоги: новые задачи не создаются"],
] as const)("a queue whose event season is %s keeps «Создать задачу» disabled with its reason for mouse, keyboard, touch and screen readers", async (state, reason, pill, note) => {
  transport = installMockTransport("leader", { delay: 0 });transport.state.seasons.find(season => season.season_id === "season-1")!.state = state;
  function Location() { return <output data-location>{useLocation().pathname}</output>; }
  page = await mountWorkspace(<><Routes><Route path="/tasks/queues/:id" element={<TaskQueuePage />} /></Routes><Location /></>, { path: "/tasks/queues/queue-tasks", role: "leader" });await waitForPage(page);
  const season = page.container.querySelector<HTMLAnchorElement>('header a[href="/seasons/season-1"]')!;
  expect(season.textContent).toBe(pill);expect(season.dataset.state).toBe(state);expect(page.container.querySelector("h1")?.textContent).toBe("Задачи встречи");
  // No banner and no working link: the button stays in place, disabled.
  expect([...page.container.querySelectorAll('[role="status"]')].some(node => node.textContent === reason)).toBe(false);expect(page.container.querySelector('a[title="Создать задачу"]')).toBeNull();
  const create = button("Создать задачу");
  expect(create.getAttribute("aria-disabled")).toBe("true");expect(create.disabled).toBe(false);
  expect(document.getElementById(create.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
  const short = [...page.container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(node => node.textContent === note);
  expect(short).toBeDefined();expect(create.closest("[data-row-action]")!.nextElementSibling!.nextElementSibling).toBe(short);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  // A click or a tap only focuses it, which opens the full reason; nothing is created or opened.
  await act(async () => create.click());await waitForPage(page);
  expect(document.activeElement).toBe(create);expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(reason);
  expect(page.container.querySelector("[data-location]")?.textContent).toBe("/tasks/queues/queue-tasks");
  await act(async () => create.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));expect(document.querySelector('[role="tooltip"]')).toBeNull();
  // Keyboard focus opens it too.
  await act(async () => create.blur());await act(async () => create.focus());expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(reason);
});
it("names each refusal briefly beside the button and fully in its hint", () => {
  const queue = (reason: TaskQueueCreation["reason"]) => ({ season: { season_id: "s", title: "Весна 2026", state: "closed" as const }, task_creation: { available: false, reason } });
  expect(queueCreationShort(queue("season_closed"))).toBe("Сезон закрыт: новые задачи не создаются");
  expect(queueCreationShort(queue("season_summarizing"))).toBe("Сезон подводит итоги: новые задачи не создаются");
  expect(queueCreationShort(queue("no_open_season"))).toBe("Нет открытого сезона: новые задачи не создаются");
  expect(queueCreationShort(queue("no_season"))).toBe("Нет сезона: новые задачи не создаются");
  expect(queueCreationShort(queue("team_missing"))).toBe("Команда недоступна: новые задачи не создаются");
  expect(queueCreationShort(queue(null))).toBe("Новые задачи сейчас не создаются");
  expect(queueCreationNotice(queue("season_closed"))).toBe("Сезон «Весна 2026» закрыт — новые задачи в этой очереди создать нельзя.");
});
it("a reader who may not create tasks in a closed season's queue sees no create button and no reason", async () => {
  transport = installMockTransport("leader", { delay: 0 });transport.state.seasons.find(season => season.season_id === "season-1")!.state = "closed";
  vi.spyOn(taskQueuesApi, "get").mockImplementation(async id => { const queue = (await taskQueuesApi.catalog()).items.find(item => item.queue_id === id)!;return { ...queue, capabilities: queue.capabilities.filter(capability => capability !== "create_task") }; });
  await mount("/tasks/queues/queue-tasks");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Задачи встречи");expect(page!.container.querySelector('header a[href="/seasons/season-1"]')?.textContent).toBe("Осень и зима 2026 · закрыт");
  expect([...page!.container.querySelectorAll("a, button")].some(node => node.textContent?.includes("Создать задачу"))).toBe(false);expect(page!.container.textContent).not.toContain("не создаются");
});
it("a locked service queue without an access request is plain text in the directory and explains itself", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;
  const catalog = await taskQueuesApi.catalog();const queue = catalog.items[0];
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ ...catalog, items: [{ ...queue, key: "KKR", name: "Контроль заполнения ККР", access: "locked", can_request_access: false, capabilities: [] }] });
  // A locked queue is listed under «Все»: by default the directory shows the user's own queues.
  await mount("/tasks/queues?access=all", "organizer");
  const row = page!.container.querySelector('table[aria-label="Список очередей"] tbody tr')!;
  expect(row.textContent).toContain("Контроль заполнения ККР");expect(row.querySelector("a")).toBeNull();expect(row.hasAttribute("tabindex")).toBe(false);
  await act(async () => (row as HTMLElement).click());expect(page!.container.querySelector("h1")?.textContent).toBe("Очереди");
  await page!.cleanup();
  for (const [key, text] of [["KKR", "служебная очередь контроля ККР"], ["WEBSUPPORT", "очередь поддержки сайта"]] as const) {
    vi.spyOn(taskQueuesApi, "get").mockRejectedValue(new ApiError("Нет доступа к очереди", 403, "queue_access_required", { queue: { queue_id: queue.queue_id, name: key, key }, can_request_access: false }));
    await mount(`/tasks/queues/${queue.queue_id}`, "organizer");
    expect(page!.container.textContent).toContain(text);expect(page!.container.textContent).not.toContain("Доступ подтверждает её владелец");expect(page!.container.textContent).not.toContain("Запрос доступа сейчас недоступен");
    expect(!!page!.container.querySelector('a[href="/support"]')).toBe(key === "WEBSUPPORT");
    await page!.cleanup();
  }
  page = undefined;
});
it("lists only the user's own queues by default and keeps the access choice in the URL", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;transport.state.queues[0].owner = transport.state.people[3];
  function Location() { return <output data-location>{useLocation().search}</output>; }
  page = await mountWorkspace(<><Routes><Route path="/tasks/queues" element={<TaskQueuesPage />} /></Routes><Location /></>, { path: "/tasks/queues", role: "organizer" });await waitForPage(page);
  const select = [...page.container.querySelectorAll("select")].find(node => node.closest("label")?.textContent?.startsWith("Доступ"))!;
  expect(select.value).toBe("granted");expect(page.container.querySelector('a[href="/tasks/queues/queue-tasks"]')).toBeNull();
  await change(select, "all");
  expect(page.container.querySelector("[data-location]")?.textContent).toBe("?access=all");expect(page.container.querySelector('a[href="/tasks/queues/queue-tasks"]')).not.toBeNull();
});
it("offers a way back from a queue that does not exist", async () => {
  transport = installMockTransport("organizer", { delay: 0 });vi.spyOn(taskQueuesApi, "get").mockRejectedValue(new ApiError("Объект не найден", 404, "not_found"));
  await mount("/tasks/queues/queue-missing", "organizer");
  expect(page!.container.textContent).toContain("Очередь не найдена.");
  expect([...page!.container.querySelectorAll("a")].find(link => link.textContent === "К очередям")?.getAttribute("href")).toBe("/tasks/queues");
});
it("persists an access request from the denied screen without loading tasks", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;transport.state.queues[0].owner = transport.state.people[3];
  const list = vi.spyOn(tasksApi, "listPage");await mount("/tasks/queues/queue-tasks", "organizer");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Нет доступа к очереди");
  // The task read starts with the queue's (PF-14) and is refused with the queue's own answer: no tasks load.
  expect(list).toHaveBeenCalledOnce();await expect(list.mock.results[0].value).rejects.toMatchObject({ status: 403, code: "queue_access_required" });
  const request = vi.spyOn(taskQueuesApi, "requestAccess");await change(page!.container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')!, "Хочу помочь с задачами");
  await submit(button("Запросить доступ").closest("form")!);await waitForPage(page!);
  expect(request).toHaveBeenCalledWith("queue-tasks", "Хочу помочь с задачами");expect(page!.container.textContent).toContain("Ваш запрос ожидает решения владельца");expect(page!.container.querySelector("table")).toBeNull();
  expect(list).toHaveBeenCalledOnce();
});
it("pins a queue on its page while clearing optional filters", async () => {
  transport = installMockTransport("leader", { delay: 0 });const list = vi.spyOn(tasksApi, "listPage");
  await mount("/tasks/queues/queue-tasks?mine=true&status=assigned&q=материалы");
  expect(page!.container.querySelector("h1")?.textContent).toBe("Задачи встречи");expect(page!.container.querySelector('[aria-label="Навигация очереди"]')?.textContent).toContain("Очереди");expect(list).toHaveBeenCalledWith(expect.objectContaining({ queue_id: "queue-tasks", q: "материалы", status: "assigned" }), expect.any(AbortSignal));
  await act(async () => button("Сбросить все").click());await waitForPage(page!);
  const queueCall = list.mock.calls.filter(([params]) => params && "queue_id" in params).at(-1)![0];expect(queueCall).toMatchObject({ queue_id: "queue-tasks" });expect(queueCall).not.toHaveProperty("q");expect(page!.container.querySelectorAll("h1")).toHaveLength(1);expect(page!.container.querySelector('[aria-label="Очередь"]')).toBeNull();
});
it("omits the repeated team column inside a team queue and inactive paging on a single page", async () => {
  transport = installMockTransport("leader", { delay: 0 });
  vi.spyOn(tasksApi, "listPage").mockImplementation(async () => ({ items: [createFixtures("leader").tasks[0]], next_cursor: null, total: 1, scopes: [], assignees: [] }));
  await mount("/tasks/queues/queue-tasks");
  const headers = [...page!.container.querySelectorAll("thead th")].map(th => th.textContent?.trim());
  expect(headers).not.toContain("Команда");expect(headers).toContain("Исполнители");expect(page!.container.querySelector("td[data-label='Команда']")).toBeNull();
  expect(page!.container.textContent).toContain("На странице: 1");expect(button("Назад")).toBeUndefined();expect(button("Далее")).toBeUndefined();
});
it("sends the owner's exact request revision and hides controls for participants", async () => {
  transport = installMockTransport("leader", { delay: 0 });const fixture = createFixtures("leader");
  const item: TaskQueueAccessRequest = { request_id: "request-local", user: fixture.people[0], message: "Совместная работа", status: "pending", created_at: "2026-10-27T12:00:00Z", revision: 4, capabilities: ["approve_queue_access", "reject_queue_access"] };
  vi.spyOn(taskQueuesApi, "requests").mockImplementation(async () => ({ items: [{ ...item }], next_cursor: null }));
  const decide = vi.spyOn(taskQueuesApi, "decide").mockImplementation(async () => { item.status = "approved";item.revision++;item.capabilities = ["revoke_queue_access"];return { ...item }; });
  await mount("/tasks/queues/queue-tasks");await submit(button("Одобрить доступ").closest("form")!);await waitForPage(page!);
  expect(decide).toHaveBeenCalledWith("queue-tasks", "request-local", "approve", 4);expect(page!.container.textContent).toContain("Доступ одобрен");expect(button("Отозвать доступ")).toBeDefined();
  await page!.cleanup();page = undefined;transport.restore();transport = undefined;vi.restoreAllMocks();transport = installMockTransport("organizer", { delay: 0 });await mount("/tasks/queues/queue-tasks", "organizer");expect(page!.container.textContent).not.toContain("Настройки очереди и доступ");
});
it("validates a key of a leading Latin letter and capitals or digits, upper-cases it while typed, keeps service keys reserved", async () => {
  transport = installMockTransport("leader", { delay: 0 });await mount("/tasks/queues");await act(async () => button("Создать очередь").click());await waitForPage(page!);const create = vi.spyOn(taskQueuesApi, "create");
  const key = () => page!.container.querySelector<HTMLInputElement>('input[name="key"]')!, send = async () => { await submit(page!.container.querySelector<HTMLFormElement>('dialog form')!);await waitForPage(page!); };
  expect(page!.container.textContent).toContain("Латинские заглавные буквы A–Z и цифры, первым символом — буква");
  await change(page!.container.querySelector<HTMLInputElement>('input[name="name"]')!, "Веб-сайт");
  // 'Т1' starts with a Cyrillic Т.
  for (const wrong of ["IT WEB-2", "1TWEB", "T-1", "\u04221"]) {
    await change(key(), wrong);await send();
    expect(create).not.toHaveBeenCalled();expect(page!.container.textContent).toContain("Ключ начинается с латинской буквы и содержит только латинские буквы A–Z и цифры");
  }
  await change(key(), "kkr");expect(key().value).toBe("KKR");await send();
  expect(create).not.toHaveBeenCalled();expect(page!.container.textContent).toContain("Ключ KKR зарезервирован для служебной очереди");
  await change(key(), "it2web");expect(key().value).toBe("IT2WEB");await send();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Веб-сайт", key: "IT2WEB", is_private: false }));expect(page!.container.querySelector("h1")?.textContent).toBe("Веб-сайт");
  const wire = transport!.adapter.history.post.find(request => request.url?.endsWith("/task-queues"))!;
  const body = JSON.parse(wire.data);expect(body.scope).toEqual({ kind: "event", id: transport!.state.events[0].event_id });
  expect(transport!.state.queues.find(q => q.key === "IT2WEB")?.owner?.user_id).toBe(transport!.state.session.user_id);
});
it("keeps the caret where a lower-case letter is typed inside the key", async () => {
  transport = installMockTransport("leader", { delay: 0 });await mount("/tasks/queues");await act(async () => button("Создать очередь").click());await waitForPage(page!);
  const key = page!.container.querySelector<HTMLInputElement>('input[name="key"]')!, setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await change(key, "ITWEB");
  // What a browser leaves after «x» is typed between IT and WEB: the raw letter and the caret behind it.
  await act(async () => { setValue.call(key, "ITxWEB");key.setSelectionRange(3, 3);key.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(key.value).toBe("ITXWEB");expect([key.selectionStart, key.selectionEnd]).toEqual([3, 3]);
  await act(async () => { setValue.call(key, "ITXyWEB");key.setSelectionRange(4, 4);key.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(key.value).toBe("ITXYWEB");expect(key.selectionStart).toBe(4);
});
it("removes only the queue filter in the global task list", async () => {
  transport = installMockTransport("leader", { delay: 0 });const list = vi.spyOn(tasksApi, "listPage");await mount("/tasks?queue_id=queue-tasks&mine=true");
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ queue_id: "queue-tasks", mine: "true" }), expect.any(AbortSignal));await act(async () => page!.container.querySelector<HTMLButtonElement>('[aria-label="Убрать фильтр: Очередь"]')!.click());await waitForPage(page!);
  expect(list.mock.lastCall?.[0]).not.toHaveProperty("queue_id");expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ mine: "true" }), expect.any(AbortSignal));
});

it("renders the requested queue columns while ordinary readers cannot create a queue", async () => {
  transport = installMockTransport("organizer", { delay: 0 });await mount("/tasks/queues", "organizer");
  expect([...page!.container.querySelectorAll("thead th")].map(node => node.textContent)).toEqual(["Имя очереди", "Ключ очереди", "Команда и сезон", "Владелец очереди"]);
  expect(page!.container.querySelector('tr a[href^="/contacts/"] img')).not.toBeNull();
  expect(button("Создать очередь")).toBeUndefined();expect(page!.container.querySelector("dialog")).toBeNull();
  await expect(taskQueuesApi.create({ name: "Своя очередь", key: "SELFQUEUE", scope: { kind: "block", id: transport!.state.blocks[0].block_id }, is_private: false })).rejects.toMatchObject({ status: 403 });
  await expect(taskQueuesApi.create({ name: "Без источника", key: "UNSCOPED", is_private: false })).rejects.toMatchObject({ status: 422 });
});
