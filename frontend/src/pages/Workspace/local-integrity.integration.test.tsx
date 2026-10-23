// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { focusManager } from "@tanstack/react-query";
import axios from "axios";
import { api } from "../../utils/api";
import { liveLogin, liveParticipant, livePassword } from "../../test/liveApi";
import { mountWorkspace, waitForPage, change, field, submit } from "../../test/workspace";
import { materialsApi } from "../../utils/api/materials.api";
import { reportsApi } from "../../utils/api/reports.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { membershipApi } from "../../utils/api/membership.api";
import { eventsApi } from "../../utils/api/events.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { filesApi } from "../../utils/api/files.api";
import { richText, emptyCriteria } from "../../utils/api/contract";
import { UserProvider } from "../../utils/ctx";
import { MaterialPage } from "./MaterialPages";
import { ReportPage } from "./ReportPages";
import { TaskPage } from "./TaskPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; focusManager.setFocused(undefined); });
const until = (predicate: () => boolean) => waitForPage(page!, predicate);
async function actorClient(email: string) {
  const baseURL = api.defaults.baseURL!;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(baseURL).hostname);
  const login = await axios.post(`${baseURL}/auth/login`, {email, password: livePassword});
  return axios.create({baseURL, headers: {Authorization: `Bearer ${login.data.access_token}`}});
}
async function openSeason() {
  await liveLogin();
  const seasons = (await seasonsApi.list()).items;
  const open = seasons.find(s => s.state === "open");
  if (open) return open;
  const planned = seasons.find(s => s.state === "planned") ?? await seasonsApi.create({
    title: "Local integrity", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const result = await seasonsApi.command(planned.season_id, "open", {expected_revision: planned.revision});
  return "season" in result ? result.season : result;
}
function form(label: string) {
  const f = Array.from(page!.container.querySelectorAll("form")).find(f => f.querySelector('button[type="submit"]')?.textContent === label);
  expect(f).toBeDefined(); return f!;
}
async function click(container: ParentNode, label: string) {
  const b = Array.from(container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(b).toBeDefined(); await act(async () => b!.click()); await waitForPage(page!);
}
async function refetch(key: string) {
  await act(async () => { await page!.client.invalidateQueries({queryKey: [key]}); }); await waitForPage(page!);
}
async function save(editor: HTMLFormElement) {
  await submit(editor);
  await until(() => !!editor.textContent?.includes("Изменения сохранены") && !(editor.querySelector('button[type="submit"]') as HTMLButtonElement).disabled);
}

it.each(["keep", "replace"])("LOC-02: two real material editors refetch, compare and %s the draft", async choice => {
  const a = await liveParticipant("material-A"), b = await liveParticipant("material-B");
  await liveLogin();
  let m = await materialsApi.create({kind: "general", title: "Initial material", description: "Initial description", content: richText("ORIGINAL BODY")});
  m = {...m, ...await materialsApi.editors(m.material_id, [a.user_id, b.user_id], {expected_revision: m.revision})};
  m = await materialsApi.publish(m.material_id, {expected_revision: m.revision});
  const other = await actorClient(b.email);
  const session = await liveLogin(a.email);
  page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, {path: `/materials/${m.material_id}`, session});
  await until(() => !!page!.container.querySelector('[name="title"]'));
  const editor = form("Сохранить черновик");
  await change(field(editor, "title"), "MY LOCAL TITLE");
  const foreign = (await other.patch(`/materials/${m.material_id}`, {expected_revision: m.revision, title: "FOREIGN TITLE", description: "FOREIGN DESCRIPTION", content: richText("FOREIGN BODY")})).data;
  await refetch("materials");
  await submit(editor);
  expect((await other.get(`/materials/${m.material_id}`)).data.revision).toBe(foreign.revision);
  expect(editor.querySelector("textarea")!.value).toBe("ORIGINAL BODY");
  expect(field(editor, "title").value).toBe("MY LOCAL TITLE");
  await click(editor, choice === "keep" ? "Сохранить мой ввод с обновлённой версией" : "Заменить мой ввод сохранёнными значениями");
  await save(editor);
  const saved = (await other.get(`/materials/${m.material_id}`)).data;
  expect(saved.revision).toBe(foreign.revision + 1);
  expect(saved.draft_content.body).toBe(choice === "keep" ? "ORIGINAL BODY" : "FOREIGN BODY");
  expect(saved.title).toBe(choice === "keep" ? "MY LOCAL TITLE" : "FOREIGN TITLE");
  expect(saved.published_content.body).toBe("ORIGINAL BODY");
  await save(editor);
  expect((await other.get(`/materials/${m.material_id}`)).data.revision).toBe(saved.revision + 1);
});

it("LOC-01/02: report coauthors replace text/files explicitly; old signed PUT cannot alter a publication", async () => {
  const a = await liveParticipant("report-A"), b = await liveParticipant("report-B");
  const season = await openSeason();
  const event = await eventsApi.create({season_id: season.season_id, title: "Immutable report", description: richText()});
  await eventsApi.leaders("events", event.event_id, [a.user_id, b.user_id], {expected_revision: event.revision});
  const other = await actorClient(b.email), chair = await actorClient("chair@example.com");
  const session = await liveLogin(a.email);
  let r = await reportsApi.create({owner_kind: "event", owner_id: event.event_id, kind: "regular", title: "Report", content: richText("OLD PUBLICATION"), file_ids: []});
  r = await reportsApi.publish(r.report_id, {expected_revision: r.revision});
  page = await mountWorkspace(<Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, {path: `/reports/${r.report_id}`, session});
  await until(() => !!page!.container.querySelector('[name="body"]'));
  const editor = form("Сохранить черновик");
  await change(field(editor, "body"), "MY LOCAL DRAFT");
  const original = "%PDF-1.4\nOriginal A", replacement = "%PDF-1.4\nReplaced B";
  const intent = (await other.post("/files/upload-intents", {owner_kind: "report", owner_id: r.report_id, purpose: "report", name: "immutable.pdf", mime_type: "application/pdf", size_bytes: original.length})).data;
  await axios.put(intent.upload_url, original, {headers: intent.headers});
  await other.post(`/files/${intent.file_id}/complete`, {});
  const foreign = (await other.patch(`/reports/${r.report_id}`, {expected_revision: r.revision, content: richText("FOREIGN SHARED DRAFT"), file_ids: [intent.file_id]})).data;
  await refetch("reports");
  await submit(editor);
  expect((await other.get(`/reports/${r.report_id}`)).data.revision).toBe(foreign.revision);
  expect(field(editor, "body").value).toBe("MY LOCAL DRAFT");
  await click(editor, "Заменить мой ввод сохранёнными значениями");
  await save(editor);
  expect((await reportsApi.get(r.report_id)).draft_files?.map(f => f.file_id)).toEqual([intent.file_id]);
  const publication = form("Опубликовать сохранённый отчёт");
  await click(publication, "Сохранить мой ввод с обновлённой версией");
  await save(publication);
  const published = await reportsApi.get(r.report_id);
  expect(published.content.body).toBe("FOREIGN SHARED DRAFT");
  const versions = await reportsApi.versions(r.report_id);
  const getBytes = async () => {
    const {download_url} = await filesApi.download(intent.file_id);
    // The API address, checked on every request (decision 23).
    const response = await api.get(download_url.replace(/^\/api/, ""), {responseType: "arraybuffer"});
    return String.fromCharCode(...new Uint8Array(response.data));
  };
  expect(await getBytes()).toBe(original);
  const currentEvent = (await chair.get(`/events/${event.event_id}`)).data;
  await chair.put(`/events/${event.event_id}/leaders`, {expected_revision: currentEvent.revision, user_ids: [a.user_id]});
  await expect(other.get(`/files/${intent.file_id}/download`)).rejects.toMatchObject({response: {status: 404}});
  await axios.put(intent.upload_url, replacement, {headers: intent.headers});
  expect(await getBytes()).toBe(original);
  expect((await reportsApi.get(r.report_id)).revision).toBe(published.revision);
  expect(await reportsApi.versions(r.report_id)).toEqual(versions);
});

it.each(["refresh", "focus"])("LOC-03: another account removes membership while its task is open (%s)", async mode => {
  const master = await liveParticipant("scope-master"), member = await liveParticipant("scope-member");
  const season = await openSeason();
  const block = (await membershipApi.blocks()).find(b => b.name === "Integration IT")!;
  await eventsApi.blockLeader(block.block_id, master.user_id, {expected_revision: block.revision});
  await liveLogin(member.email);
  let application = await membershipApi.join(block.block_id);
  await liveLogin();
  application = await membershipApi.requestCommand(application.request_id, "hr-approve", {expected_revision: application.revision});
  await liveLogin(master.email);
  await membershipApi.requestCommand(application.request_id, "block-approve", {expected_revision: application.revision});
  const task = await tasksApi.create({season_id: season.season_id, scope: {kind: "block", id: block.block_id}, title: "PRIVATE OPEN TASK", description: richText("PRIVATE TASK BODY"), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{user_id: member.user_id, hours: 2}]});
  const manager = await actorClient(master.email);
  await liveLogin(member.email);
  page = await mountWorkspace(<UserProvider><Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes></UserProvider>, {path: `/tasks/${task.task_id}`});
  await until(() => !!page!.container.textContent?.includes("PRIVATE TASK BODY"));
  const before = page.client.getQueryData<{access_revision: string}>(["session"])!.access_revision;
  await manager.delete(`/blocks/${block.block_id}/members/${member.user_id}`);
  if (mode === "focus") await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  else await act(async () => { await page!.client.refetchQueries({queryKey: ["session"]}); });
  await until(() => !page!.container.textContent?.includes("PRIVATE TASK BODY") && !!page!.container.querySelector('[role="alert"]'));
  expect(page.container.textContent).not.toContain(task.title);
  expect(page.container.querySelector("form")).toBeNull();
  expect(page.client.getQueryData<{access_revision: string}>(["session"])!.access_revision).not.toBe(before);
  expect((await manager.get(`/tasks/${task.task_id}`)).status).toBe(200);
});
