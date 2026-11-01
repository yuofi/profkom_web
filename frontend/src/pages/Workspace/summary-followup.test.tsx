// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { seasonsApi } from "../../utils/api/seasons.api";
import { tasksApi } from "../../utils/api/tasks.api";
import { directoryApi } from "../../utils/api/directory.api";
import {
  emptyCriteria,
  richText,
  type MeritCreate,
} from "../../utils/api/contract";
import { QueryClient } from "@tanstack/react-query";
import {
  change,
  field,
  pick,
  mountWorkspace,
  settle,
  submit,
} from "../../test/workspace";
import { CorrectionsPage, MeritForm } from "./MeritPages";
import { DecisionBadges } from "./SeasonPages";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport>;
afterEach(async () => {
  await page?.cleanup();
  mock?.restore();
});
const meritInput = (): MeritCreate => ({
  season_id: "season-1",
  source_kind: "block_volunteer",
  scope: { kind: "block", id: "info" },
  title: "Волонтёрская работа",
  description: richText("Описание"),
  assigned_at: "2026-10-01T10:00:00Z",
  deadline_at: "2026-10-10T10:00:00Z",
  criteria: emptyCriteria(),
  recipients: [
    {
      user_id: 101,
      hours: 2,
      evaluation: 1,
      completed_at: "2026-10-02T10:00:00Z",
    },
  ],
  reason: "Работа учтена",
});
async function openCorrections(kind: string) {
  mock = installMockTransport("chair", { delay: 0 });
  const merit = await seasonsApi.createMerit(meritInput());
  mock.state.seasons.find((s) => s.season_id === "season-1")!.state = "closed";
  // Only accepted or not completed assignments carry an evaluation to correct (SE-10).
  for (const assignment of mock.state.tasks[0].assignments) assignment.status = "accepted";
  page = await mountWorkspace(
    <Routes>
      <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
    </Routes>,
    { path: "/seasons/season-1/corrections" },
  );
  await settle();
  await settle();
  await change(page.container.querySelector("select")!, kind);
  const id =
    kind === "merit"
      ? merit.merit_id
      : kind === "task_inputs"
        ? mock.state.tasks[0].task_id
        : mock.state.assessments[0].assignment_id;
  await pick(page.container, "correction_object", id);
  await settle();
  return { id, merit };
}

it.each(["assessment_inputs", "task_inputs", "merit"])(
  "submits a populated %s correction with object revision and summary version, then rereads it",
  async (kind) => {
    const { id } = await openCorrections(kind);
    const container = page!.container;
    if (kind === "assessment_inputs") {
      await change(field(container, "hours"), "7");
      await change(field(container, "evaluation"), "1");
      await change(field(container, "completed"), "2026-10-02T13:00");
    }
    if (kind === "task_inputs") {
      expect(field(container, "assigned").value).not.toBe("");
      await change(field(container, "creative"), "true");
    }
    if (kind === "merit")
      await change(field(container, "title"), "Исправленная заслуга");
    await change(field(container, "reason"), "Исправлены исходные данные");
    const before = (await seasonsApi.summary("season-1")).version;
    await submit(container.querySelector("form")!);
    const request = mock.adapter.history.post.find((r) =>
      r.url?.endsWith("/summary/correct"),
    )!;
    expect(request, container.textContent ?? "").toBeDefined();
    const payload = JSON.parse(request.data);
    expect(payload).toMatchObject({
      expected_version: before,
      reason: "Исправлены исходные данные",
      changes: [{ kind, id, expected_revision: 1 }],
    });
    expect(payload.changes[0].values).not.toHaveProperty("score");
    expect((await seasonsApi.summary("season-1")).version).toBe(before + 1);
    if (kind === "assessment_inputs")
      expect((await tasksApi.assessment(id)).hours).toBe(7);
    if (kind === "task_inputs")
      expect((await tasksApi.inputs(id)).criteria.creative).toBe(true);
    if (kind === "merit")
      expect((await seasonsApi.merit(id)).title).toBe("Исправленная заслуга");
    expect(container.textContent).toContain("Изменения сохранены");
  },
);

