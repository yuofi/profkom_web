// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { taskQueuesApi } from "../../utils/api/taskQueues.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { TaskQueuePage, TaskQueuesPage } from "./TaskQueuePages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });

it("creates a queue from a catalog scope with display metadata, persists its owner and assigns its key to tasks", async () => {
  const owner = await liveParticipant("queue-create-owner");
  const session = await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  let season = seasons.find(item => item.state === "open");
  if (!season) {
    const planned = seasons.find(item => item.state === "planned") ?? await seasonsApi.create({ title: "Queue creation", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    const result = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });season = "season" in result ? result.season : result;
  }
  const event = await eventsApi.create({ season_id: season.season_id, title: "Создание очередей через интерфейс", description: richText() });
  const team = await eventsApi.createSubevent(event.event_id, { title: `Команда очередей ${crypto.randomUUID()}`, description: richText() });
  await eventsApi.organizers(team.subevent_id, [owner.user_id], { expected_revision: team.revision });
  const catalogScope = (await taskQueuesApi.catalog()).create_scopes?.find(scope => scope.kind === "subevent" && scope.id === team.subevent_id);
  expect(catalogScope).toMatchObject({ kind: "subevent", id: team.subevent_id, title: team.title });

  // Spy on the actual API wrapper, preserving its real HTTP request and strict server validation.
  const create = vi.spyOn(taskQueuesApi, "create");
  page = await mountWorkspace(<Routes><Route path="/tasks/queues" element={<TaskQueuesPage />} /><Route path="/tasks/queues/:id" element={<TaskQueuePage />} /></Routes>, { path: "/tasks/queues", session });
  await waitForPage(page, () => !!page!.container.querySelector("details"));
  const creation = [...page.container.querySelectorAll<HTMLDetailsElement>("details")].find(details => details.querySelector(":scope > summary")?.textContent === "Создать очередь")!;
  expect(creation).toBeDefined();await act(async () => creation.querySelector<HTMLElement>("summary")!.click());
  const scopeSelect = creation.querySelector<HTMLSelectElement>("select")!;
  const option = [...scopeSelect.options].find(item => item.textContent === team.title)!;expect(option).toBeDefined();
  await change(scopeSelect, option.value);await waitForPage(page, () => !!creation.querySelector('select[name="owner"] option[value="' + owner.user_id + '"]'));
  const form = creation.querySelector("form")!;
  const name = `Очередь через UI ${crypto.randomUUID()}`;
  await change(field(form, "name"), name);await change(field(form, "owner"), String(owner.user_id));await change(field(form, "key"), "BAD1");
  await submit(form);await waitForPage(page);
  expect(create).not.toHaveBeenCalled();expect(form.querySelector('[role="alert"]')?.textContent).toContain("Ключ должен содержать только заглавные английские буквы A–Z");

  const key = `U${crypto.randomUUID().replace(/[^a-f]/g, "").slice(0, 9).toUpperCase()}`;
  await change(field(form, "key"), key);await submit(form);await waitForPage(page, () => !!creation.textContent?.includes("Очередь создана."));
  expect(create).toHaveBeenCalledTimes(1);
  const queue = (await taskQueuesApi.catalog()).items.find(item => item.key === key)!;expect(queue).toBeDefined();
  const saved = await taskQueuesApi.get(queue.queue_id);
  expect(saved).toMatchObject({ name, key, owner: { user_id: owner.user_id }, scope: { kind: "subevent", id: team.subevent_id }, access: "granted" });
  const open = [...creation.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === `Открыть ${key}`)!;
  expect(open).toBeDefined();await act(async () => open.click());await waitForPage(page, () => page!.container.querySelector("h1")?.textContent === name);
  expect(page.container.querySelector(`a[href="/contacts/${owner.user_id}"]`)?.textContent).toContain(saved.owner!.display_name);

  const task = await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: team.subevent_id }, queue_id: saved.queue_id, title: "Проверка ключа новой очереди", description: richText("Создано после формы очереди"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: owner.user_id, hours: 2 }] });
  expect(task.queue?.queue_id).toBe(saved.queue_id);expect(task.task_key).toBe(`${key}-1`);
  await page.cleanup();page = undefined;
  await liveLogin(owner.email);
  const owned = await taskQueuesApi.get(saved.queue_id);expect(owned.owner?.user_id).toBe(owner.user_id);expect(owned.capabilities).toContain("manage_queue");expect(owned.capabilities).toContain("view_queue_requests");
});
