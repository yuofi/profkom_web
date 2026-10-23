// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { afterEach, expect, it } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { tasksApi } from "../../utils/api/tasks.api";
import { reportsApi } from "../../utils/api/reports.api";
import { materialsApi } from "../../utils/api/materials.api";
import { guidesApi } from "../../utils/api/guides.api";
import { membershipApi } from "../../utils/api/membership.api";
import { emptyCriteria, richText } from "../../utils/api/contract";
import { UserContext } from "../../utils/me";
import {
  change,
  field,
  mountWorkspace,
  settle,
  submit,
} from "../../test/workspace";
import { TaskPage } from "./TaskPages";
import { ReportPage } from "./ReportPages";
import { MaterialPage, MaterialsPage } from "./MaterialPages";
import { BlockRequestsPage } from "./MembershipPages";
import { DocEditPage } from "../DocEditPage/DocEditPage";
import { PgasPage } from "../Pgas/PgasPage";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let other: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport>;
afterEach(async () => {
  await page?.cleanup();
  await other?.cleanup();
  page = undefined;
  other = undefined;
  mock?.restore();
});
function form(container: ParentNode, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.type === "submit" && b.textContent === label,
  );
  if (!button?.form) throw Error(`Missing form: ${label}`);
  return button.form;
}
async function click(container: ParentNode, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  if (!button) throw Error(`Missing button ${label}`);
  await act(async () => button.click());
  await settle();
}

it("completes submission, revision, resubmission and acceptance through the UI without changing another assignee", async () => {
  mock = installMockTransport("leader", { delay: 0 });
  const task = await tasksApi.create({
    season_id: "season-1",
    scope: { kind: "subevent", id: mock.state.subevents[0].subevent_id },
    title: "Задача приёмки",
    description: richText("Описание"),
    deadline_at: "2026-10-25T12:00:00Z",
    criteria: emptyCriteria(),
    assignees: [
      { user_id: mock.state.session.user_id, hours: 2 },
      { user_id: 101, hours: 3 },
    ],
  });
  page = await mountWorkspace(
    <Routes>
      <Route path="/tasks/:id" element={<TaskPage />} />
    </Routes>,
    { role: "leader", path: `/tasks/${task.task_id}` },
  );
  await settle();
  const own = () =>
    Array.from(
      page!.container.querySelectorAll<HTMLElement>("[aria-label]"),
    ).find(
      (e) =>
        e.getAttribute("aria-label") ===
        `Назначение: ${mock.state.user.display_name}`,
    )!;
  await submit(form(own(), "Начать работу"));
  let submission = form(own(), "Отправить на проверку");
  await change(field(submission, "body"), "Первая сдача");
  await submit(submission);
  let review = form(own(), "Сохранить");
  await change(field(review, "decision"), "request-revision");
  await change(field(review, "note"), "Добавить подробности");
  await submit(review);
  expect(own().textContent).toContain("На доработке");
  expect(own().textContent).toContain("Первая сдача");
  submission = form(own(), "Отправить на проверку");
  await change(field(submission, "body"), "Исправленная сдача");
  await submit(submission);
  review = form(own(), "Сохранить");
  await change(field(review, "decision"), "accept:1");
  await change(field(review, "note"), "Принято");
  await submit(review);
  const saved = await tasksApi.get(task.task_id);
  expect(saved.assignments[0].status).toBe("accepted");
  expect(saved.assignments[0].submissions.map((s) => s.text.body)).toEqual([
    "Первая сдача",
    "Исправленная сдача",
  ]);
  expect(saved.assignments[1].status).toBe("assigned");
  expect(saved.assignments[1].submissions).toHaveLength(0);
  expect(
    (await tasksApi.assessment(saved.assignments[0].assignment_id))
      .effective_completed_at,
  ).toBe(saved.assignments[0].submissions[1].submitted_at);
});

it("keeps two editor drafts through a conflict and version refresh, publishes explicitly, then removes revoked editing", async () => {
  mock = installMockTransport("leader", { delay: 0 });
  const report = mock.state.reports[0];
  const previous = report.content.body;
  const element = (
    <Routes>
      <Route path="/reports/:id" element={<ReportPage />} />
    </Routes>
  );
  page = await mountWorkspace(element, {
    role: "leader",
    path: `/reports/${report.report_id}`,
  });
  other = await mountWorkspace(element, {
    role: "leader",
    path: `/reports/${report.report_id}`,
  });
  await settle();
  await change(field(page.container, "body"), "Черновик редактора А");
  await change(field(other.container, "body"), "Черновик редактора Б");
  await submit(form(page.container, "Сохранить черновик"));
  expect((await reportsApi.get(report.report_id)).content.body).toBe(previous);
  await submit(form(other.container, "Сохранить черновик"));
  expect(other.container.querySelector('[role="alert"]')).not.toBeNull();
  await click(other.container, "Обновить данные");
  expect(field(other.container, "body").value).toBe("Черновик редактора Б");
  await click(form(other.container, "Сохранить черновик"), "Сохранить мой ввод с обновлённой версией");
  await submit(form(other.container, "Сохранить черновик"));
  await click(form(other.container, "Опубликовать сохранённый отчёт"), "Сохранить мой ввод с обновлённой версией");
  await submit(form(other.container, "Опубликовать сохранённый отчёт"));
  expect((await reportsApi.get(report.report_id)).content.body).toBe(
    "Черновик редактора Б",
  );
  const versions = (await reportsApi.versions(report.report_id)).items;
  expect(versions.map((v) => v.content.body)).toEqual([
    previous,
    "Черновик редактора Б",
  ]);
  report.capabilities = [];
  await act(async () => {
    await page!.client.refetchQueries({ queryKey: ["reports"] });
    await other!.client.refetchQueries({ queryKey: ["reports"] });
  });
  await settle();
  expect(page.container.querySelector('[name="body"]')).toBeNull();
  expect(other.container.querySelector('[name="body"]')).toBeNull();
  expect(await reportsApi.get(report.report_id)).not.toHaveProperty(
    "draft_content",
  );
});