it("offers only accountable tasks and evaluated assignments to correct, with a searchable picker", async () => {
  await openCorrections("assessment_inputs");
  const task = mock.state.tasks[0];
  task.assignments[1].status = "cancelled";
  mock.state.tasks.push({ ...structuredClone(task), task_id: "control-epic", title: "ККР · Контроль", capabilities: task.capabilities.filter((cap) => cap !== "view_assessment_inputs" && cap !== "edit_assessment_inputs") });
  await page!.client.invalidateQueries({ queryKey: ["tasks", "closed-correction", "season-1"] });await settle();await settle();
  const picker = page!.container.querySelector<HTMLElement>('[data-entity-picker][data-field-name="correction_object"]')!;
  const input = picker.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await act(async () => { input.focus();input.click(); });await settle();
  const choices = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((option) => option.textContent ?? "");
  expect(choices).toHaveLength(1);
  expect(choices[0]).toContain(`${task.assignments[0].assignee.display_name} · ${task.title}`);
  await change(page!.container.querySelector("select")!, "task_inputs");
  await act(async () => { const box = page!.container.querySelector<HTMLInputElement>('[data-field-name="correction_object"] [role="combobox"]')!;box.focus();box.click(); });await settle();
  const tasks = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((option) => option.textContent ?? "");
  expect(tasks).not.toContain("ККР · Контроль");
  expect(tasks).toContain(task.title);
});

it("finds the task to correct with a server search of 20 instead of listing the season, and keeps the chosen task's name (PF-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.seasons.find((s) => s.season_id === "season-1")!.state = "closed";
  const base = mock.state.tasks[0];
  for (const assignment of base.assignments) assignment.status = "accepted";
  // 45 more accountable tasks: listing the whole season would take three pages of 20.
  for (let n = 1; n <= 45; n++) mock.state.tasks.push({ ...structuredClone(base), task_id: `task-extra-${n}`, task_key: `EX-${n}`, title: `Дополнительная задача ${n}` });
  // A KKR control epic keeps no accounting of its own: the server search leaves it out.
  mock.state.tasks.push({ ...structuredClone(base), task_id: "control-epic", task_key: "KKR-1", title: "ККР · EX-4 контроль", queue: { queue_id: "queue-kkr", name: "ККР", key: "KKR" } });
  page = await mountWorkspace(
    <Routes>
      <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
    </Routes>,
    { path: "/seasons/season-1/corrections" },
  );
  await settle();
  await settle();
  const container = page.container;
  const reads = () => mock.adapter.history.get.filter((r) => r.url === "/tasks");
  // Opening the form reads one page of 20 without facets and never pages through the season.
  expect(reads().map((r) => r.params)).toEqual([{ season_id: "season-1", limit: 20, include_facets: false, exclude_kkr_control: true }]);
  await change(container.querySelector("select")!, "task_inputs");
  const box = () => container.querySelector<HTMLInputElement>('[data-field-name="correction_object"] [role="combobox"]')!;
  const choices = () => [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((option) => option.textContent ?? "");
  const search = async (text: string) => {
    await act(async () => { box().focus();box().click(); });
    await change(box(), text);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    await settle();
    await settle();
  };
  await search("EX-4");
  expect(reads().at(-1)!.params).toEqual({ season_id: "season-1", q: "EX-4", limit: 20, include_facets: false, exclude_kkr_control: true });
  // The server matched the keys; the picker shows its matches without filtering the titles again.
  expect(choices()).toHaveLength(7);
  expect(choices()).toContain("Дополнительная задача 4");
  expect(choices()).not.toContain("ККР · EX-4 контроль");
  await pick(container, "correction_object", "task-extra-4");
  await settle();
  const chip = () => container.querySelector('[data-field-name="correction_object"] [data-selected-value="task-extra-4"]')?.textContent;
  expect(field(container, "assigned").value).not.toBe("");
  await search("задача 1");
  expect(choices()).not.toContain("Дополнительная задача 4");
  expect(chip()).toContain("Дополнительная задача 4");
  // Saving a correction rereads the search; the open correction still names its task.
  await change(field(container, "creative"), "true");
  await change(field(container, "reason"), "Исправлены критерии");
  await submit(container.querySelector("form")!);
  await settle();
  expect(container.textContent).toContain("Изменения сохранены");
  expect(chip()).toContain("Дополнительная задача 4");
  expect(container.textContent).not.toContain("Выбранное значение недоступно");
  expect(reads().every((r) => r.params?.limit === 20 && !r.params?.cursor && r.params?.season_id === "season-1" && r.params?.exclude_kkr_control === true)).toBe(true);
});

