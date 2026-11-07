// @vitest-environment jsdom
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtures } from "../../mocks/fixtures";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import type { CalendarItem, Task, TaskPublicStatus, TrackerTaskRef } from "../../utils/api/contract";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { TrackerTaskRelations } from "./TrackerTaskRelations";
import { WorkdayTasks } from "./WorkdayTasks";
import { TrackerPlanPreview } from "./TrackerPlanPreview";
import { CalendarItemLink } from "./CalendarViews";
import { TrackerCalendar } from "./TrackerCalendar";
import { TrackerGantt } from "./TrackerGantt";
import { planningRange } from "./trackerPlanning";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks();vi.useRealTimers(); });
const tones: Record<TaskPublicStatus, string> = { open: "lilac", in_progress: "sky", completed: "peach", closed: "mint" };
const names: Record<TaskPublicStatus, string> = { open: "Открыта", in_progress: "В работе", completed: "Выполнена", closed: "Закрыта" };
const statuses = Object.keys(tones) as TaskPublicStatus[];
const task = (status: TaskPublicStatus, index = 0): Task => ({ ...createFixtures("chair").tasks[0], task_id: `badge-${status}-${index}`, task_key: `ITWEB-${index + 1}`, title: `Задача ${names[status]}`, status, starts_at: "2026-10-05T21:30:00Z", deadline_at: "2026-10-09T12:00:00Z", task_type: "task", priority: "normal", links: [], children: [] });
const ref = (status: TaskPublicStatus, index: number): TrackerTaskRef => ({ task_id: `ref-${status}`, task_key: `REF-${index + 1}`, title: `Связь ${names[status]}`, status, deadline_at: null, starts_at: null, task_type: "task" });
const badges = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-status]")].filter(item => item.tagName === "SPAN");
const expectBadge = (badge: HTMLElement | undefined, status: TaskPublicStatus) => {
  expect(badge?.textContent).toBe(names[status]);expect(badge?.getAttribute("data-status")).toBe(status);
  expect(badge?.style.getPropertyValue("--tone")).toBe(`var(--accent-${tones[status]})`);
  // A badge is read-only: nothing to press or focus.
  expect(badge?.closest("button")).toBeNull();expect(badge?.getAttribute("tabindex")).toBeNull();expect(badge?.getAttribute("role")).toBeNull();
};

it("the badge shows the four public statuses in the status chip's tones and maps old assignment statuses", async () => {
  page = await mountWorkspace(<div>{statuses.map(status => <TaskStatusBadge key={status} status={status} />)}<TaskStatusBadge status="submitted" /><TaskStatusBadge status={null} /></div>);
  const shown = badges(page.container);
  statuses.forEach((status, index) => expectBadge(shown[index], status));
  expectBadge(shown[4], "completed");expectBadge(shown[5], "open");
});
it("subtasks and related tasks show coloured statuses", async () => {
  const children = statuses.map(ref);
  const source: Task = { ...task("open"), capabilities: [], children, links: [{ link_id: "link-1", kind: "related", task: ref("closed", 9) }, { link_id: "link-2", kind: "blocked_by", task: ref("in_progress", 8) }] };
  page = await mountWorkspace(<TrackerTaskRelations task={source} onEditParent={() => {}} />);
  const subtasks = [...page.container.querySelectorAll("h3")].find(heading => heading.textContent === "Подзадачи")!.parentElement!;
  badges(subtasks).forEach((badge, index) => expectBadge(badge, statuses[index]));expect(badges(subtasks)).toHaveLength(4);
  const related = [...page.container.querySelectorAll("h3")].find(heading => heading.textContent === "Связана с")!.parentElement!;
  expectBadge(badges(related)[0], "closed");
  const blocking = [...page.container.querySelectorAll("h3")].find(heading => heading.textContent === "Зависит от")!.parentElement!;
  expectBadge(badges(blocking)[0], "in_progress");
});
it("the home task list, the plan preview and the calendar preview show coloured statuses", async () => {
  page = await mountWorkspace(<Routes><Route path="/" element={<><WorkdayTasks tasks={statuses.map(task)} now={Date.parse("2026-10-06T10:00:00Z")} /><section aria-label="preview"><TrackerPlanPreview task={task("completed")} /></section></>} /></Routes>);
  const rows = [...page.container.querySelectorAll("li")];
  rows.forEach((row, index) => expectBadge(badges(row)[0], statuses[index]));
  const preview = page.container.querySelector('[aria-label="preview"]')!;
  expectBadge(badges(preview)[0], "completed");expect(preview.textContent).toContain("Задача · Средний");
  await page.cleanup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const item: CalendarItem = { id: "task-1", season_id: "season-1", kind: "task_deadline", title: "Дедлайн задачи", task_key: "ITWEB-1", starts_at: "2026-10-09T12:00:00Z", ends_at: null, target: { kind: "task", id: "badge-closed-0" }, status: "closed" };
  page = await mountWorkspace(<CalendarItemLink item={item} season="Осень" />);
  const anchor = page.container.querySelector("a")!;
  anchor.parentElement!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));anchor.parentElement!.dispatchEvent(new MouseEvent("mouseenter"));
  await vi.advanceTimersByTimeAsync(1000);await waitForPage(page);
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip).not.toBeNull();expectBadge(badges(tooltip!)[0], "closed");
});
it("calendar and Gantt colour every public status with the chip's tone, not only «В работе»", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));
  transport = installMockTransport("chair", { delay: 0 });
  const tasks = statuses.map(task);
  page = await mountWorkspace(<Routes><Route path="/" element={<TrackerCalendar tasks={tasks} month="2026-10" range={planningRange("2026-10", "calendar")} onMonth={() => {}} />} /></Routes>);await waitForPage(page);
  for (const status of statuses) {
    const link = page.container.querySelector<HTMLAnchorElement>(`a[data-status="${status}"]`)!;
    expect(link.style.getPropertyValue("--tone")).toBe(`var(--accent-${tones[status]})`);
  }
  await page.cleanup();
  page = await mountWorkspace(<Routes><Route path="/" element={<TrackerGantt tasks={tasks} range={planningRange("2026-10", "gantt")} month="2026-10" onMonth={() => {}} zoom="week" onZoom={() => {}} />} /></Routes>);await waitForPage(page);
  for (const status of statuses) {
    const bar = page.container.querySelector<HTMLAnchorElement>(`a[data-status="${status}"]`)!;
    expect(bar.style.getPropertyValue("--tone")).toBe(`var(--accent-${tones[status]})`);expect(bar.style.left).not.toBe("");
  }
});