it("preserves changed task criteria and deadline when refreshing a conflicting input revision", async () => {
  // The chair moves dates; an area lead does not (УВ-5).
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(
    <Routes>
      <Route path="/tasks/:id" element={<TaskPage />} />
    </Routes>,
    { role: "chair", path: `/tasks/${mock.state.tasks[0].task_id}` },
  );
  await settle();
  const editor = field(page.container, "assigned").closest("form")!;
  await change(field(editor, "creative"), "true");
  await change(field(editor, "deadline"), "2026-10-26T18:00");
  await change(field(editor, "reason"), "Уточнён дедлайн");
  mock.state.inputs.revision++;
  await submit(editor);
  expect(editor.querySelector('[role="alert"]')).not.toBeNull();
  await click(editor, "Обновить данные");
  expect(field(editor, "creative").value).toBe("true");
  expect(field(editor, "deadline").value).toBe("2026-10-26T18:00");
  await click(editor, "Сохранить мой ввод с обновлённой версией");
  await submit(editor);
  const saved = await tasksApi.inputs(mock.state.tasks[0].task_id);
  expect(saved.criteria.creative).toBe(true);
  expect(saved.deadline_at).toBe("2026-10-26T15:00:00.000Z");
});

it("creates, edits, publishes and deletes a material through available routes", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(
    <Routes>
      <Route path="/materials" element={<MaterialsPage />} />
      <Route path="/materials/:id" element={<MaterialPage />} />
    </Routes>,
    { path: "/materials" },
  );
  await settle();
  const create = form(page.container, "Создать черновик");
  for (const [name, value] of Object.entries({
    title: "Материал приёмки",
    description: "Описание",
    kind: "general",
  }))
    await change(field(create, name), value);
  await submit(create);
  await settle();
  const material = mock.state.materials.find(
    (m) => m.title === "Материал приёмки",
  )!;
  const body = page.container.querySelector("textarea")!;
  await change(body, "**Текст материала**");
  await submit(form(page.container, "Сохранить черновик"));
  expect(
    (await materialsApi.get(material.material_id)).published_content,
  ).toBeNull();
  await submit(form(page.container, "Опубликовать сохранённый черновик"));
  expect(
    (await materialsApi.get(material.material_id)).published_content?.body,
  ).toBe("**Текст материала**");
  await submit(form(page.container, "Удалить материал"));
  await settle();
  expect(
    (await materialsApi.list()).items.some(
      (m) => m.material_id === material.material_id,
    ),
  ).toBe(false);
  expect(page.container.querySelector("h1")?.textContent).toBe("Материалы");
  // Deletion is reversible: the chair restores it from the deleted list (decision 18).
  await settle();
  const deleted = Array.from(page.container.querySelectorAll("details")).find(
    (d) => d.querySelector("summary")?.textContent === "Удалённые материалы",
  )!;
  expect(deleted.textContent).toContain("Материал приёмки");
  await submit(form(deleted, "Восстановить"));
  await settle();
  expect(
    (await materialsApi.get(material.material_id)).published_content?.body,
  ).toBe("**Текст материала**");
  expect(page.container.textContent).toContain("Удалённых материалов нет.");
});

it("explains immediate legacy publication and preserves guide text including Markdown extensions", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const guide = await guidesApi.create({
    title: "Старый гайд",
    owner_block: "none",
    text: "Исходный текст",
  });
  page = await mountWorkspace(
    <Routes>
      <Route path="/docs/:id/edit" element={<DocEditPage />} />
    </Routes>,
    { path: `/docs/${guide.guide_id}/edit` },
  );
  await settle();
  expect(page.container.textContent).toContain(
    "изменения сразу видны читателям",
  );
  const body =
    "**Текст**\n\n```gallery\nhttps://example.com/image.png\n```\n\n```chip\nИмя: Анна\n```\n";
  await change(page.container.querySelector("textarea")!, body);
  await submit(form(page.container, "Опубликовать изменения гайда"));
  expect((await guidesApi.getById(guide.guide_id)).text).toBe(body);
  await guidesApi.delete(guide.guide_id);
  expect(
    (await guidesApi.getAll()).some((g) => g.guide_id === guide.guide_id),
  ).toBe(false);
});

it("finishes an HR request in one UI approval without adding a second stage", async () => {
  mock = installMockTransport("hr", { delay: 0 });
  const request = await membershipApi.join("block-hr");
  page = await mountWorkspace(<BlockRequestsPage />, { role: "hr" });
  await settle();
  const card = Array.from(page.container.querySelectorAll("section")).find(
    (s) => s.textContent?.includes("→ HR"),
  )!;
  await submit(form(card, "Одобрить этап HR"));
  expect(
    mock.state.requests.find((r) => r.request_id === request.request_id)?.state,
  ).toBe("approved");
  expect(page.container.textContent).not.toContain("Одобрить вступление");
});

it("retains the separate PGAS page and its own management permission", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  page = await mountWorkspace(
    <HelmetProvider>
      <UserContext.Provider value={mock.state.profile}>
        <PgasPage />
      </UserContext.Provider>
    </HelmetProvider>,
    { role: "organizer" },
  );
  await settle();
  expect(page.container.textContent).toContain("ПГАС");
  expect(page.container.textContent).not.toContain("Добавить документ");
  expect(mock.adapter.history.get.some((r) => r.url === "/pgas")).toBe(true);
});