it("finds an assignment to correct by the person's name in the season's assessments the page already holds (PF-06)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.seasons.find((s) => s.season_id === "season-1")!.state = "closed";
  const task = mock.state.tasks[0];
  for (const assignment of task.assignments) assignment.status = "accepted";
  // Only the first assignment has a saved evaluation (an accounted assessment); the second has none.
  Object.assign(mock.state.assessments[0], { evaluation: 1, effective_completed_at: "2026-10-02T10:00:00Z" });
  // Another person's accepted work whose assessment row the reader does not get (a hidden source).
  mock.state.tasks.push({ ...structuredClone(task), task_id: "task-hidden-inputs", task_key: "HID-1", title: "Скрытые исходные данные",
    assignments: [{ ...structuredClone(task.assignments[0]), assignment_id: "assignment-hidden", assignee: { user_id: 103, display_name: "Мария Орлова", avatar_url: null } }] });
  page = await mountWorkspace(
    <Routes>
      <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
    </Routes>,
    { path: "/seasons/season-1/corrections" },
  );
  await settle();
  await settle();
  const container = page.container;
  const person = task.assignments[0].assignee.display_name;
  const box = () => container.querySelector<HTMLInputElement>('[data-field-name="correction_object"] [role="combobox"]')!;
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
  const search = async (text: string) => {
    await act(async () => { box().focus();box().click(); });
    await change(box(), text);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    await settle();
    await settle();
  };
  const assessmentReads = () => mock.adapter.history.get.filter((r) => r.url === "/assessments").length;
  const before = assessmentReads();
  await search(person.split(" ")[1].toLowerCase());
  // The task search on the server knows no person; the page's own assessments do.
  expect(mock.adapter.history.get.filter((r) => r.url === "/tasks").at(-1)!.params).toMatchObject({ q: person.split(" ")[1].toLowerCase(), limit: 20 });
  expect(options().map((option) => option.textContent)).toEqual([`${person} · ${task.title} · 2 ч / оценка 1`]);
  expect(assessmentReads()).toBe(before);
  await search("Орлова");
  expect(options()).toHaveLength(0);
  // A title word also finds the task on the server: its rows come first and the assessment's row only once.
  await search("материалы");
  expect(options().map((option) => option.dataset.optionValue)).toEqual(["assignment-1", "assignment-2"]);
  // Words may combine the person and the task, as in the label.
  await search("материалы смирнова");
  expect(options().map((option) => option.dataset.optionValue)).toEqual(["assignment-1"]);
  await search(person.split(" ")[1]);
  await pick(container, "correction_object", "assignment-1");
  await settle();
  expect(field(container, "hours").value).toBe("2");
  expect(container.querySelector('[data-field-name="correction_object"] [data-selected-value="assignment-1"]')?.textContent).toContain(person);
});

