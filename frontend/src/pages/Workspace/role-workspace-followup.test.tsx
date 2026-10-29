// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, pick, submit, waitForPage } from "../../test/workspace";
import { BlockPage, BlocksPage } from "./MembershipPages";
import { OrganizationTree } from "./OrganizationTree";
import { MeritForm } from "./MeritPages";
import { TrackerListPage } from "./TrackerList";
import { TaskCreateForm } from "./TaskCreateForm";
import { WorkspaceLayout } from "../../components/Workspace/WorkspaceLayout";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { directoryApi } from "../../utils/api/directory.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { eventsApi } from "../../utils/api/events.api";
import { membershipApi } from "../../utils/api/membership.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { ApiError } from "../../utils/api/request";
import { emptyCriteria, richText, type Merit } from "../../utils/api/contract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text || item.getAttribute("aria-label") === text)!;
async function click(element: HTMLElement) { expect(element).toBeDefined();await act(async () => element.click());await waitForPage(page!); }
async function openBlock(role: "chair" | "organizer" = "chair") {
  const block = mock!.state.blocks[0];
  page = await mountWorkspace(<Routes><Route path="/blocks/:id" element={<BlockPage />} /></Routes>, { path: `/blocks/${block.block_id}`, role });await waitForPage(page);return block;
}

it.each(["member", "master", "deputy"])("does not offer joining an existing %s's block", async relation => {
  mock = installMockTransport("organizer", { delay: 0 });const b = mock.state.blocks[0], user = mock.state.user;
  b.members = relation === "member" ? [{ user, block_category: "member" }] : [];
  if (relation === "master") b.master!.user = user;
  if (relation === "deputy") b.master!.deputy_user_ids = [user.user_id!];
  await openBlock("organizer");
  expect(button(page!.container, "Подать заявку в блок")).toBeUndefined();
  expect(mock.adapter.history.post.filter(request => request.url === "/block-requests")).toHaveLength(0);
});
it("a scoped HR curator still applies for ordinary membership independently", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const b = mock.state.blocks[0];b.members = [];b.hr = mock.state.user;b.master!.deputy_user_ids = [];
  await openBlock("organizer");expect(button(page!.container, "Подать заявку в блок")).toBeDefined();
});

it.each([true, false])("keeps requests inside blocks and labels the entry by capability: %s", async granted => {
  mock = installMockTransport("organizer", { delay: 0 });const session = { ...mock.state.session, capabilities: granted ? ["view_block_requests"] : [] };
  page = await mountWorkspace(<Routes><Route element={<WorkspaceLayout />}><Route path="/blocks" element={<BlocksPage />} /></Route></Routes>, { role: "organizer", path: "/blocks", session });await waitForPage(page);
  expect(page.container.querySelector('nav a[href="/blocks/requests"]')).toBeNull();
  expect(page.container.querySelector('a[href="/blocks/requests"]')?.textContent).toBe(granted ? "Заявки в блоки" : "Мои заявки и решения");
  expect(page.container.textContent).toContain(granted ? "Заявки в блоки" : "Мои заявки и решения");
});

it("shows the HR curator separately from membership and finds their name in the tree", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const b = mock.state.blocks[0], hr = { user_id: 918, display_name: "Кураторова Светлана", avatar_url: "/avatars/leaf.svg" };b.hr = hr;
  page = await mountWorkspace(<OrganizationTree blocks={[b]} leadership={{ chair: null, deputies: [], revision: 1, capabilities: [] }} people={[]} />);await waitForPage(page);
  await change(page.container.querySelector<HTMLInputElement>('input[type="search"]')!, "Кураторова");
  const staff = page.container.querySelector('section[aria-label^="Руководство блока"]')!;
  expect(staff.textContent).toContain("HR");expect(staff.querySelector(`a[href="/contacts/${hr.user_id}"] img`)).not.toBeNull();
  expect(page.container.querySelector(`div[class*="members"] a[href="/contacts/${hr.user_id}"]`)).toBeNull();
});

