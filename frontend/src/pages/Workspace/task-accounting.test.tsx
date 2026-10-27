// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AssessmentPanel } from "../../components/Workspace/AssessmentPanel";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { createFixtures } from "../../mocks/fixtures";
import { mountWorkspace, change, field, submit, waitForPage } from "../../test/workspace";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { eventsApi } from "../../utils/api/events.api";
import type { Assignment, AssessmentInputs, Task } from "../../utils/api/contract";
import { ApiError } from "../../utils/api/request";
import { TaskSeasonParameter } from "./TaskSeasonParameter";
import { TrackerTaskHistoryDiff } from "./TrackerTaskHistoryDiff";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks(); });
const fixture = () => createFixtures("chair");
const assignment = (extra: Partial<Assignment> = {}): Assignment => ({ ...fixture().tasks[0].assignments[0], capabilities: ["view_assessment_inputs", "review_assignment"], ...extra });
const inputs = (extra: Partial<AssessmentInputs> = {}): AssessmentInputs => ({ ...fixture().assessments[0], hours: 2, workflow_status: "assigned", revision: 7, workflow_revision: 7, capabilities: ["edit_assessment_inputs"], ...extra });
async function mountAccounting(saved: AssessmentInputs, person = assignment(), extra: { hasResult?: boolean; seasonClosed?: boolean } = {}) {
  vi.spyOn(tasksApi, "assessment").mockResolvedValue(saved);
  page = await mountWorkspace(<AssessmentPanel assignment={person} open {...extra} />);await waitForPage(page);return page;
}
async function click(label: string, root: ParentNode = page!.container) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label);
  expect(button).toBeDefined();await act(async () => button!.click());await waitForPage(page!);
}
it("labels private credited/excluded state independently from the public task status", async () => {
  await mountAccounting(inputs({ workflow_status: "accepted", evaluation: 1.5 }), assignment({ status: "cancelled" }));
  expect(page!.container.querySelector('[data-accounting-state="accepted"]')?.textContent).toBe("Зачтено");
  expect(page!.container.textContent).toContain("Изменить");expect(page!.container.textContent).toContain("1.5");
  expect(page!.container.querySelector('a[href="/contacts/101"]')).not.toBeNull();
  await page!.cleanup();page = undefined;
  vi.mocked(tasksApi.assessment).mockResolvedValue(inputs({ workflow_status: "cancelled", evaluation: null }));
  page = await mountWorkspace(<AssessmentPanel assignment={assignment({ status: "accepted" })} open />);await waitForPage(page);
  expect(page.container.textContent).toContain("Исключено из ККР");expect(page.container.querySelector('[name="evaluation"]')).toBeNull();
});
it("a missing private state stays unknown rather than copying an accepted public status", async () => {
  await mountAccounting(inputs({ workflow_status: null, workflow_revision: null }), assignment({ status: "accepted" }));
  expect(page!.container.querySelector('[data-accounting-state="unknown"]')?.textContent).toBe("Состояние не получено");
  expect(page!.container.querySelector('[name="decision"]')).toBeNull();
});
it("saves hours and an explicit KKR decision atomically, clears that one-shot decision and retains saved hours", async () => {
  let saved = inputs({ workflow_status: "needs_revision", evaluation: 1 });
  await mountAccounting(saved);vi.mocked(tasksApi.assessment).mockImplementation(async () => saved);
  const update = vi.spyOn(tasksApi, "updateAssessment").mockImplementation(async (_id, payload) => { saved = { ...saved, hours: payload.hours!, evaluation: payload.evaluation ?? saved.evaluation, workflow_status: "accepted", revision: saved.revision + 1, workflow_revision: saved.revision + 1 };return saved; });
  const publicStatus = vi.spyOn(tasksApi, "changeStatus"), privateCommand = vi.spyOn(tasksApi, "command");
  const form = field(page!.container, "hours").closest("form")!;
  expect(field(form, "evaluation").value).toBe("");expect(form.textContent).toContain("Зачесть · оценка 1");
  await change(field(form, "hours"), "5");await change(field(form, "evaluation"), "1");await change(field(form, "reason"), "Подтверждён результат после доработки");await submit(form);await waitForPage(page!);
  expect(update).toHaveBeenCalledTimes(1);expect(update).toHaveBeenLastCalledWith(assignment().assignment_id, { expected_revision: 7, hours: 5, evaluation: 1, reason: "Подтверждён результат после доработки" });
  expect(field(form, "evaluation").value).toBe("");expect(field(form, "hours").value).toBe("5");expect(publicStatus).not.toHaveBeenCalled();expect(privateCommand).not.toHaveBeenCalled();
  await change(field(form, "hours"), "6");await submit(form);await waitForPage(page!);
  expect(update).toHaveBeenLastCalledWith(assignment().assignment_id, { expected_revision: 8, hours: 6, reason: "Подтверждён результат после доработки" });
});
it("a rejected atomic decision retains hours, reason and selection without issuing another command", async () => {
  await mountAccounting(inputs());const update = vi.spyOn(tasksApi, "updateAssessment").mockRejectedValue(new ApiError("Changed", 409, "revision_conflict"));
  const form = field(page!.container, "hours").closest("form")!;await change(field(form, "hours"), "4");await change(field(form, "evaluation"), "0");await change(field(form, "reason"), "Работа не выполнена");await submit(form);await waitForPage(page!);
  expect(update).toHaveBeenCalledTimes(1);expect(field(form, "hours").value).toBe("4");expect(field(form, "evaluation").value).toBe("0");expect(field(form, "reason").value).toBe("Работа не выполнена");expect(form.textContent).toContain("Запись изменилась");
});
it("excludes only unfinished accounting with its private revision and mandatory reason", async () => {
  let saved = inputs();await mountAccounting(saved, assignment({ revision: 91, status: "accepted" }));vi.mocked(tasksApi.assessment).mockImplementation(async () => saved);
  const command = vi.spyOn(tasksApi, "command").mockImplementation(async () => { saved = { ...saved, workflow_status: "cancelled", workflow_revision: 8, revision: 8 };return assignment({ status: "accepted", revision: 91 }); });
  const form = field(page!.container, "decision").closest("form")!;
  await change(field(form, "decision"), "cancel");await submit(form);expect(command).not.toHaveBeenCalled();
  await change(field(form, "reason"), "Дублирующее назначение");await submit(form);await waitForPage(page!);
  expect(command).toHaveBeenCalledWith(assignment().assignment_id, "cancel", { expected_revision: 7, reason: "Дублирующее назначение" });expect(page!.container.textContent).toContain("Исключено из ККР");
});
it("accepted accounting offers only genuine revision, never cancellation, and requires a note", async () => {
  await mountAccounting(inputs({ workflow_status: "accepted", evaluation: 1 }));
  const select = field(page!.container, "decision") as HTMLSelectElement;expect([...select.options].map(item => item.value)).toEqual(["", "request-revision"]);
  const command = vi.spyOn(tasksApi, "command").mockResolvedValue(assignment());await change(select, "request-revision");const form = select.closest("form")!;await submit(form);expect(command).not.toHaveBeenCalled();
});
it("explains closed-season versioned corrections and keeps the reason mandatory", async () => {
  await mountAccounting(inputs({ workflow_status: "accepted", evaluation: 1 }), assignment(), { seasonClosed: true });
  expect(page!.container.textContent).toContain("создаёт новую версию итогов сезона");const update = vi.spyOn(tasksApi, "updateAssessment");
  const form = field(page!.container, "hours").closest("form")!;await change(field(form, "hours"), "3");await submit(form);expect(update).not.toHaveBeenCalled();
});
it("ordinary readers neither see KKR controls nor request private inputs", async () => {
  const query = vi.spyOn(tasksApi, "assessment");page = await mountWorkspace(<AssessmentPanel assignment={assignment({ capabilities: [] })} />);await waitForPage(page);
  expect(query).not.toHaveBeenCalled();expect(page.container.textContent).toBe("");
});
it("one-shot field reset happens only after success and preserves the other accepted draft", async () => {
  const save = vi.fn(async () => {}).mockRejectedValueOnce(Error("Сеть недоступна"));
  page = await mountWorkspace(<ActionForm resetFieldsOnSuccess={["decision"]} fields={[{ name: "hours", label: "Часы", value: "2" }, { name: "decision", label: "Решение", value: "" }]} onSubmit={save} />);
  const form = page.container.querySelector("form")!;await change(field(form, "hours"), "8");await change(field(form, "decision"), "credit");await submit(form);expect(field(form, "decision").value).toBe("credit");await submit(form);expect(field(form, "decision").value).toBe("");expect(field(form, "hours").value).toBe("8");
});
async function mountSeason(task: Task, allowed = true) {
  vi.spyOn(seasonsApi, "list").mockResolvedValue({ items: fixture().seasons, next_cursor: null });
  const session = fixture().session;session.capabilities = allowed ? [...session.capabilities, "correct_season"] : session.capabilities.filter(cap => cap !== "correct_season");
  page = await mountWorkspace(<dl><TaskSeasonParameter task={task} /></dl>, { session });await waitForPage(page);return page;
}
it("a block task opens contextual season correction with its own revision and no raw-ID field", async () => {
  const task = { ...fixture().tasks[0], scope: { kind: "block" as const, id: "block-1" }, task_key: "IT-3", revision: 29 };
  await mountSeason(task);await click("Изменить сезон");const dialog = page!.container.querySelector("dialog")!;expect(dialog.textContent).toContain(`IT-3 · ${task.title}`);expect(dialog.querySelector('[name="object_id"]')).toBeNull();
});
it("subevent tasks link their actual event hierarchy and independent tasks do not offer unsupported moves", async () => {
  vi.spyOn(eventsApi, "subevent").mockResolvedValue(fixture().subevents[0]);const task = fixture().tasks[0];await mountSeason(task);
  const link = [...page!.container.querySelectorAll("a")].find(item => item.textContent === "Изменить сезон мероприятия");expect(link?.getAttribute("href")).toBe(`/events/${fixture().subevents[0].event_id}`);expect(page!.container.querySelector("button")).toBeNull();
  await page!.cleanup();page = undefined;vi.restoreAllMocks();await mountSeason({ ...task, scope: { kind: "queue", id: "independent" } });expect(page!.container.textContent).toContain("пока не поддерживается");expect(page!.container.querySelector("button")).toBeNull();
});
it("season correction is absent without the current global capability and safe season history remains readable", async () => {
  await mountSeason({ ...fixture().tasks[0], scope: { kind: "block", id: "block-1" } }, false);expect(page!.container.querySelector("button")).toBeNull();await page!.cleanup();page = undefined;
  page = await mountWorkspace(<TrackerTaskHistoryDiff changes={[{ field: "season_id", before: "Весна", after: "Осень" }, { field: "hours", before: "2", after: "10" }]} />);expect(page.container.textContent).toContain("Сезон");expect(page.container.textContent).toContain("Осень");expect(page.container.textContent).not.toContain("hours");
});