it("after a correction the chip of an assignment found by the person's name shows the saved hours and evaluation (PF-06 review)", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.seasons.find((s) => s.season_id === "season-1")!.state = "closed";
  const task = mock.state.tasks[0];
  for (const assignment of task.assignments) assignment.status = "accepted";
  Object.assign(mock.state.assessments[0], { evaluation: 1, effective_completed_at: "2026-10-02T10:00:00Z" });
  // 25 earlier tasks fill the season's first 20 matches: the chosen row is found only by the person's name.
  for (let n = 1; n <= 25; n++) mock.state.tasks.unshift({ ...structuredClone(task), task_id: `task-early-${n}`, task_key: `EA-${n}`, title: `Ранняя задача ${n}`, deadline_at: "2026-10-05T10:00:00Z", assignments: [] });
  page = await mountWorkspace(
    <Routes>
      <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
    </Routes>,
    { path: "/seasons/season-1/corrections" },
  );
  await settle();
  await settle();
  const container = page.container;
  const person = task.assignments[0].assignee.display_name;
  const box = () => container.querySelector<HTMLInputElement>('[data-field-name="correction_object"] [role="combobox"]')!;
  const search = async (text: string) => {
    await act(async () => { box().focus();box().click(); });
    await change(box(), text);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    await settle();
    await settle();
  };
  const chip = () => container.querySelector('[data-field-name="correction_object"] [data-selected-value="assignment-1"]')?.textContent;
  await search(person.split(" ")[1]);
  await pick(container, "correction_object", "assignment-1");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  await settle();
  await settle();
  expect(chip()).toBe(`${person} · ${task.title} · 2 ч / оценка 1`);
  // The cleared search offers the season's first 20 tasks, without the chosen one.
  await act(async () => { box().focus();box().click(); });
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  expect(document.querySelector('[role="listbox"] [data-option-value="assignment-1"]')).toBeNull();
  await act(async () => { box().blur(); });
  await change(field(container, "hours"), "3");
  await change(field(container, "reason"), "Исправлены часы");
  await submit(container.querySelector("form")!);
  await settle();
  await settle();
  expect(container.textContent).toContain("Изменения сохранены");
  expect(mock.state.assessments[0].hours).toBe(3);
  expect(chip()).toBe(`${person} · ${task.title} · 3 ч / оценка 1`);
});

it.each(["assessment_inputs", "merit"])(
  "keeps an unchanged %s correction from writing a duplicate summary version",
  async (kind) => {
    await openCorrections(kind);
    const container = page!.container;
    const button = () => container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    await change(field(container, "reason"), "Повтор без изменений");
    expect(button().disabled).toBe(true);
    if (kind === "merit") await change(field(container, "title"), "Исправленная заслуга");
    else { await change(field(container, "hours"), "7");await change(field(container, "evaluation"), "0"); }
    expect(button().disabled).toBe(false);
    await submit(container.querySelector("form")!);
    expect(container.textContent).toContain("Изменения сохранены");
    const saved = (await seasonsApi.summary("season-1")).version;
    await change(field(container, "reason"), "Повтор без изменений");
    expect(button().disabled).toBe(true);
    expect(mock.adapter.history.post.filter((r) => r.url?.endsWith("/summary/correct"))).toHaveLength(1);
    expect((await seasonsApi.summary("season-1")).version).toBe(saved);
  },
);

it("preserves a correction draft through 409 and an explicit version refresh before retry", async () => {
  await openCorrections("assessment_inputs");
  const container = page!.container;
  await change(field(container, "hours"), "9");
  await change(field(container, "evaluation"), "0");
  await change(field(container, "reason"), "Исправление после проверки");
  mock.state.assessments[0].revision++;
  await submit(container.querySelector("form")!);
  expect(
    container.querySelector('[role="alert"]'),
    container.textContent ?? "",
  ).not.toBeNull();
  expect(container.textContent).not.toContain("Изменения сохранены");
  expect(field(container, "hours").value).toBe("9");
  const refresh = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Обновить данные",
  )!;
  await act(async () => refresh.click());
  await settle();
  expect(field(container, "hours").value).toBe("9");
  await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Сохранить мой ввод с обновлённой версией")!.click());
  await submit(container.querySelector("form")!);
  expect(
    (await tasksApi.assessment(mock.state.assessments[0].assignment_id)).hours,
  ).toBe(9);
  expect(container.textContent).toContain("Изменения сохранены");
});