it("assigns and removes HR through a versioned person picker without adding ordinary membership", async () => {
  mock = installMockTransport("chair", { delay: 0 });const b = await openBlock(), before = structuredClone(b.members), hr = mock.state.people[2];
  const command = vi.spyOn(membershipApi, "assignHr");await click(button(page!.container, "Изменить HR блока"));
  let dialog = document.querySelector<HTMLDialogElement>("dialog")!;await change(field(dialog, "user"), String(hr.user_id));await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(command).toHaveBeenLastCalledWith(b.block_id, { expected_revision: 1, user_id: hr.user_id });expect(b.hr?.user_id).toBe(hr.user_id);expect(b.members).toEqual(before);
  await click(button(page!.container, "Изменить HR блока"));dialog = document.querySelector<HTMLDialogElement>("dialog")!;await click(dialog.querySelector<HTMLButtonElement>('[data-field-name="user"] [data-selected-value] button')!);await submit(dialog.querySelector("form")!);await waitForPage(page!);
  expect(command).toHaveBeenLastCalledWith(b.block_id, { expected_revision: 2, user_id: null });expect(b.hr).toBeNull();expect(b.members).toEqual(before);
});
it("retains HR selection on a version conflict and exposes no editing pencil without permission", async () => {
  mock = installMockTransport("chair", { delay: 0 });const b = await openBlock();await click(button(page!.container, "Изменить HR блока"));
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!, chosen = String(mock.state.people[2].user_id);await change(field(dialog, "user"), chosen);
  vi.spyOn(membershipApi, "assignHr").mockRejectedValue(new ApiError("Changed", 409, "revision_conflict"));await submit(dialog.querySelector("form")!);expect(field(dialog, "user").value).toBe(chosen);
  await page!.cleanup();page = undefined;mock.restore();mock = installMockTransport("organizer", { delay: 0 });mock.state.blocks[0].capabilities = [];await openBlock("organizer");expect(button(page!.container, "Изменить HR блока")).toBeUndefined();expect(b.hr).toBeNull();
});

it("scope candidates include organizers without block membership and parent event heads", async () => {
  mock = installMockTransport("chair", { delay: 0 });const sub = mock.state.subevents[0], organizer = mock.state.people[0], head = mock.state.people[3];
  sub.organizer_user_ids = [organizer.user_id!];sub.leaders = [];mock.state.events[0].leaders = [{ role_assignment_id: "role-parent", user: head, deputy_user_ids: [], revision: 1, capabilities: [] }];
  const original = await directoryApi.contacts();vi.spyOn(directoryApi, "contacts").mockResolvedValue(original.map(person => ({ ...person, in_profcom: false })));
  function Probe() { const members = useScopeMembers({ kind: "subevent", id: sub.subevent_id });return <output>{members.options.map(person => person.value).join(",")}</output>; }
  page = await mountWorkspace(<Probe />);await waitForPage(page);
  expect(page.container.querySelector("output")?.textContent?.split(",").sort()).toEqual([String(organizer.user_id), String(head.user_id)].sort());
});

