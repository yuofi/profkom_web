import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { createFixtures, type MockRole } from "../../mocks/fixtures";
import { SessionContext } from "../../utils/session";
import { TaskPage } from "./TaskPages";
import { SourcesPage, CorrectionsPage } from "./MeritPages";
import { AccountArchivePage } from "./DirectoryPages";
import { RegistrationsPage } from "./MembershipPages";
import { ProtectedRoute } from "../Wrappers/wrappers";
function renderPage(
  role: MockRole,
  element: ReactNode,
  path: string,
  pattern: string,
) {
  const f = createFixtures(role);
  const manager = createFixtures("chair");
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
    },
  });
  client.setQueryData(["tasks", "task-1"], f.tasks[0]);
  client.setQueryData(["tasks", "task-1", "comments"], {
    items: [],
    next_cursor: null,
  });
  client.setQueryData(["assessments", "task", "task-1"], manager.inputs);
  manager.assessments.forEach((a) =>
    client.setQueryData(["assessments", a.assignment_id], a),
  );
  client.setQueryData(["assessments", "sources", "season-1"], {
    items: [
      {
        contribution_id: "private",
        source_title: "Закрытые баллы",
        score: 999,
        user: f.people[0],
        capabilities: [],
      },
    ],
    next_cursor: null,
  });
  client.setQueryData(["summary", "season-1"], {
    ...manager.summary,
    capabilities: ["correct_summary"],
  });
  client.setQueryData(["archivedAccounts"], {
    items: [
      { user_id: 555, display_name: "Закрытое имя", archived_at: "2026-01-01" },
    ],
    next_cursor: null,
  });
  client.setQueryData(["registrations", "queue"], {
    items: [
      {
        ...manager.registration,
        fields: { ...manager.registration.fields, name: "Закрытая заявка" },
      },
    ],
    next_cursor: null,
  });
  client.setQueryData(["registrations", "me"], f.registration);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SessionContext.Provider
          value={{
            session: f.session,
            loading: false,
            error: null,
            refresh: () => {},
          }}
        >
          <Routes>
            <Route path={pattern} element={element} />
          </Routes>
        </SessionContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}
describe("Rendered authorization with a deliberately stale private cache", () => {
  it("does not render cached hours, criteria or bulk actions for an organizer", () => {
    const html = renderPage(
      "organizer",
      <TaskPage />,
      "/tasks/task-1",
      "/tasks/:id",
    );
    expect(html).toContain("Сдать результат");
    expect(html).not.toContain("Исходные поля оценивания");
    expect(html).not.toContain("Установить часы");
    expect(html).not.toContain("Даты и признаки");
  });
  it("renders separate public status controls and private assessment forms for an authorized task manager", () => {
    const html = renderPage(
      "leader",
      <TaskPage />,
      "/tasks/task-1",
      "/tasks/:id",
    );
    expect(html).toContain("Статус задачи: Открыта");
    expect(html).not.toContain("Исходные поля оценивания");
    expect(html).toContain("Открыта");
  });
  it.each([
    [
      <SourcesPage />,
      "/seasons/season-1/sources",
      "/seasons/:id/sources",
      "Закрытые баллы",
    ],
    [
      <CorrectionsPage />,
      "/seasons/season-1/corrections",
      "/seasons/:id/corrections",
      "Оцениваемое назначение",
    ],
    [
      <AccountArchivePage />,
      "/accounts/archive",
      "/accounts/archive",
      "Закрытое имя",
    ],
    [
      <RegistrationsPage />,
      "/registrations",
      "/registrations",
      "Закрытая заявка",
    ],
  ])(
    "hides cached private page data without current capabilities",
    (element, path, pattern, privateText) => {
      expect(
        renderPage("organizer", element, path as string, pattern as string),
      ).not.toContain(privateText);
    },
  );
  it("gates pending and rejected sessions before rendering the workspace outlet", () => {
    for (const role of ["pending", "rejected"] as const) {
      const html = renderPage(role, <ProtectedRoute />, "/", "*");
      expect(html).toContain(
        role === "pending"
          ? "Заявка на рассмотрении"
          : "Нужно уточнить сведения",
      );
      expect(html).not.toContain("Мои задачи");
      expect(html).not.toContain("Основная навигация");
    }
  });
});