it.each(["assessment_inputs", "task_inputs", "merit"])("holds record and summary versions across a foreign closed correction: %s", async kind => {
  const { id } = await openCorrections(kind);
  const container = page!.container;
  const form = container.querySelector("form")!;
  const name = kind === "assessment_inputs" ? "hours" : kind === "task_inputs" ? "creative" : "title";
  const value = kind === "assessment_inputs" ? "8" : kind === "task_inputs" ? "true" : "МОЯ ПРАВКА";
  await change(field(form, name), value);
  if (kind === "assessment_inputs") await change(field(form, "evaluation"), "0");
  await change(field(form, "reason"), "МОЯ ПРИЧИНА");
  const before = await seasonsApi.summary("season-1");
  const foreign = await seasonsApi.correctSummary("season-1", {expected_version: before.version, reason: "Чужая правка", changes: [{kind: kind as "task_inputs" | "assessment_inputs" | "merit", id, expected_revision: 1, values: kind === "assessment_inputs" ? {hours: 99} : kind === "task_inputs" ? {criteria: emptyCriteria()} : {title: "Чужое название"}}]});
  await act(async () => { await page!.client.invalidateQueries(); }); await settle();
  const posts = () => mock.adapter.history.post.filter(r => r.url?.endsWith("/summary/correct"));
  const count = posts().length;
  expect(field(form, name).value).toBe(value);
  await submit(form);
  expect(posts()).toHaveLength(count);
  await act(async () => Array.from(form.querySelectorAll("button")).find(b => b.textContent === "Сохранить мой ввод с обновлённой версией")!.click());
  await submit(form);
  expect(posts()).toHaveLength(count + 1);
  expect(JSON.parse(posts().at(-1)!.data)).toMatchObject({expected_version: foreign.version, changes: [{expected_revision: foreign.applied_revisions[0].revision}]});
  // After the save the form equals the stored record, so it waits for a real change before another version.
  expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  await change(field(form, name), kind === "assessment_inputs" ? "6" : kind === "task_inputs" ? "false" : "ЕЩЁ ОДНА ПРАВКА");
  expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
});

it("preserves input and never reports success when the server rejects a correction with 422", async () => {
  await openCorrections("task_inputs");
  const container = page!.container;
  await change(field(container, "reason"), "Проверка ошибки");
  mock.adapter.resetHandlers();
  mock.adapter.onPost(/summary\/correct$/).reply(422, {
    detail: { code: "invalid_input", message: "Сервер отклонил дату" },
  });
  await submit(container.querySelector("form")!);
  expect(container.textContent).toContain("Сервер отклонил дату");
  expect(field(container, "reason").value).toBe("Проверка ошибки");
  expect(container.textContent).not.toContain("Изменения сохранены");
});

