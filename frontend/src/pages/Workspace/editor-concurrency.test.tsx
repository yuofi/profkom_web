// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change, field, pick, submit } from "../../test/workspace";
import { MaterialPage } from "./MaterialPages";
import { ReportPage } from "./ReportPages";
import { TaskPage } from "./TaskPages";
import { materialsApi } from "../../utils/api/materials.api";
import { reportsApi } from "../../utils/api/reports.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText } from "../../utils/api/contract";
import { ApiError } from "../../utils/api/request";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); mock?.restore(); vi.restoreAllMocks(); });
async function click(container: ParentNode, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click()); await settle();
}
const accept = (form: HTMLFormElement) => click(form, "Сохранить мой ввод с обновлённой версией");
async function refetch(key: string) {
  await act(async () => { await page!.client.invalidateQueries({queryKey: [key]}); });
  await settle(); await settle();
}
const forms = () => Array.from(page!.container.querySelectorAll("form"));
const namedForm = (label: string) => forms().find(f => f.querySelector('button[type="submit"]')?.textContent === label)!;

it.each(["material", "report", "task", "task-inputs", "assessment", "bulk"] as const)("holds its baseline through background refetch and two saves: %s", async kind => {
  mock = installMockTransport("chair", {delay: 0});
  const material = mock.state.materials[0], report = mock.state.reports[0], task = mock.state.tasks[0];
  const id = kind === "material" ? material.material_id : kind === "report" ? report.report_id : task.task_id;
  const prefix = kind === "material" ? "materials" : kind === "report" ? "reports" : "tasks";
  page = await mountWorkspace(<Routes><Route path={`/${prefix}/:id`} element={kind === "material" ? <MaterialPage /> : kind === "report" ? <ReportPage /> : <TaskPage />} /></Routes>, {path: `/${prefix}/${id}`});
  await settle(); await settle();
  if (kind === "task") await click(page.container, "Редактировать");
  const form = kind === "bulk" ? forms().find(f => f.querySelector('[data-entity-picker][data-field-name="assignments"]'))!
    : kind === "assessment" ? forms().find(f => f.querySelector('[name="evaluation"]'))!
    : field(page.container, kind === "task-inputs" ? "assigned" : "title").closest("form")!;
  const name = kind === "assessment" || kind === "bulk" ? "hours" : kind === "task-inputs" ? "deadline" : "title";
  const value = name === "hours" ? "7" : name === "deadline" ? "2026-10-26T18:00" : "МОЙ ВВОД";
  await change(field(form, name), value);
  if (form.querySelector('[name="reason"]')) await change(field(form, "reason"), "Причина исправления");
  if (kind === "bulk") await pick(form, "assignments", mock.state.assessments[0].assignment_id);
  const foreign = () => {
    if (kind === "material") { material.revision++; material.description = "ЧУЖОЕ ОПИСАНИЕ"; material.draft_content = richText("ЧУЖОЙ ТЕКСТ"); }
    else if (kind === "report") { report.revision++; report.draft_content = richText("ЧУЖОЙ ТЕКСТ"); }
    else if (kind === "task") { task.revision++; task.description = richText("ЧУЖОЙ ТЕКСТ"); }
    else if (kind === "task-inputs") { mock!.state.inputs.revision++; mock!.state.inputs.criteria.creative = true; }
    else { mock!.state.assessments[0].revision++; mock!.state.assessments[0].hours = 99; }
  };
  const key = kind === "task-inputs" || kind === "assessment" || kind === "bulk" ? "assessments" : prefix;
  const spy = kind === "material" ? vi.spyOn(materialsApi, "update") : kind === "report" ? vi.spyOn(reportsApi, "update")
    : kind === "task" ? vi.spyOn(tasksApi, "update") : kind === "task-inputs" ? vi.spyOn(tasksApi, "updateInputs")
    : kind === "assessment" ? vi.spyOn(tasksApi, "updateAssessment") : vi.spyOn(tasksApi, "bulkHours");
  for (let round = 0; round < 2; round++) {
    foreign(); await refetch(key);
    expect(field(form, name).value).toBe(value);
    expect(form.textContent).toContain("Запись изменилась на сервере");
    const before = spy.mock.calls.length;
    await submit(form);
    expect(spy.mock.calls).toHaveLength(before);
    await accept(form); await submit(form);
    expect(spy.mock.calls).toHaveLength(before + 1);
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    expect(form.textContent).not.toContain("Запись изменилась на сервере");
  }
});

it("replacing a material draft also replaces Markdown outside Formik", async () => {
  mock = installMockTransport("chair", {delay: 0});
  const m = mock.state.materials[0];
  page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, {path: `/materials/${m.material_id}`});
  await settle(); await settle();
  const form = field(page.container, "title").closest("form")!;
  await change(form.querySelector("textarea")!, "ЛОКАЛЬНЫЙ MARKDOWN");
  m.revision++; m.title = "СЕРВЕРНОЕ НАЗВАНИЕ"; m.draft_content = richText("СЕРВЕРНЫЙ MARKDOWN");
  await refetch("materials");
  expect(form.querySelector("textarea")!.value).toBe("ЛОКАЛЬНЫЙ MARKDOWN");
  await click(form, "Заменить мой ввод сохранёнными значениями");
  expect(form.querySelector("textarea")!.value).toBe("СЕРВЕРНЫЙ MARKDOWN");
  expect(field(form, "title").value).toBe("СЕРВЕРНОЕ НАЗВАНИЕ");
  await submit(form);
  expect((await materialsApi.get(m.material_id)).draft_content?.body).toBe("СЕРВЕРНЫЙ MARKDOWN");
});

