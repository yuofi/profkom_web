// @vitest-environment jsdom
import { act } from "react";
import { Routes, Route } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { focusManager } from "@tanstack/react-query";
import { installMockTransport } from "../mocks/transport";
import { mountWorkspace, settle } from "../test/workspace";
import { UserProvider } from "./ctx";
import { TaskPage } from "../pages/Workspace/TaskPages";
import { tasksApi } from "./api/tasks.api";
import { ApiError } from "./api/request";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup(); mock?.restore(); focusManager.setFocused(undefined); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["refresh", "focus", "poll", "independent-role"])("updates an open task after scope change: %s", async (mode) => {
  if (mode === "poll") vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
  mock = installMockTransport("organizer", {delay: 0});
  mock.state.session.access_revision = "member";
  const task = mock.state.tasks[0];
  const get = vi.spyOn(tasksApi, "get");
  page = await mountWorkspace(<UserProvider><Routes><Route path="/tasks/:id" element={<TaskPage />} /></Routes></UserProvider>, {role: "organizer", path: `/tasks/${task.task_id}`});
  await settle(); await settle();
  expect(page.container.textContent).toContain(task.title);
  const count = () => get.mock.calls.length;
  const before = count();
  mock.state.session.access_revision = "not-member";
  if (mode !== "independent-role") {
    get.mockRejectedValue(new ApiError("Scope access revoked", 403));
    vi.spyOn(tasksApi, "comments").mockRejectedValue(new ApiError("Scope access revoked", 403));
  }
  if (mode === "focus") await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  else if (mode === "poll") await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
  else await act(async () => { await page!.client.refetchQueries({queryKey: ["session"]}); });
  await settle(); await settle();
  expect(count()).toBeGreaterThan(before);
  if (mode === "independent-role") expect(page.container.textContent).toContain(task.title);
  else {
    expect(page.container.textContent).not.toContain(task.title);
    expect(page.container.textContent).toContain("Scope access revoked");
    expect(page.container.querySelector("form")).toBeNull();
  }
  const stable = count();
  await act(async () => { await page!.client.refetchQueries({queryKey: ["session"]}); });
  await settle();
  expect(count()).toBe(stable);
});
