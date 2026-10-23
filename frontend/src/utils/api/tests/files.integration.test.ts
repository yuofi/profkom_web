import { expect, it } from "vitest";
import axios from "axios";
import { liveLogin, liveParticipant } from "../../../test/liveApi";
import { filesApi } from "../files.api";
import { reportsApi } from "../reports.api";
import { seasonsApi } from "../seasons.api";
import { eventsApi } from "../events.api";
import { directoryApi } from "../directory.api";
import { materialsApi } from "../materials.api";
import { membershipApi } from "../membership.api";
import { tasksApi } from "../tasks.api";
import { pgasApi } from "../pgas.api";
import { api } from "../index";
import { emptyCriteria, richText } from "../contract";
import { fileExtensions } from "../../filePolicy";
import { uploadFile } from "../../s3-utils";

// Synthetic payloads exercise signature checks, not document parsing. No external bucket or user data.
const bytes = (ext: string) => {
  if (ext === "png") return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1kAAAAASUVORK5CYII=", "base64");
  if (["jpg", "jpeg"].includes(ext)) return Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  if (ext === "webp") return Buffer.from("RIFF0000WEBPsynthetic");
  if (ext === "pdf") return Buffer.from("%PDF-1.7\nSynthetic acceptance document\n%%EOF");
  if (["doc", "xls", "ppt"].includes(ext)) return Buffer.from("d0cf11e0a1b11ae173796e746865746963", "hex");
  if (["zip", "docx", "xlsx", "pptx"].includes(ext)) return Buffer.from("504b030473796e746865746963", "hex");
  return Buffer.from("Synthetic UTF-8 text: Тест");
};
const file = (ext: string, type = "") => new File([bytes(ext)], `synthetic.${ext}`, { type });
async function currentSeason() {
  const seasons = (await seasonsApi.list()).items;
  return seasons.find(s => s.state === "open") ?? seasons.find(s => s.state === "planned") ?? seasonsApi.create({ title: "File acceptance", type: "autumn_winter", starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 20 * 86400000).toISOString() });
}
// A file comes by its API address, checked on every request (decision 23).
const fetchFile = (url: string) => {
  expect(url).toMatch(/^\/api\/files\/file-[\w-]+\/content$/);
  return api.get<ArrayBuffer>(url.slice("/api".length), { responseType: "arraybuffer" });
};
async function downloadEquals(id: string, ext: string) {
  const { download_url } = await filesApi.download(id);
  const response = await fetchFile(download_url);
  const shown = ["png", "jpg", "jpeg", "webp"].includes(ext) ? "inline" : "attachment";
  expect(response.headers["content-disposition"]).toBe(`${shown}; filename="synthetic.${ext}"; filename*=UTF-8''synthetic.${ext}`);
  expect(Buffer.from(response.data)).toEqual(bytes(ext));
}

it("INT-05: every advertised attachment format completes PUT and remains in report history", async () => {
  const author = await liveParticipant("file-author");
  await liveLogin();
  const season = await currentSeason();
  const event = await eventsApi.create({ season_id: season.season_id, title: "File report", description: richText() });
  await eventsApi.leaders("events", event.event_id, [author.user_id], { expected_revision: event.revision });
  await liveLogin(author.email);
  let report = await reportsApi.create({ owner_kind: "event", owner_id: event.event_id, kind: "regular", title: "Проверенные файлы HTTP", content: richText("Local object transport"), file_ids: [] });
  const uploaded = [];
  expect(fileExtensions("report")).toHaveLength(13);
  for (const ext of fileExtensions("report")) {
    const type = ext === "jpg" ? "image/jpg" : ext === "zip" ? "application/x-zip-compressed" : "";
    const ref = await filesApi.upload(file(ext, type), { owner_kind: "report", owner_id: report.report_id, purpose: "report" });
    await downloadEquals(ref.file_id, ext);
    uploaded.push(ref);
  }
  report = await reportsApi.update(report.report_id, { expected_revision: report.revision, file_ids: uploaded.map(f => f.file_id) });
  await liveLogin();
  await expect(filesApi.download(uploaded[0].file_id)).rejects.toMatchObject({ status: 404 });
  await liveLogin(author.email);
  report = await reportsApi.publish(report.report_id, { expected_revision: report.revision });
  report = await reportsApi.update(report.report_id, { expected_revision: report.revision, file_ids: [] });
  await reportsApi.publish(report.report_id, { expected_revision: report.revision });
  await liveLogin();
  expect((await reportsApi.versions(report.report_id)).items.some(v => v.files.length === uploaded.length)).toBe(true);
  await downloadEquals(uploaded[0].file_id, "png");
  const changed = await eventsApi.get(event.event_id);
  const chair = await liveLogin();
  await eventsApi.leaders("events", event.event_id, [chair.user_id], { expected_revision: changed.revision });
  await liveLogin(author.email);
  await expect(filesApi.download(uploaded[0].file_id)).rejects.toMatchObject({ status: 404 });
});