it("replacing a report draft replaces its attachment selection together with text", async () => {
  mock = installMockTransport("chair", {delay: 0});
  const r = mock.state.reports[0];
  r.draft_files = [{file_id: "old-file", name: "old.pdf", mime_type: "application/pdf", size_bytes: 10}];
  page = await mountWorkspace(<Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, {path: `/reports/${r.report_id}`});
  await settle(); await settle();
  const form = field(page.container, "body").closest("form")!;
  await change(field(form, "body"), "МОЙ ТЕКСТ");
  r.revision++; r.draft_content = richText("СЕРВЕРНЫЙ ТЕКСТ");
  r.draft_files = [{file_id: "new-file", name: "new.pdf", mime_type: "application/pdf", size_bytes: 11}];
  await refetch("reports");
  expect(form.textContent).toContain("new.pdf");
  await click(form, "Заменить мой ввод сохранёнными значениями");
  const update = vi.spyOn(reportsApi, "update");
  await submit(form);
  expect(update).toHaveBeenCalledWith(r.report_id, expect.objectContaining({file_ids: ["new-file"], content: richText("СЕРВЕРНЫЙ ТЕКСТ")}));
});

it("publishing an acknowledged foreign draft does not authorize an older dirty editor", async () => {
  mock = installMockTransport("chair", {delay: 0});
  const r = mock.state.reports[0];
  page = await mountWorkspace(<Routes><Route path="/reports/:id" element={<ReportPage />} /></Routes>, {path: `/reports/${r.report_id}`});
  await settle(); await settle();
  const editor = namedForm("Сохранить черновик");
  await change(field(editor, "body"), "МОЙ СТАРЫЙ ВВОД");
  r.revision++; r.draft_content = richText("ЧУЖОЙ ЧЕРНОВИК");
  await refetch("reports");
  const publication = namedForm("Опубликовать сохранённый отчёт");
  await accept(publication); await submit(publication);
  expect((await reportsApi.get(r.report_id)).content.body).toBe("ЧУЖОЙ ЧЕРНОВИК");
  const save = vi.spyOn(reportsApi, "update");
  await submit(editor);
  expect(save).not.toHaveBeenCalled();
  expect(field(editor, "body").value).toBe("МОЙ СТАРЫЙ ВВОД");
});

it("a first foreign material draft cannot initialize publication with an implicitly accepted revision", async () => {
  mock = installMockTransport("chair", {delay: 0});
  const m = mock.state.materials[0]; delete m.draft_content;
  page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, {path: `/materials/${m.material_id}`});
  await settle(); await settle();
  const publication = namedForm("Опубликовать сохранённый черновик");
  expect((publication.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  m.revision++; m.draft_content = richText("FIRST FOREIGN DRAFT");
  await refetch("materials");
  const publish = vi.spyOn(materialsApi, "publish");
  await submit(publication);
  expect(publish).not.toHaveBeenCalled();
  await accept(publication); await submit(publication);
  expect(publish).toHaveBeenCalled();
  expect((await materialsApi.get(m.material_id)).published_content?.body).toBe("FIRST FOREIGN DRAFT");
});

it.each(["material", "report", "task-inputs", "assessment"] as const)("retains its draft during a temporary refetch failure: %s", async kind => {
  mock = installMockTransport("chair", {delay: 0});
  const prefix = kind === "material" ? "materials" : kind === "report" ? "reports" : "tasks";
  const id = kind === "material" ? mock.state.materials[0].material_id : kind === "report" ? mock.state.reports[0].report_id : mock.state.tasks[0].task_id;
  page = await mountWorkspace(<Routes><Route path={`/${prefix}/:id`} element={kind === "material" ? <MaterialPage /> : kind === "report" ? <ReportPage /> : <TaskPage />} /></Routes>, {path: `/${prefix}/${id}`});
  await settle(); await settle();
  const name = kind === "assessment" ? "hours" : kind === "task-inputs" ? "deadline" : "title";
  const form = kind === "assessment" ? forms().find(f => f.querySelector('[name="evaluation"]'))! : field(page.container, name).closest("form")!;
  const value = kind === "assessment" ? "7" : kind === "task-inputs" ? "2026-10-26T18:00" : "НЕСОХРАНЁННЫЙ ВВОД";
  await change(field(form, name), value);
  const get = kind === "material" ? vi.spyOn(materialsApi, "get") : kind === "report" ? vi.spyOn(reportsApi, "get") : kind === "task-inputs" ? vi.spyOn(tasksApi, "inputs") : vi.spyOn(tasksApi, "assessment");
  get.mockRejectedValue(new ApiError("Временный сбой", 503));
  await refetch(kind === "task-inputs" || kind === "assessment" ? "assessments" : prefix);
  expect(page.container.contains(form)).toBe(true);
  expect(field(form, name).value).toBe(value);
  expect(page.container.textContent).toContain("Временный сбой");
  get.mockRestore();
  await refetch(kind === "task-inputs" || kind === "assessment" ? "assessments" : prefix);
  expect(field(form, name).value).toBe(value);
});
