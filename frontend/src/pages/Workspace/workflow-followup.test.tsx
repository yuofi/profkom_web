// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";
import { focusManager } from "@tanstack/react-query";
import { api } from "../../utils/api";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, settle, change } from "../../test/workspace";
import { BlockRequestsPage } from "./MembershipPages";
import { TaskPage } from "./TaskPages";
import { DirectoryPage } from "./DirectoryPages";
import { DashboardPage } from "./WorkspacePages";
import { SeasonBlockerLink } from "../../components/Workspace/SeasonBlockerLink";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  await page?.cleanup();
  restore?.();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

it("recovers a deadline network error manually and refreshes changed capabilities on focus", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  const f = createFixtures("chair");
  const request = {
    ...f.requests[0],
    substitute_available_at: new Date(Date.now() + 1000).toISOString(),
    capabilities: [] as string[],
  };
  let failed = false;
  const adapter = new MockAdapter(api);
  restore = () => adapter.restore();
  adapter.onGet("/blocks").reply(200, f.blocks);
  adapter
    .onGet("/block-requests")
    .reply(() =>
      failed
        ? [
            503,
            {
              detail: {
                code: "unavailable",
                message: "Не удалось загрузить заявки",
              },
            },
          ]
        : [200, { items: [structuredClone(request)], next_cursor: null }],
    );
  page = await mountWorkspace(<BlockRequestsPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  failed = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(page.container.textContent).toContain("Не удалось загрузить заявки");
  failed = false;
  const refresh = Array.from(page.container.querySelectorAll("button")).find(
    (b) => b.textContent === "Обновить заявки",
  )!;
  await act(async () => {
    refresh.click();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(page.container.querySelector('[role="alert"]')).toBeNull();
  request.capabilities = ["block_review_request"];
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(page.container.textContent).toContain("Одобрить вступление");
});

it("refreshes at each stage boundary without locally granting review or spinning on an expired deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  const f = createFixtures("chair");
  const request = {
    ...f.requests[0],
    state: "pending_hr",
    substitute_available_at: new Date(Date.now() + 1000).toISOString(),
    capabilities: [] as string[],
  };
  const adapter = new MockAdapter(api);
  restore = () => adapter.restore();
  adapter
    .onGet("/block-requests")
    .reply(() => [
      200,
      { items: [structuredClone(request)], next_cursor: null },
    ]);
  adapter.onGet("/blocks").reply(200, f.blocks);
  page = await mountWorkspace(<BlockRequestsPage />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(page.container.textContent).not.toContain("Одобрить этап HR");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(990);
  });
  expect(
    adapter.history.get.filter((r) => r.url === "/block-requests"),
  ).toHaveLength(2);
  expect(page.container.textContent).not.toContain("Одобрить этап HR");
  request.state = "pending_block";
  request.substitute_available_at = new Date(Date.now() + 2000).toISOString();
  await act(async () => {
    await page!.client.refetchQueries({ queryKey: ["blockRequests"] });
    await vi.advanceTimersByTimeAsync(10);
  });
  request.capabilities = ["block_review_request"];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(page.container.textContent).toContain("Одобрить вступление");
  const count = adapter.history.get.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(adapter.history.get).toHaveLength(count);
});

it.each(["accepted", "in_progress"] as const)(
  "links a %s assignment blocker to its actual task and focuses it",
  async (status) => {
    const mock = installMockTransport("chair", { delay: 0 });
    restore = mock.restore;
    const a = mock.state.tasks[0].assignments[0];
    a.status = status;
    page = await mountWorkspace(
      <Routes>
        <Route
          path="/"
          element={
            <SeasonBlockerLink
              seasonId="season-1"
              blocker={{
                kind: "missing_assessment",
                owner_kind: "assignment",
                owner_id: a.assignment_id,
                title: "Не хватает оценки",
              }}
            />
          }
        />
        <Route path="/tasks/:id" element={<TaskPage />} />
      </Routes>,
    );
    await settle();
    const link = page.container.querySelector("a")!;
    expect(link.getAttribute("href")).toContain(
      `assignment_id=${a.assignment_id}`,
    );
    expect(link.getAttribute("href")).not.toContain("unresolved");
    await act(async () => link.click());
    await settle();
    expect(page.container.textContent).toContain("К закрытию сезона");
    expect(document.activeElement?.getAttribute("aria-label")).toContain(
      a.assignee.display_name,
    );
  },
);

it("explains an unavailable assignment instead of opening an unrelated queue", async () => {
  const mock = installMockTransport("chair", { delay: 0 });
  restore = mock.restore;
  page = await mountWorkspace(
    <SeasonBlockerLink
      seasonId="season-1"
      blocker={{
        kind: "missing_assessment",
        owner_kind: "assignment",
        owner_id: "gone",
        title: "Нет оценки",
      }}
    />,
  );
  await settle();
  expect(page.container.textContent).toContain("Объект недоступен");
  expect(page.container.querySelector("a")).toBeNull();
});

it("combines contact category with search/block filters and shows an accurate empty state", async () => {
  const mock = installMockTransport("chair", { delay: 0 });
  restore = mock.restore;
  page = await mountWorkspace(<DirectoryPage />);
  await settle();
  await settle();
  const category = Array.from(page.container.querySelectorAll("select")).find(
    (s) => s.parentElement?.textContent?.startsWith("Категория"),
  )!;
  await change(category, "activist");
  await settle();
  expect(page.container.textContent).toContain("Подходящих контактов нет");
  await change(category, "junior");
  await settle();
  expect(page.container.textContent).toContain(
    mock.state.people[0].display_name.split(" ")[0],
  );
  await change(
    page.container.querySelector("input")!,
    "несуществующий участник",
  );
  expect(page.container.textContent).toContain("Подходящих контактов нет");
});

it("filters meetings and assignment queues by season along with tasks, while keeping global requests explicit", async () => {
  const mock = installMockTransport("chair", { delay: 0 });
  restore = mock.restore;
  page = await mountWorkspace(<DashboardPage />);
  await settle();
  await settle();
  const selector = page.container.querySelector("select")!;
  const other = mock.state.seasons.find(
    (s) =>
      s.season_id !== mock.state.events[0].season_id && s.state !== "closed",
  )!;
  await change(selector, other.season_id);
  await settle();
  expect(page.container.textContent).not.toContain(
    mock.state.meetings[0].title,
  );
  expect(page.container.textContent).toContain(
    "В выбранных сезонах созвонов нет",
  );
  expect(page.container.textContent).toContain("не зависят от сезона");
});
