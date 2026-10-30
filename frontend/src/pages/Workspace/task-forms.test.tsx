import { publicStatus } from "./trackerStatus";
// @vitest-environment jsdom
import { act, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, change, field, pick, submit, settle, waitForPage } from "../../test/workspace";
import { ActionForm, type Field } from "../../components/Workspace/ActionForm";
import { TaskPage } from "./TaskPages";
import { filesApi } from "../../utils/api/files.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { ApiError } from "../../utils/api/request";
import { AssessmentPanel } from "../../components/Workspace/AssessmentPanel";
import type { AssessmentInputs } from "../../utils/api/contract";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; mock?.restore(); mock = undefined; vi.restoreAllMocks(); });

async function clickButton(container: ParentNode, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!button) throw Error(`Missing button: ${text}`);
  await act(async () => button.click()); await settle();
}
const deputies = (confirmRemoval?: boolean): Field => ({
  name: "users", label: "Заместители", type: "multi", value: ["101", "102"], confirmRemoval,
  options: [{ value: "101", label: "Анна" }, { value: "102", label: "Иван" }, { value: "103", label: "Мария" }],
});

it("A-ROL-13: removing saved people is confirmed first; adding is not", async () => {
  const save = vi.fn(async () => {});
  page = await mountWorkspace(<ActionForm fields={[deputies()]} onSubmit={save} />);
  const form = page.container.querySelector("form")!;
  await pick(form, "users", "103");
  await pick(form, "users", "102", false);
  await submit(form);
  expect(save).not.toHaveBeenCalled();
  expect(form.querySelector('[role="alert"]')?.textContent).toContain("Будут сняты: Иван.");
  // Another change of the choice withdraws the question.
  await pick(form, "users", "101", false);
  expect(form.textContent).not.toContain("Будут сняты");
  await submit(form);
  expect(form.textContent).toContain("Будут сняты: Анна, Иван.");
  await clickButton(form, "Снять и сохранить");
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]).toEqual([{ users: ["103"] }, undefined]);
  await page.cleanup();

  page = await mountWorkspace(<ActionForm fields={[deputies()]} onSubmit={save} />);
  await pick(page.container, "users", "103");
  await submit(page.container.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(2);
  await page.cleanup();

  // Marks, not people: no question.
  page = await mountWorkspace(<ActionForm fields={[deputies(false)]} onSubmit={save} />);
  await pick(page.container, "users", "101", false);
  await submit(page.container.querySelector("form")!);
  expect(save).toHaveBeenCalledTimes(3);
});

it("A-TSK-6: a creating form starts empty after a success and keeps the input after a failure", async () => {
  const save = vi.fn(async () => {}).mockRejectedValueOnce(Error("Сеть недоступна"));
  page = await mountWorkspace(<ActionForm resetOnSuccess fields={[{ name: "body", label: "Комментарий", type: "textarea", required: true }]} onSubmit={save} />);
  const form = page.container.querySelector("form")!;
  await change(field(form, "body"), "Первый комментарий");
  await submit(form);
  expect(field(form, "body").value).toBe("Первый комментарий");
  await submit(form);
  expect(save).toHaveBeenCalledTimes(2);
  expect(field(form, "body").value).toBe("");
  expect(form.textContent).toContain("Изменения сохранены");
});

