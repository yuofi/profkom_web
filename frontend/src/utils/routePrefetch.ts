import { useRef } from "react";
import { useQueryClient, type Query, type QueryClient, type QueryFunction } from "@tanstack/react-query";
import { tasksApi } from "./api/tasks.api";
import { referenceStaleTime } from "./api/invalidation";

/** The modules App.tsx loads lazily for each route. Importing one here again starts its
 *  download early; the browser keeps one copy, so the page then renders without waiting. */
const routeCode: [RegExp, () => Promise<unknown>][] = [
  [/^\/(calendar|notifications)?$/, () => import("../pages/Workspace/WorkspacePages")],
  [/^\/tasks\/?$/, () => import("../pages/Workspace/TrackerList")],
  [/^\/tasks\/unresolved$/, () => import("../pages/Workspace/UnresolvedPage")],
  [/^\/tasks\/queues(\/|$)/, () => import("../pages/Workspace/TaskQueuePages")],
  [/^\/tasks\/new$/, () => import("../pages/Workspace/TaskCreateForm")],
  [/^\/tasks\/[^/]+$/, () => import("../pages/Workspace/TrackerTaskDetail")],
  [/^\/(events|subevents)(\/|$)/, () => import("../pages/Workspace/EventPages")],
  [/^\/contacts(\/former)?$/, () => import("../pages/Workspace/DirectoryPages")],
  [/^\/contacts\/[^/]+$/, () => import("../pages/Workspace/MemberProfilePage")],
  [/^\/materials(\/|$)/, () => import("../pages/Workspace/MaterialPages")],
  [/^\/blocks(\/|$)/, () => import("../pages/Workspace/MembershipPages")],
  [/^\/(merits$|seasons\/[^/]+\/(merits|sources|corrections)$)/, () => import("../pages/Workspace/MeritPages")],
  [/^\/seasons(\/|$)/, () => import("../pages/Workspace/SeasonPages")],
  [/^\/(reports|meetings)(\/|$)/, () => import("../pages/Workspace/ReportPages")],
  [/^\/pgas$/, () => import("../pages/Pgas/PgasPage")],
  [/^\/admin(\/|$)/, () => import("../pages/Admin/AdminPage")],
  [/^\/broadcasts(\/|$)/, () => import("../pages/Workspace/BroadcastPages")],
  [/^\/bot$/, () => import("../pages/Workspace/BotConsolePage")],
  [/^\/support$/, () => import("../pages/Workspace/SupportPage")],
  [/^\/profile$/, () => import("../pages/ProfilePage/ProfilePage")],
  [/^\/profile\/settings$/, () => import("../pages/ProfilePage/ProfileSettingsPage")],
  [/^\/profile\/edit$/, () => import("../pages/ProfileEditPage/ProfileEditPage")],
];
/** Starts loading the code of a route (on hover, focus, a click or the first load) (PF-04).
 *  A failed early load is ignored: the page itself reports it when it is opened. */
export function preloadRouteCode(pathname: string) {
  const entry = routeCode.find(([pattern]) => pattern.test(pathname));
  if (entry) void entry[1]().catch(() => undefined);
}

/** Data started by a prefetch counts as current for a short while, so the page mounting
 *  right after it does not read it a second time. Afterwards the usual rules apply. */
const PREFETCH_FRESH_MS = 10_000;
const prefetched = new Map<string, number>();
export const workspaceStaleTime = (query: Query) => {
  const at = prefetched.get(query.queryHash);
  if (at !== undefined && Date.now() - at < PREFETCH_FRESH_MS) return PREFETCH_FRESH_MS;
  if (at !== undefined) prefetched.delete(query.queryHash);
  return referenceStaleTime(query);
};
/** Starts a read for a page about to mount, or for a part a page mounts later (the queue
 *  page and its task list, PF-14); that reader then joins it instead of asking again. */
export function prefetchRead(client: QueryClient, queryKey: readonly unknown[], queryFn: QueryFunction) {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (query && (query.state.fetchStatus !== "idle" || Date.now() - query.state.dataUpdatedAt < PREFETCH_FRESH_MS)) return;
  const started = Date.now();
  void client.prefetchQuery({ queryKey, queryFn }).then(() => {
    const current = client.getQueryCache().find({ queryKey, exact: true });
    if (current?.state.status === "success" && current.state.dataUpdatedAt >= started) prefetched.set(current.queryHash, current.state.dataUpdatedAt);
  });
}
/** A task and its comments, the same queries the task page reads, side by side. */
export function prefetchTask(client: QueryClient, taskId: string) {
  prefetchRead(client, ["tasks", taskId], () => tasksApi.get(taskId));
  prefetchRead(client, ["tasks", taskId, "comments"], () => tasksApi.comments(taskId));
}
/** The first data of a route, started with its code instead of after it. Call it only
 *  inside the workspace layout, i.e. for a confirmed active session (READ_PATHS.md). */
export function prefetchRouteData(client: QueryClient, pathname: string) {
  const task = /^\/tasks\/([^/]+)$/.exec(pathname);
  if (task && !["new", "queues", "unresolved"].includes(task[1])) prefetchTask(client, decodeURIComponent(task[1]));
}
/** Hover or focus resting on a task row: its code and the task start loading before the
 *  click; the comments start with the click itself (prefetchRouteData). Passing over rows on
 *  the way elsewhere starts nothing, nor does resting on a control of the row such as a
 *  person's chip (`ignore`): that hover is meant for the control, not for opening the task. */
export function useTaskPrefetch(ignore?: (target: EventTarget | null) => boolean) {
  const client = useQueryClient(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => { clearTimeout(timer.current);timer.current = undefined; };
  const start = (taskId: string) => (event: { target: EventTarget | null }) => {
    cancel();
    if (ignore?.(event.target)) return;
    timer.current = setTimeout(() => { preloadRouteCode("/tasks/task");prefetchRead(client, ["tasks", taskId], () => tasksApi.get(taskId)); }, 120);
  };
  return (taskId: string) => ({ onPointerOver: start(taskId), onPointerLeave: cancel, onFocus: start(taskId), onBlur: cancel });
}
