// export const getDocRoute = (name: string) => {
//     return `/docs/${name}`;
// }

export const getDocRoute = (id: string | number = ":id") => {
  return `/docs/${id}`;
};

export const getAdminTabRoute = (tab: string | number = ":tab") => {
  return `/admin/${tab}`;
};

export const getDocEditRoute = (id: string | number = ":id") => {
  return `/docs/${id}/edit`;
};

export const getHomeRoute = () => "/";
export const getProfilePage = () => "/profile";
export const getContactRoute = (id: number | string) => `/contacts/${encodeURIComponent(id)}`;
export const getPgasRoute = () => "/pgas";

export const getEventRoute = (id: string) =>
  `/events/${encodeURIComponent(id)}`;
export const getEventCreateRoute = () => "/events/new";
export const getEventEditRoute = (id: string) => `/events/${encodeURIComponent(id)}/edit`;
export const getMeetingRoute = (kind: "event" | "subevent", id: string) =>
  `/meetings/${kind}/${encodeURIComponent(id)}`;
export const getSubeventRoute = (id: string) =>
  `/subevents/${encodeURIComponent(id)}`;
export const getTaskRoute = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const getTaskCreateRoute = ({ queueId, scope, parentTaskId }: { queueId?: string; scope?: { kind: "block" | "subevent"; id: string }; parentTaskId?: string } = {}) => {
  const query = new URLSearchParams();
  if (queueId) query.set("queue_id", queueId);
  if (scope) { query.set("scope_kind", scope.kind);query.set("scope_id", scope.id); }
  if (parentTaskId) query.set("parent_task_id", parentTaskId);
  return `/tasks/new${query.size ? `?${query}` : ""}`;
};
export const getTaskQueuesRoute = () => "/tasks/queues";
export const getTaskQueueRoute = (id: string) => `/tasks/queues/${encodeURIComponent(id)}`;
export const getBlockRoute = (id: string) =>
  `/blocks/${encodeURIComponent(id)}`;
export const getReportRoute = (id: string) =>
  `/reports/${encodeURIComponent(id)}`;
export const getMaterialRoute = (id: string) =>
  `/materials/${encodeURIComponent(id)}`;
export const getMaterialCreateRoute = () => "/materials/new";
export const getSeasonRoute = (id: string) =>
  `/seasons/${encodeURIComponent(id)}`;
export const getSeasonCreateRoute = () => "/seasons/new";
export function targetRoute(
  target: { kind: string; id: string } | null | undefined,
): string | null {
  if (!target || typeof target.id !== "string" || !target.id) return null;
  const builders: Record<string, (id: string) => string> = {
    event: getEventRoute,
    subevent: getSubeventRoute,
    task: getTaskRoute,
    task_queue: getTaskQueueRoute,
    block: getBlockRoute,
    report: getReportRoute,
    material: getMaterialRoute,
    season: getSeasonRoute,
  };
  return Object.hasOwn(builders, target.kind)
    ? builders[target.kind](target.id)
    : null;
}

// export const pages = [
//   { name: "guides", text: "гайды" },
//   { name: "KMB", text: "кмб" },
//   { name: "information", text: "информация" },
// ];
