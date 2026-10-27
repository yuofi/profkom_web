// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { filesApi } from "../../utils/api/files.api";
import { api } from "../../utils/api/index";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { TaskPage } from "./TaskPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

it("an assignee uploads and submits a file without text; foreign and revoked users cannot upload or download it", async () => {
  const worker = await liveParticipant("file-only-assignee");
  const foreign = await liveParticipant("file-only-foreign");
  await liveLogin();
  let season = (await seasonsApi.list()).items.find((s) => s.state === "open");
  if (!season) {
    const planned = (await seasonsApi.list()).items.find((s) => s.state === "planned") ?? await seasonsApi.create({
      title: "File-only submission", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 20 * 86400000).toISOString(),
    });
    const opened = await seasonsApi.command(planned.season_id, "open", { expected_revision: planned.revision });
    season = "season" in opened ? opened.season : opened;
  }
  const event = await eventsApi.create({ season_id: season.season_id, title: "File-only assignment", description: richText() });
  let subevent = await eventsApi.createSubevent(event.event_id, { title: "File-only team", description: richText() });
  subevent = await eventsApi.organizers(subevent.subevent_id, [worker.user_id], { expected_revision: subevent.revision });
  const task = await tasksApi.create({ season_id: season.season_id, scope: { kind: "subevent", id: subevent.subevent_id }, title: "Сдать только файл", description: richText(), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: worker.user_id, hours: 1 }] });
  const owner = { owner_kind: "task", owner_id: task.task_id, purpose: "submission" };
  await liveLogin(foreign.email);
  await expect(filesApi.intent({ ...owner, name: "result.txt", mime_type: "text/plain", size_bytes: 12 })).rejects.toMatchObject({ status: 403 });
  const session = await liveLogin(worker.email);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });
  await waitForPage(page);
  const open = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Сдать результат")!;
  await act(async () => open.click());await waitForPage(page);
  const input = page.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input).not.toBeNull();
  const file = new File(["Synthetic file-only result"], "result.txt", { type: "text/plain" });
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForPage(page, () => !!page!.container.textContent?.includes("result.txt") && !page!.container.textContent?.includes("Загрузка файла:"));
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
  const send = Array.from(page.container.querySelectorAll("button")).find((button) => button.textContent === "Отправить результат")!;
  const form = send.closest("form")!;
  expect((form.querySelector('[name="body"]') as HTMLTextAreaElement).value).toBe("");
  await submit(form);
  await waitForPage(page, () => !page!.container.querySelector('input[type="file"]'));
  const saved = await tasksApi.get(task.task_id);
  const result = saved.submissions!.at(-1)!;
  expect(saved.status).toBe("submitted");
  expect(result.text.body).toBe("");
  expect(result.files).toHaveLength(1);
  const attached = result.files[0];
  const { download_url } = await filesApi.download(attached.file_id);
  const response = await api.get(download_url.slice("/api".length), { responseType: "text" });
  expect(response.data).toBe("Synthetic file-only result");
  await page.cleanup(); page = undefined;
  await liveLogin();
  const current = await eventsApi.subevent(subevent.subevent_id);
  await eventsApi.organizers(current.subevent_id, [], { expected_revision: current.revision });
  await liveLogin(worker.email);
  await expect(filesApi.intent({ ...owner, name: "result.txt", mime_type: "text/plain", size_bytes: 12 })).rejects.toMatchObject({ status: 403 });
  await expect(filesApi.download(attached.file_id)).rejects.toMatchObject({ status: 404 });
});