it("A-FE-2: own saves of one record move the other forms of it; a foreign revision still stops them", async () => {
  const sent: [string, number | undefined][] = [];
  function Probe() {
    const [revision, setRevision] = useState(1);
    // As perform(): the record is reread before the command returns.
    const save = (name: string) => async (_v: unknown, expected?: number) => { sent.push([name, expected]); setRevision(expected! + 1); return { revision: expected! + 1 }; };
    return (
      <>
        <button onClick={() => setRevision((r) => r + 1)}>Foreign</button>
        <section aria-label="leaders"><ActionForm record="subevent:1" revision={revision} fields={[{ name: "title", label: "Руководители", value: "Анна" }]} onSubmit={save("leaders")} onConflict={() => {}} /></section>
        <section aria-label="description"><ActionForm record="subevent:1" revision={revision} fields={[{ name: "body", label: "Описание", value: "Текст" }]} onSubmit={save("description")} onConflict={() => {}} /></section>
        <section aria-label="other"><ActionForm record="subevent:2" revision={revision} fields={[{ name: "note", label: "Другое", value: "" }]} onSubmit={save("other")} onConflict={() => {}} /></section>
      </>
    );
  }
  page = await mountWorkspace(<Probe />);
  const form = (label: string) => page!.container.querySelector(`[aria-label="${label}"] form`) as HTMLFormElement;
  await change(field(form("leaders"), "title"), "Анна, Иван");
  await change(field(form("description"), "body"), "Мой текст");
  await change(field(form("other"), "note"), "Черновик");
  await submit(form("leaders"));
  expect(form("description").textContent).not.toContain("Запись изменилась на сервере");
  await submit(form("description"));
  expect(sent).toEqual([["leaders", 1], ["description", 2]]);
  // Another record does not share the chain.
  expect(form("other").textContent).toContain("Запись изменилась на сервере");
  await clickButton(page.container, "Foreign");
  expect(form("leaders").textContent).toContain("Запись изменилась на сервере");
  expect(field(form("leaders"), "title").value).toBe("Анна, Иван");
  await submit(form("leaders"));
  expect(sent).toHaveLength(2);
});

async function taskPage(role: "leader" | "chair" | "organizer") {
  mock = installMockTransport(role, { delay: 0 });
  mock.state.tasks[0].capabilities.push("change_task_status", "submit_task_result");
  page = await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes>, { role, path: "/tasks/task-1" });
  await settle(); await settle();
  return page;
}
it("УВ-5: an area lead fills shared criteria after closure while only date-authorized roles edit dates", async () => {
  mock=installMockTransport("leader",{delay:0});const task=mock.state.tasks[0];task.status="closed";task.closed_at="2026-10-30T00:00:00Z";
  page=await mountWorkspace(<Routes><Route path="/tasks/:id" element={<TaskPage/>}/></Routes>,{role:"leader",path:`/tasks/${task.task_id}?assignment_id=${task.assignments[0].assignment_id}`});await waitForPage(page,()=>!!page!.container.querySelector('table'));
  expect(page.container.querySelector('[name="deadline"]')).toBeNull();expect(page.container.querySelector('[name="assigned"]')).toBeNull();
  const creative=[...page.container.querySelectorAll('fieldset label')].find(label=>label.textContent==='Творческий подход')!.querySelector<HTMLInputElement>('input')!;await act(async()=>creative.click());
  for(const input of page.container.querySelectorAll<HTMLSelectElement>('select[aria-label^="Оценка:"]'))await change(input,'1');
  await submit(page.container.querySelector('form:has(table)')!);await waitForPage(page);
  const sent=JSON.parse(mock.adapter.history.put.at(-1)!.data);expect(sent.criteria.creative).toBe(true);expect(sent).not.toHaveProperty('deadline_at');expect(sent).not.toHaveProperty('assigned_at');
});

it("A-TSK-5: a public status conflict rereads the task before an explicit retry", async () => {
  await taskPage("organizer");const task=mock!.state.tasks[0];const status=vi.spyOn(tasksApi,"changeStatus").mockRejectedValueOnce(new ApiError("Changed",409,"revision_conflict")).mockImplementation(async(_id,data)=>{task.status=publicStatus(data.status);task.revision++;return structuredClone(task);});
  const accounting=vi.spyOn(tasksApi,"updateAssessment");task.revision++;
  const choose=async()=>{await act(async()=>page!.container.querySelector<HTMLButtonElement>('button[aria-label^="Статус задачи:"]')!.click());await clickButton(page!.container.querySelector('[role="menu"]')!,"В работе");await waitForPage(page!);};
  await choose();expect(page!.container.querySelector('[role="alert"]')?.textContent).toContain("Запись изменилась");await choose();expect(status).toHaveBeenLastCalledWith(task.task_id,{expected_revision:2,status:"in_progress"});expect(accounting).not.toHaveBeenCalled();
});