it("shows recipient inputs only for two selected people out of 100 and preserves values across deselection", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const contact = (await directoryApi.contacts())[0];
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(
    ["contacts"],
    Array.from({ length: 100 }, (_, i) => ({
      ...contact,
      user_id: 1001 + i,
      surname: "Участник",
      name: String(i + 1),
      in_profcom: true,
    })),
  );
  page = await mountWorkspace(<MeritForm seasonId="season-1" />, { client });
  await settle();
  await settle();
  const container = page.container;
  await change(
    field(container, "scope"),
    mock.state.blocks.find((b) =>
      b.capabilities.includes("create_volunteer_merit"),
    )!.block_id,
  );
  expect(container.querySelectorAll('[name^="hours_"]')).toHaveLength(0);
  await pick(container, "users", "1001");
  await pick(container, "users", "1002");
  expect(
    container.querySelectorAll(
      '[name^="hours_"], [name^="evaluation_"], [name^="completed_"]',
    ),
  ).toHaveLength(6);
  await change(field(container, "hours_1001"), "3");
  await change(field(container, "evaluation_1001"), "0");
  await pick(container, "users", "1001", false);
  expect(container.querySelector('[name="hours_1001"]')).toBeNull();
  await pick(container, "users", "1001");
  expect(field(container, "hours_1001").value).toBe("3");
  await change(field(container, "hours_1002"), "5");
  await change(field(container, "evaluation_1002"), "-1");
  for (const [name, value] of Object.entries({
    title: "Помощь",
    body: "Описание работы",
    assigned: "2026-10-01T13:00",
    deadline: "2026-10-10T13:00",
  }))
    await change(field(container, name), value);
  await submit(container.querySelector("form")!);
  const records = (await seasonsApi.merits()).items;
  expect(records, container.textContent ?? "").toHaveLength(1);
  expect(
    [...records[0].recipients].sort((a, b) => a.user_id - b.user_id),
  ).toEqual([
    { user_id: 1001, hours: 3, evaluation: 0, completed_at: null },
    { user_id: 1002, hours: 5, evaluation: -1, completed_at: null },
  ]);
});

it("retains an existing recipient missing from today's directory during merit editing", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const data = meritInput();
  data.recipients[0].user_id = 9999;
  const existing = await seasonsApi.createMerit(data);
  page = await mountWorkspace(
    <MeritForm seasonId="season-1" existing={existing} />,
  );
  await settle();
  expect(page.container.textContent).toContain("Участник #9999");
  expect(field(page.container, "hours_9999").value).toBe("2");
  await change(
    field(page.container, "reason"),
    "Исправление сохранённой записи",
  );
  await submit(page.container.querySelector("form")!);
  expect(
    (await seasonsApi.merit(existing.merit_id)).recipients[0].user_id,
  ).toBe(9999);
});

it("renders all decision names and an explicit empty set", async () => {
  page = await mountWorkspace(
    <>
      <DecisionBadges
        values={["golden_red_bull", "kick_warning", "kick", "nice"]}
      />
      <DecisionBadges values={[]} />
    </>,
  );
  for (const title of [
    "Золотой Red Bull",
    "Предупреждение о кике",
    "Кик",
    "Найс",
    "Нет отметок",
  ])
    expect(page.container.textContent).toContain(title);
});

it.each([
  ["hr", true],
  ["hr-deputy", false],
] as const)("SE-13: the closed-season corrections page follows correct_summary for %s", async (role, allowed) => {
  mock = installMockTransport(role, { delay: 0 });
  mock.state.seasons.find((s) => s.season_id === "season-1")!.state = "closed";
  page = await mountWorkspace(
    <Routes>
      <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
    </Routes>,
    { path: "/seasons/season-1/corrections", role },
  );
  await settle();
  await settle();
  expect(page.container.textContent?.includes("Тип исправления")).toBe(allowed);
  expect(page.container.textContent?.includes("Исправление закрытого сезона доступно председателю, его заместителям и мастеру HR.")).toBe(!allowed);
});

it("SE-13: the corrections page of a season that is not closed says it is not closed yet, not who may correct", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  mock.state.seasons.find((s) => s.season_id === "season-1")!.state = "open";
  page = await mountWorkspace(
    <Routes>
      <Route path="/seasons/:id/corrections" element={<CorrectionsPage />} />
    </Routes>,
    { path: "/seasons/season-1/corrections", role: "chair" },
  );
  await settle();
  await settle();
  expect(page.container.textContent).toContain("Сезон ещё не закрыт");
  expect(page.container.textContent).not.toContain("Тип исправления");
});
