// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { TrackerListPage } from "../../pages/Workspace/TrackerList";
import { TrackerTaskPage } from "../../pages/Workspace/TrackerTaskDetail";
import { TrackerTaskCreatePage } from "../../pages/Workspace/TaskCreateForm";
import { TaskQueuePage, TaskQueuesPage } from "../../pages/Workspace/TaskQueuePages";
import { UnresolvedPage } from "../../pages/Workspace/TaskPages";
import { TrackerHomeLink } from "./TrackerHomeLink";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let transport: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;transport?.restore();transport = undefined;vi.restoreAllMocks(); });
const stamp = () => [...page!.container.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === "Профком ВМК · Трекер")!;
function trackerRoutes() {
  return <Routes>
    <Route path="/tasks" element={<TrackerListPage />} />
    <Route path="/tasks/new" element={<TrackerTaskCreatePage />} />
    <Route path="/tasks/queues" element={<TaskQueuesPage />} />
    <Route path="/tasks/queues/:id" element={<TaskQueuePage />} />
    <Route path="/tasks/unresolved" element={<UnresolvedPage />} />
    <Route path="/tasks/:id" element={<TrackerTaskPage />} />
  </Routes>;
}
it.each(["list", "catalog", "queue", "task", "new", "unresolved"])("the %s tracker page keeps a real home link and opens the general task list", async (surface) => {
  transport = installMockTransport("chair", { delay: 0 });
  const paths: Record<string, string> = { list: "/tasks", catalog: "/tasks/queues", queue: "/tasks/queues/queue-tasks", task: `/tasks/${transport.state.tasks[0].task_id}`, new: "/tasks/new?queue_id=queue-tasks", unresolved: "/tasks/unresolved" };
  page = await mountWorkspace(trackerRoutes(), { path: paths[surface] });await waitForPage(page);
  const link = stamp();expect(link).toBeDefined();expect(link.getAttribute("href")).toBe("/tasks");
  await act(async () => link.click());await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Задачи");
});
it("the locked queue screen has the same way back without exposing its tasks", async () => {
  transport = installMockTransport("organizer", { delay: 0 });transport.state.queues[0].is_private = true;transport.state.queues[0].owner = transport.state.people[3];
  page = await mountWorkspace(trackerRoutes(), { path: "/tasks/queues/queue-tasks", role: "organizer" });await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Нет доступа к очереди");expect(page.container.querySelector("table")).toBeNull();
  const link = stamp();expect(link.getAttribute("href")).toBe("/tasks");await act(async () => link.click());await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Задачи");
});
it.each(["ctrlKey", "metaKey"] as const)("%s keeps the anchor's native navigation instead of changing the current route", async (modifier) => {
  page = await mountWorkspace(<Routes><Route path="/source" element={<><TrackerHomeLink /><p>Текущая страница</p></>} /><Route path="/tasks" element={<p>Список открыт</p>} /></Routes>, { path: "/source" });
  const link = stamp(), open = vi.spyOn(window, "open").mockReturnValue(null);
  let intercepted: boolean | undefined;
  // Capture React Router's decision, then stop jsdom from attempting a real browser navigation.
  const nativeNavigation = (event: MouseEvent) => { intercepted = event.defaultPrevented;event.preventDefault(); };
  document.addEventListener("click", nativeNavigation, { once: true });
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, [modifier]: true })));
  expect(link.tagName).toBe("A");expect(link.getAttribute("href")).toBe("/tasks");expect(intercepted).toBe(false);expect(open).not.toHaveBeenCalled();
  expect(page.container.textContent).toContain("Текущая страница");expect(page.container.textContent).not.toContain("Список открыт");
});
