// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { filesApi } from "../../utils/api/files.api";
import { richText, type FileRef } from "../../utils/api/contract";
import { ApiError } from "../../utils/api/request";
import { TaskCreateForm, TrackerTaskCreatePage } from "./TaskCreateForm";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
async function chooseParent(title: string) {
  const input = page!.container.querySelector<HTMLInputElement>('[role="combobox"][name="parent_task"]')!;
  await act(async () => input.focus());await change(input, title);await waitForPage(page!, () => !!page!.container.querySelector('[role="option"]'));
  const option = [...page!.container.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent?.includes(title))!;
  expect(option).toBeDefined();await act(async () => option.click());await waitForPage(page!);
}
it("opens a blank task-like editor with parameters, permits no assignees and omits accounting fields", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const queue = { ...mock.state.queues[0], queue_id: "scoped", name: "Очередь блока", key: "IND", scope: { kind: "block" as const, id: mock.state.blocks[0].block_id }, capabilities: ["create_task"] };mock.state.queues.push(queue);
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/tasks/new?queue_id=scoped" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));const form = page.container.querySelector("form")!;
  expect(field(page.container, "title").value).toBe("");expect(form.querySelector('[name="title"]')).toBeNull();expect(field(form, "description").value).toBe("");expect(field(form, "queue").value).toBe(queue.queue_id);
  expect(form.querySelector('[name="hours"]')).toBeNull();expect(form.querySelector('[name="creative"]')).toBeNull();expect(form.querySelector('[aria-label="Параметры новой задачи"]')).not.toBeNull();
  await change(field(page.container, "title"), "Новая свободная задача");await change(field(form, "deadline"), "2026-10-29T18:00");await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача") || !!page!.container.querySelector('[role="alert"]'));expect(page!.container.textContent).toContain("Созданная задача");
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ queue_id: queue.queue_id, assignees: [], watcher_user_ids: [], file_ids: [], description: richText("") }));expect(create.mock.calls[0][0]).not.toHaveProperty("scope");
});
it("hints the deadline range and shows the server's refusal at the deadline field", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const create = vi.spyOn(tasksApi, "create").mockRejectedValue(new ApiError("Dates", 422, "deadline_out_of_range", { deadline_at: "out_of_range", earliest: "2026-10-31T09:00:00+00:00", latest: "2026-12-31T20:59:59+00:00" }));
  page = await mountWorkspace(<TaskCreateForm queueId={mock.state.queues[0].queue_id} />);await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!, deadline = field(form, "deadline") as HTMLInputElement;
  expect(deadline.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  await waitForPage(page, () => !!deadline.max);expect(mock.state.seasons.map(season => new Date(Date.parse(season.ends_at) + 3 * 3600_000).toISOString().slice(0, 16))).toContain(deadline.max);
  await change(field(page.container, "title"), "Задача с поздним дедлайном");await change(deadline, "2027-06-01T12:00");await submit(form);await waitForPage(page);
  expect(create).toHaveBeenCalledOnce();expect(deadline.getAttribute("aria-invalid")).toBe("true");
  const message = document.getElementById(deadline.getAttribute("aria-describedby")!)!;expect(message.textContent?.replace(/\u00a0/g, " ")).toContain("не позже 31 дек. 2026 г., 23:59 (конец сезона)");
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Исправьте дедлайн задачи");
  await change(deadline, "2026-11-30T12:00");expect(deadline.hasAttribute("aria-invalid")).toBe(false);
});
it("a season past its end gives no contradictory deadline range and explains it", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const ended = new Date(Date.now() - 3600_000).toISOString();mock.state.seasons.forEach(season => { season.ends_at = ended; });
  const create = vi.spyOn(tasksApi, "create").mockRejectedValue(new ApiError("Dates", 422, "season_ended", { deadline_at: "out_of_range", latest: ended }));
  page = await mountWorkspace(<TaskCreateForm queueId={mock.state.queues[0].queue_id} />);await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!, deadline = field(form, "deadline") as HTMLInputElement;
  await waitForPage(page, () => !!deadline.max);expect(deadline.min).toBe("");
  expect(deadline.closest("label")!.textContent).toContain("дедлайн в нём поставить нельзя");
  await change(field(page.container, "title"), "Задача в закончившемся сезоне");await change(deadline, deadline.max);await submit(form);await waitForPage(page);
  expect(create).toHaveBeenCalledOnce();expect(deadline.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(deadline.getAttribute("aria-describedby")!)!.textContent).toContain("Оставьте дедлайн пустым");
});
it("keeps typed Markdown when selecting another queue and has one searchable parent selector", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.queues.push({ ...mock.state.queues[0], queue_id: "extra", name: "Другая очередь", key: "EXTRA" });
  page = await mountWorkspace(<TaskCreateForm queueId={mock.state.queues[0].queue_id} />);await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;await change(field(form, "description"), "Черновик $x^2$\n\n| A | B |\n| - | - |");await change(field(form, "queue"), "extra");await waitForPage(page);
  expect(field(form, "description").value).toContain("Черновик $x^2$");expect(page.container.querySelectorAll('[role="combobox"][name="parent_task"]')).toHaveLength(1);expect(page.container.textContent).not.toContain("Поиск родительской задачи");
});
it("binds an unbound attachment and a parent from another queue when creating", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.queues.push({ ...mock.state.queues[0], queue_id: "extra", name: "Подготовка", key: "PREP" });
  const parent = mock.state.tasks[0], file: FileRef = { file_id: "draft-file", name: "plan.txt", mime_type: "text/plain", size_bytes: 5 };
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue(file), create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/new" element={<TaskCreateForm queueId="extra" />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/new" });await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!;await change(field(page.container, "title"), "Проверить план");await change(field(form, "deadline"), "2026-10-29T18:00");await chooseParent(parent.title);
  const input = form.querySelector<HTMLInputElement>('input[type="file"]')!, blob = new File(["draft"], "plan.txt", { type: "text/plain" });
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [blob] });input.dispatchEvent(new Event("change", { bubbles: true })); });await waitForPage(page);
  expect(upload).toHaveBeenCalledWith(blob, { owner_kind: "task", owner_id: undefined, purpose: "attachment" }, expect.any(Function));
  await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача") || !!page!.container.querySelector('[role="alert"]'));expect(page!.container.textContent).toContain("Созданная задача");expect(create).toHaveBeenCalledWith(expect.objectContaining({ queue_id: "extra", parent_task_id: parent.task_id, file_ids: [file.file_id] }));
});
it("clears a chosen parent when the creation season changes", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const season = mock.state.seasons.find(item => item.state === "open")!, block = mock.state.blocks.find(item => item.capabilities.includes("create_task"))!;
  const parent = { ...mock.state.tasks[0], task_id: "block-parent", season_id: season.season_id, scope: { kind: "block" as const, id: block.block_id }, title: "Родитель блока" };mock.state.tasks.push(parent);
  mock.state.seasons.push({ ...season, season_id: "another-open", title: "Следующий сезон" });
  page = await mountWorkspace(<TaskCreateForm scope={parent.scope} />);await waitForPage(page, () => !!page!.container.querySelector("form"));await chooseParent(parent.title);
  expect(field(page.container, "parent_task_id").value).toBe(parent.task_id);await change(field(page.container, "season"), "another-open");await waitForPage(page);
  expect(field(page.container, "parent_task_id").value).toBe("");
});
it("GL-07: a create whose answer was lost is repeated with the same key and makes one task", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const queue = { ...mock.state.queues[0], queue_id: "scoped", name: "Очередь блока", key: "IND", scope: { kind: "block" as const, id: mock.state.blocks[0].block_id }, capabilities: ["create_task"] };mock.state.queues.push(queue);
  const original = tasksApi.create, before = mock.state.tasks.length;
  // The server committed the first request, but the answer did not arrive in time.
  const create = vi.spyOn(tasksApi, "create").mockImplementationOnce(async data => { await original(data);throw Object.assign(new Error("timeout of 60000ms exceeded"), { isAxiosError: true, code: "ECONNABORTED", config: {} }); });
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/tasks/new?queue_id=scoped" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));const form = page.container.querySelector("form")!;
  await change(field(page.container, "title"), "Задача после таймаута");await change(field(form, "deadline"), "2026-10-29T18:00");
  await submit(form);await waitForPage(page, () => !!page!.container.querySelector('[role="alert"]'));
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Сервер долго отвечает. Проверьте результат перед повтором.");
  await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача"));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0].idempotency_key).toBe(create.mock.calls[0][0].idempotency_key);
  expect(mock.state.tasks.filter(task => task.title === "Задача после таймаута")).toHaveLength(1);expect(mock.state.tasks).toHaveLength(before + 1);
});
it("GL-32: «Назад» from a created task returns to the list, not to the spent form", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const queue = { ...mock.state.queues[0], queue_id: "scoped", name: "Очередь блока", key: "IND", scope: { kind: "block" as const, id: mock.state.blocks[0].block_id }, capabilities: ["create_task"] };mock.state.queues.push(queue);
  function Created() { const navigate = useNavigate();return <><p>Созданная задача</p><button type="button" onClick={() => navigate(-1)}>Назад</button></>; }
  page = await mountWorkspace(<Routes><Route path="/tasks" element={<p>Список задач</p>} /><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<Created />} /></Routes>, { history: ["/tasks"], path: "/tasks/new?queue_id=scoped" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));const form = page.container.querySelector("form")!;
  await change(field(page.container, "title"), "Задача с возвратом");await change(field(form, "deadline"), "2026-10-29T18:00");
  await submit(form);await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача"));
  await act(async () => [...page!.container.querySelectorAll("button")].find(node => node.textContent === "Назад")!.click());await waitForPage(page);
  expect(page.container.textContent).toContain("Список задач");expect(page.container.querySelector("form")).toBeNull();
});
it("returns an event draft to its event and names each parameter once", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /></Routes>, { path: "/tasks/new?scope_kind=event&scope_id=event-1" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));
  const links = [...page.container.querySelectorAll<HTMLAnchorElement>("a")].filter(link => ["День математика", "Отмена"].includes(link.textContent ?? ""));
  expect(links.map(link => link.textContent)).toEqual(["День математика", "Отмена", "Отмена"]);
  expect(links.every(link => link.getAttribute("href") === "/events/event-1")).toBe(true);
  const parameters = page.container.querySelector('[aria-label="Параметры новой задачи"]')!;
  expect(parameters.textContent).toContain("Определяется мероприятием.");expect(parameters.textContent).toContain("Осень и зима 2026");
  expect(parameters.textContent).not.toContain("Выбрать исполнителей");expect(parameters.textContent).not.toContain("Выбрать наблюдателей");
  for (const name of ["Исполнители", "Наблюдатели"]) {
    const heading = [...parameters.querySelectorAll("h3")].find(node => node.textContent === name)!;
    expect(parameters.querySelector(`[role="combobox"][aria-labelledby="${heading.id}"]`)).not.toBeNull();
  }
  const file = page.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(file.closest("label")?.textContent).toContain("Прикрепить файлы");
});
it("names each queue's team in the select and refuses a queue whose event season is closed (owner 2026-11-08, В8)", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.seasons.find(season => season.season_id === "season-1")!.state = "closed";
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /></Routes>, { path: "/tasks/new?queue_id=queue-tasks" });
  await waitForPage(page, () => !!page!.container.querySelector("#task-queue-notice"));
  const form = page.container.querySelector("form")!, select = field(form, "queue") as HTMLSelectElement;
  expect([...select.options].find(option => option.value === "queue-tasks")?.textContent).toBe("TASK · Задачи встречи · Лекции и встречи · сезон закрыт");
  expect([...select.options].find(option => option.value === `queue-${mock!.state.blocks[0].block_id}`)?.textContent).toBe(`INFO · ${mock.state.blocks[0].name} · ${mock.state.blocks[0].name}`);
  const notice = "Сезон «Осень и зима 2026» закрыт — новые задачи в этой очереди создать нельзя.";
  expect(page.container.querySelector("#task-queue-notice")?.textContent).toBe(notice);expect(select.getAttribute("aria-describedby")).toBe("task-queue-notice");
  await change(field(page.container, "title"), "Задача в закрытом сезоне");await submit(form);await waitForPage(page);
  expect(create).not.toHaveBeenCalled();expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(notice);
  await change(select, `queue-${mock.state.blocks[0].block_id}`);await waitForPage(page, () => !page!.container.querySelector("#task-queue-notice"));expect(select.hasAttribute("aria-describedby")).toBe(false);
});
it("without a chosen queue starts with one that takes a task now (owner 2026-11-08, В8)", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.seasons.find(season => season.season_id === "season-1")!.state = "closed";
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /></Routes>, { path: "/tasks/new" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));
  const select = field(page.container.querySelector("form")!, "queue") as HTMLSelectElement;
  // The catalogue lists the closed season's event queue first; it stays in the select but is not chosen.
  expect(select.options[0].value).toBe("queue-tasks");expect(select.value).toBe(`queue-${mock.state.blocks[0].block_id}`);
  expect(page.container.querySelector("#task-queue-notice")).toBeNull();
});
it("offers chair work only an open season, also after another queue's planned one was chosen", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.queues.push({ ...mock.state.queues[0], queue_id: "free", name: "Общая очередь", key: "FREE", scope: null }, { ...mock.state.queues[0], queue_id: "chair-work", name: "Работа председателя", key: "CHAIR", scope: { kind: "chair", id: "chair" } });
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /><Route path="/tasks/:id" element={<p>Созданная задача</p>} /></Routes>, { path: "/tasks/new?queue_id=free" });
  await waitForPage(page, () => !!page!.container.querySelector("form"));
  const form = page.container.querySelector("form")!, season = () => field(form, "season") as HTMLSelectElement;
  expect([...season().options].map(option => option.value)).toContain("season-next");await change(season(), "season-next");expect(season().value).toBe("season-next");
  await change(field(form, "queue"), "chair-work");await waitForPage(page);
  expect([...season().options].map(option => option.value)).toEqual(["season-previous", "season-1"]);expect(season().value).toBe("season-previous");
  await change(field(page.container, "title"), "Работа председателя в открытом сезоне");await submit(form);
  await waitForPage(page, () => !!page!.container.textContent?.includes("Созданная задача") || !!page!.container.querySelector('[role="alert"]'));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ queue_id: "chair-work", season_id: "season-previous" }));
});
it("refuses chair work without an open season before asking the server", async () => {
  mock = installMockTransport("chair", { delay: 0 });mock.state.seasons.forEach(season => { if (season.state === "open") season.state = "closed"; });
  mock.state.queues.push({ ...mock.state.queues[0], queue_id: "chair-work", name: "Работа председателя", key: "CHAIR", scope: { kind: "chair", id: "chair" } });
  const create = vi.spyOn(tasksApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TrackerTaskCreatePage />} /></Routes>, { path: "/tasks/new?queue_id=chair-work" });
  await waitForPage(page, () => !!page!.container.querySelector("#task-queue-notice"));
  const form = page.container.querySelector("form")!;
  expect([...(field(form, "season") as HTMLSelectElement).options]).toHaveLength(0);
  expect(page.container.querySelector("#task-queue-notice")?.textContent).toBe("Сейчас нет открытого сезона — новые задачи в этой очереди создать нельзя.");
  await change(field(page.container, "title"), "Работа без открытого сезона");await submit(form);await waitForPage(page);
  expect(create).not.toHaveBeenCalled();expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
});