it.each([false, true])("task creation uses exactly the server's queue candidates, including an empty grant set: %s", async empty => {
  mock = installMockTransport("leader", { delay: 0 });const queue = mock.state.queues[0], organizer = mock.state.people[0];
  const detail = { ...queue, capabilities: ["create_task", "assign_task_others"], assignable_users: empty ? [] : [organizer] };
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ items: [{ ...queue, capabilities: detail.capabilities }], next_cursor: null });
  const queueDetails = vi.spyOn(taskQueuesApi, "get").mockResolvedValue(detail);
  const contacts = vi.spyOn(directoryApi, "contacts");page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TaskCreateForm queueId={queue.queue_id} />} /><Route path="/tasks/:id" element={<p>Открыта созданная задача</p>} /></Routes>, { path: "/tasks/new", role: "leader" });await waitForPage(page);
  const combobox = page.container.querySelector<HTMLInputElement>('[data-field-name="users"] [role="combobox"]')!;await act(async () => combobox.click());
  const options = [...document.querySelectorAll<HTMLElement>('[data-entity-picker-popup] [data-option-value]')].map(item => item.dataset.optionValue);
  expect(options).toEqual(empty ? [] : [String(organizer.user_id)]);expect(contacts).not.toHaveBeenCalled();expect(queueDetails).toHaveBeenCalledWith(queue.queue_id);
  if (!empty) {
    await pick(page.container, "users", String(organizer.user_id));await change(field(page.container, "title"), "Для организатора");await change(field(page.container, "deadline"), "2026-10-29T18:00");
    const create = vi.spyOn(tasksApi, "create");await submit(page.container.querySelector("form")!);await waitForPage(page);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assignees: [{ user_id: organizer.user_id, hours: 0 }] }));
  }
});

it("new completed-work accounting omits reason and includes active recipients without ordinary membership", async () => {
  mock = installMockTransport("chair", { delay: 0 });const person = mock.state.people[0], contacts = await directoryApi.contacts();
  vi.spyOn(directoryApi, "contacts").mockResolvedValue(contacts.map(contact => ({ ...contact, in_profcom: false })));
  page = await mountWorkspace(<MeritForm seasonId="season-1" initialSource="chair_merit" />);await waitForPage(page);
  expect(page.container.querySelector('[name="reason"]')).toBeNull();expect(page.container.textContent).not.toContain("Основание записи");
  await pick(page.container, "users", String(person.user_id));
  for (const [name, value] of Object.entries({ title: "Выполненная помощь", body: "Помощь организатора", assigned: "2026-10-27T10:00", deadline: "2026-10-27T18:00", [`hours_${person.user_id}`]: "2", [`evaluation_${person.user_id}`]: "0" })) await change(field(page.container, name), value);
  const create = vi.spyOn(seasonsApi, "createMerit");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(create).toHaveBeenCalledTimes(1);expect(create.mock.calls[0][0]).not.toHaveProperty("reason");expect(mock.state.merits[0].reason).toBe("Создание записи учёта работы");
});
it("a correction still requires a reason and does not send an empty correction", async () => {
  mock = installMockTransport("chair", { delay: 0 });const merit: Merit = { merit_id: "merit-correction", season_id: "season-1", source_kind: "chair_merit", title: "Записано", description: richText("Работа"), assigned_at: "2026-10-27T07:00:00Z", deadline_at: "2026-10-27T15:00:00Z", criteria: emptyCriteria(), recipients: [], reason: "Создание записи учёта работы", revision: 1, capabilities: ["edit_assessment_inputs"], created_by: mock.state.user, created_at: "2026-10-27T16:00:00Z" };
  page = await mountWorkspace(<MeritForm seasonId="season-1" existing={merit} />);await waitForPage(page);expect(field(page.container, "reason").required).toBe(true);
  const save = vi.spyOn(seasonsApi, "updateMerit");await submit(page.container.querySelector("form")!);expect(save).not.toHaveBeenCalled();
});

