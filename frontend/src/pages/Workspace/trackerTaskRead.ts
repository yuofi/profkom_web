import { tasksApi } from "../../utils/api/tasks.api";
import { loadPlanningTasks, planningMonth, planningRange } from "./trackerPlanning";

// Kept out of trackerPlanning (part of the entry chunk) so it loads with the tracker list only.
/** The task read of a tracker address: one page of the list, or every planning page of the
 *  calendar/Gantt. The list page reads it; a queue page starts it together with the queue's
 *  own read under the same key (PF-14). `search` is the settled search of the list. */
export function trackerTaskRead(params: URLSearchParams, queueId: string | undefined, search = params.get("q") ?? "") {
  const view: "list" | "calendar" | "gantt" = params.get("view") === "calendar" ? "calendar" : params.get("view") === "gantt" ? "gantt" : "list";
  const month = planningMonth(params.get("month")), zoom: "week" | "month" = params.get("zoom") === "month" ? "month" : "week";
  const range = planningRange(month, view === "calendar" ? "calendar" : "gantt", zoom);
  const cursor = params.get("cursor") ?? "";
  const filters = {
    queue_id: queueId ?? params.get("queue_id") ?? "",
    mine: params.get("mine") ?? "false",
    status: params.get("status") ?? "",
    season_id: params.get("season_id") ?? "",
    scope_kind: params.get("scope_kind") ?? "",
    scope_id: params.get("scope_id") ?? "",
    assignee_user_id: params.get("assignee_user_id") ?? "",
    q: params.get("q") ?? "",
    task_type: params.get("task_type") ?? "",
    priority: params.get("priority") ?? "",
    favorite: params.get("favorite") ?? "",
    unfinished: params.get("unfinished") ?? "false",
    overdue: params.get("overdue") ?? "false",
    sort: params.get("sort") ?? "deadline",
    order: params.get("order") ?? "asc",
    limit: 20,
    ...(cursor ? { cursor } : {}),
  };
  const requestFilters = Object.fromEntries(Object.entries({ ...filters, q: search }).filter(([, value]) => value !== ""));
  // Pages come without facets; the filter panel reads them for its selection only (PF-19).
  const listFilters = { ...requestFilters, include_facets: false };
  return {
    view, month, zoom, range, cursor, filters, requestFilters,
    list: { queryKey: ["tasks", "page", listFilters], queryFn: ({ signal }: { signal: AbortSignal }) => tasksApi.listPage(listFilters, signal) },
    planning: { queryKey: ["tasks", "planning", requestFilters, range.first, range.last], queryFn: ({ signal }: { signal: AbortSignal }) => loadPlanningTasks(requestFilters, range, signal) },
  };
}
