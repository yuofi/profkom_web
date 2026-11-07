// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { submitTaskResult } from "../../test/taskResults";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { filesApi } from "../../utils/api/files.api";
import { api } from "../../utils/api/index";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { TaskPage } from "./TaskPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

it("an earlier file-only result stays visible to its assignee; foreign and revoked users cannot upload or download it", async () => {
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
  // A task the user cannot read answers like a missing one (GL-24).
  await expect(filesApi.intent({ ...owner, name: "result.txt", mime_type: "text/plain", size_bytes: 12 })).rejects.toMatchObject({ status: 404 });
  const session = await liveLogin(worker.email);
  // The site has no «Сдать результат» any more (owner 2026-11-08, В6); the endpoint stays and an
  // earlier file-only result keeps its own section and its file access.
  const file = new File(["Synthetic file-only result"], "result.txt", { type: "text/plain" });
  const uploaded = await filesApi.upload(file, owner);
  await submitTaskResult(task.task_id, { expected_revision: (await tasksApi.get(task.task_id)).revision, text: richText(""), links: [], file_ids: [uploaded.file_id] });
  const saved = await tasksApi.get(task.task_id);
  const result = saved.submissions!.at(-1)!;
  expect(saved.status).toBe("completed");
  expect(result.text.body).toBe("");
  expect(result.files).toHaveLength(1);
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { path: `/tasks/${task.task_id}`, session });
  await waitForPage(page);
  expect([...page.container.querySelectorAll("button")].some(button => ["Сдать результат", "Взять в работу"].includes(button.textContent ?? ""))).toBe(false);
  await act(async () => page!.container.querySelector<HTMLButtonElement>("#task-tab-attachments")!.click());
  await waitForPage(page, () => !!page!.container.querySelector("#task-panel-attachments")?.textContent?.includes("result.txt"));
  expect(page.container.querySelector("#task-panel-attachments")!.textContent).toContain("Результаты работы");
  const attached = result.files[0];
  const { download_url } = await filesApi.download(attached.file_id);
  const response = await api.get(download_url.slice("/api".length), { responseType: "text" });
  expect(response.data).toBe("Synthetic file-only result");
  await page.cleanup(); page = undefined;
  await liveLogin();
  const current = await eventsApi.subevent(subevent.subevent_id);
  await eventsApi.organizers(current.subevent_id, [], { expected_revision: current.revision });
  await liveLogin(worker.email);
  // The revoked organizer no longer reads the task, so it is not found for them either.
  await expect(filesApi.intent({ ...owner, name: "result.txt", mime_type: "text/plain", size_bytes: 12 })).rejects.toMatchObject({ status: 404 });
  await expect(filesApi.download(attached.file_id)).rejects.toMatchObject({ status: 404 });
});
