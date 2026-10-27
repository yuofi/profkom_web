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
  await change(page.container.querySelectorAll("select")[1], id);
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