it("creates the first scoped task without an existing queue and without a separate queue mutation", async () => {
  mock = installMockTransport("leader", { delay: 0 });const sub = mock.state.subevents[0], organizer = mock.state.people[0];
  sub.capabilities = [...new Set([...sub.capabilities, "create_task", "manage_organizers"])];sub.organizer_user_ids = [organizer.user_id!];
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ items: [], next_cursor: null });const queueCreate = vi.spyOn(taskQueuesApi, "create");
  const create = vi.spyOn(tasksApi, "create").mockResolvedValue({ ...mock.state.tasks[0], task_id: "first-scoped-task" });
  page = await mountWorkspace(<Routes><Route path="/tasks/new" element={<TaskCreateForm scope={{ kind: "subevent", id: sub.subevent_id }} />} /><Route path="/tasks/:id" element={<p>Первая задача создана</p>} /></Routes>, { role: "leader", path: "/tasks/new" });await waitForPage(page);
  expect(page.container.textContent).toContain("Очередь команды по умолчанию");await pick(page.container, "users", String(organizer.user_id));
  await change(field(page.container, "title"), "Первая задача команды");await change(field(page.container, "deadline"), "2026-10-29T18:00");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "subevent", id: sub.subevent_id }, assignees: [{ user_id: organizer.user_id, hours: 0 }] }));
  expect(create.mock.calls[0][0]).not.toHaveProperty("queue_id");expect(queueCreate).not.toHaveBeenCalled();expect(page.container.textContent).toContain("Первая задача создана");
});
it("does not bypass a private default queue and keeps the refused scoped draft", async () => {
  mock = installMockTransport("organizer", { delay: 0 });const sub = mock.state.subevents[0];sub.capabilities = ["create_task"];
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ items: [{ queue_id: "locked-default", key: "LOCKED", name: "Закрытая очередь", access: "locked", capabilities: [], can_request_access: true, access_request_status: null }], next_cursor: null });
  const queueCreate = vi.spyOn(taskQueuesApi, "create"), create = vi.spyOn(tasksApi, "create").mockRejectedValue(new ApiError("Queue access is required", 403, "forbidden"));
  page = await mountWorkspace(<TaskCreateForm scope={{ kind: "subevent", id: sub.subevent_id }} />, { role: "organizer" });await waitForPage(page);
  await change(field(page.container, "title"), "Не потерять при отказе");await change(field(page.container, "deadline"), "2026-10-29T18:00");await submit(page.container.querySelector("form")!);await waitForPage(page);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "subevent", id: sub.subevent_id } }));expect(create.mock.calls[0][0]).not.toHaveProperty("queue_id");expect(queueCreate).not.toHaveBeenCalled();
  expect(field(page.container, "title").value).toBe("Не потерять при отказе");expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
});
it.each(["scope_denied", "explicit_queue"])("does not enable an unauthorized or implicit replacement scope: %s", async reason => {
  mock = installMockTransport("organizer", { delay: 0 });const sub = mock.state.subevents[0];sub.capabilities = reason === "scope_denied" ? [] : ["create_task"];
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ items: [], next_cursor: null });const create = vi.spyOn(tasksApi, "create"), source = vi.spyOn(eventsApi, "subevent");
  page = await mountWorkspace(<TaskCreateForm scope={{ kind: "subevent", id: sub.subevent_id }} queueId={reason === "explicit_queue" ? "unavailable-explicit" : undefined} />, { role: "organizer" });await waitForPage(page);
  expect(page.container.querySelector("form")).toBeNull();expect(create).not.toHaveBeenCalled();if (reason === "explicit_queue") expect(source).not.toHaveBeenCalled();
});

it.each([true, false])("exposes first-task creation from an empty scoped tracker only with the resource capability: %s", async allowed => {
  mock = installMockTransport("leader", { delay: 0 });const sub = mock.state.subevents[0];sub.capabilities = allowed ? ["create_task"] : [];
  vi.spyOn(taskQueuesApi, "catalog").mockResolvedValue({ items: [], next_cursor: null });vi.spyOn(tasksApi, "listPage").mockResolvedValue({ items: [], next_cursor: null, total: 0, scopes: [], assignees: [] });
  page = await mountWorkspace(<TrackerListPage />, { path: `/tasks?scope_kind=subevent&scope_id=${sub.subevent_id}`, role: "leader" });await waitForPage(page);
  const link = [...page.container.querySelectorAll<HTMLAnchorElement>("a")].find(item => item.textContent === "Создать задачу");expect(!!link).toBe(allowed);
  if (allowed) { expect(link!.getAttribute("href")).toContain("scope_kind=subevent");expect(link!.getAttribute("href")).toContain(`scope_id=${sub.subevent_id}`); }
  expect(mock.adapter.history.post).toHaveLength(0);
});