it("INT-05: PGAS, avatar, material and assignment use completed contextual files", async () => {
  const chair = await liveLogin();
  for (const ext of fileExtensions("pgas")) {
    const marker = await uploadFile("pgas", file(ext, ext === "jpg" ? "image/jpg" : ""));
    const entry = await pgasApi.create({ title: `HTTP PGAS ${ext}`, year: 2026, file_url: marker, file_name: `synthetic.${ext}`, file_type: "" });
    expect(entry.file_type).not.toBe("");
    const response = await fetchFile(entry.file_url);
    expect(Buffer.from(response.data)).toEqual(bytes(ext));
  }
  for (const ext of fileExtensions("avatar")) {
    const avatar = await filesApi.upload(file(ext), { owner_kind: "avatar", purpose: "avatar" });
    const contact = await directoryApi.avatar({ file_id: avatar.file_id });
    expect(JSON.stringify(contact)).toContain(`"/api/files/${avatar.file_id}/content"`);
    await downloadEquals(avatar.file_id, ext);
  }
  let material = await materialsApi.create({ kind: "general", title: "File material", description: "Local upload", content: richText() });
  const attachment = await filesApi.upload(file("pdf"), { owner_kind: "material", owner_id: material.material_id, purpose: "material" });
  material = await materialsApi.update(material.material_id, { expected_revision: material.revision, content: richText(`[Документ](file:${attachment.file_id})`) });
  await materialsApi.publish(material.material_id, { expected_revision: material.revision });
  await downloadEquals(attachment.file_id, "pdf");
  const block = (await membershipApi.blocks()).find(b => b.is_hr)!;
  let season = await currentSeason();
  if (season.state === "planned") {
    await seasonsApi.command(season.season_id, "open", { expected_revision: season.revision });
    season = await seasonsApi.current();
  }
  const task = await tasksApi.create({ season_id: season.season_id, scope: { kind: "block", id: block.block_id }, title: "Uploaded submission", description: richText(), deadline_at: new Date(Date.now() + 86400000).toISOString(), criteria: emptyCriteria(), assignees: [{ user_id: chair.user_id, hours: 1 }] });
  const assignment = task.assignments[0];
  const submission = await filesApi.upload(file("txt"), { owner_kind: "assignment", owner_id: assignment.assignment_id, purpose: "submission" });
  const saved = await tasksApi.command(assignment.assignment_id, "submit", { expected_revision: assignment.revision, text: richText("Uploaded"), file_ids: [submission.file_id] });
  expect(saved.submissions.at(-1)?.files[0].file_id).toBe(submission.file_id);
  await downloadEquals(submission.file_id, "txt");
});

it("INT-05: metadata, binary and size failures never expose incomplete objects", async () => {
  await liveLogin();
  for (const [kind, purpose, limit] of [["avatar", "avatar", 10], ["pgas", "pgas", 20]] as const) {
    const payload = { owner_kind: kind, purpose, name: "limit.png", mime_type: "image/png", size_bytes: limit * 1024 * 1024 };
    expect((await filesApi.intent(payload)).file_id).toBeTruthy();
    await expect(filesApi.intent({ ...payload, size_bytes: payload.size_bytes + 1 })).rejects.toMatchObject({ status: 422 });
    await expect(api.post("/files/upload-intents", { ...payload, size_bytes: payload.size_bytes + 1 })).rejects.toMatchObject({ response: { status: 422 } });
  }
  await expect(filesApi.upload(new File(["GIF89a"], "bad.gif", { type: "image/gif" }), { owner_kind: "avatar", purpose: "avatar" })).rejects.toMatchObject({ status: 422 });
  await expect(api.post("/files/upload-intents", { owner_kind: "avatar", purpose: "avatar", name: "bad.gif", mime_type: "image/gif", size_bytes: 6 })).rejects.toMatchObject({ response: { status: 422 } });
  const intent = await filesApi.intent({ owner_kind: "avatar", purpose: "avatar", name: "wrong.png", mime_type: "image/png", size_bytes: 3 });
  await axios.put(intent.upload_url, Buffer.from("bad"), { headers: intent.headers });
  await expect(filesApi.complete(intent.file_id)).rejects.toMatchObject({ status: 422 });
  await expect(filesApi.download(intent.file_id)).rejects.toMatchObject({ status: 404 });
});