it("A-TSK-12: replacing a submission draft with the saved values empties its text and files", async () => {
  await taskPage("organizer");
  const command = vi.spyOn(tasksApi, "submitResult").mockRejectedValueOnce(new ApiError("Changed", 409, "revision_conflict")).mockImplementation(async () => { mock!.state.tasks[0].status = "completed";mock!.state.tasks[0].revision++;return structuredClone(mock!.state.tasks[0]); });
  vi.spyOn(filesApi, "upload").mockResolvedValue({ file_id: "file-result", name: "result.pdf", mime_type: "application/pdf", size_bytes: 10 });
  await clickButton(page!.container, "Сдать результат");
  const result = () => page!.container.querySelector<HTMLFormElement>("dialog form")!;
  const draft = () => result().closest("dialog")!;
  const input = draft().querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [new File(["%PDF-1.7"], "result.pdf", { type: "application/pdf" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true }))); await settle();
  expect(draft().textContent).toContain("result.pdf");
  await change(field(result(), "body"), "Мой результат");
  await change(field(result(), "links"), "https://example.org/result");
  mock!.state.tasks[0].revision++;
  await submit(result());
  await clickButton(result(), "Обновить данные");
  expect(field(result(), "body").value).toBe("Мой результат");
  expect(draft().textContent).toContain("result.pdf");
  await clickButton(result(), "Заменить мой ввод сохранёнными значениями");
  expect(field(result(), "body").value).toBe("");
  expect(field(result(), "links").value).toBe("");
  expect(draft().textContent).not.toContain("result.pdf");
  expect(result().textContent).not.toContain("Запись изменилась на сервере");
  await change(field(result(), "body"), "Новый результат");
  await submit(result());
  expect(command).toHaveBeenLastCalledWith(mock!.state.tasks[0].task_id, expect.objectContaining({ expected_revision: 2, file_ids: [], links: [] }));
});


it("private cancellation governs evaluation controls even when the public status differs, and drops a stale evaluation", async () => {
  mock = installMockTransport("leader", { delay: 0 });
  const assignment = { ...mock.state.tasks[0].assignments[0], status: "cancelled" as const };
  let inputs: AssessmentInputs = { ...mock.state.assessments[0], workflow_status: "assigned", workflow_revision: 1 };
  vi.spyOn(tasksApi, "assessment").mockImplementation(async () => structuredClone(inputs));
  const update = vi.spyOn(tasksApi, "updateAssessment").mockImplementation(async (_id, patch) => { inputs = { ...inputs, hours: patch.hours ?? inputs.hours, revision: inputs.revision + 1 };return structuredClone(inputs); });
  page = await mountWorkspace(<AssessmentPanel assignment={assignment} open />);await waitForPage(page);
  const form = page.container.querySelector("form")!;expect(form.querySelector('[name="evaluation"]')).not.toBeNull();
  await change(field(form, "evaluation"), "1");await change(field(form, "hours"), "3");await change(field(form, "reason"), "Уточнили часы");
  inputs = { ...inputs, workflow_status: "cancelled", revision: 2, workflow_revision: 2 };
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["assessments", assignment.assignment_id] }); });await waitForPage(page);
  expect(form.querySelector('[name="evaluation"]')).toBeNull();expect(field(form, "hours").value).toBe("3");
  await clickButton(form, "Сохранить мой ввод с обновлённой версией");await submit(form);await waitForPage(page);
  expect(update).toHaveBeenCalledWith(assignment.assignment_id, { expected_revision: 2, hours: 3, reason: "Уточнили часы" });
});
