/** Bounded, reference-only telemetry. Never record form values, headers or messages. */
export type DiagnosticEvent = { kind: "navigation" | "action" | "api" | "error"; at: number; code: string; route: string; method: "" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; status: number | null };
const events: DiagnosticEvent[] = [];
export function clearDiagnostics() { events.length = 0; }
const safeCode = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 120);
export function diagnosticRoute(value: string) {
  const path = value.split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+/, "");
  return path.split("/").map(part => !part ? "" : /^(?:[0-9]+|[0-9a-f]{8}-|task-|queue-|feedback-)/i.test(part) ? ":id" : /^[a-z][a-z0-9_-]{0,40}$/i.test(part) ? part : ":item").join("/").slice(0, 240) || "/";
}
export function recordDiagnostic(kind: DiagnosticEvent["kind"], code = "", route = "", method: DiagnosticEvent["method"] = "", status: number | null = null) {
  events.push({ kind, code: safeCode(code), route: diagnosticRoute(route), method, status, at: Date.now() });
  while (events.length > 100 || events[0] && events[0].at < Date.now() - 120000) events.shift();
}
export function recordApiDiagnostic(method: string | undefined, route: string | undefined, status: number | null) {
  const verb = method?.toUpperCase() ?? "";
  recordDiagnostic("api", status === null ? "network_error" : "response", route ?? "", ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(verb) ? verb as DiagnosticEvent["method"] : "", status);
}
export function snapshotDiagnostics(path: string) {
  const current = Date.now();
  const version = safeCode(import.meta.env.VITE_RELEASE_SHA || (import.meta.env.DEV ? "local" : "unversioned"));
  const params = new URLSearchParams(window.location.search), tab = params.get("tab") ?? "";
  const tabs = ["analytics", "history", "comments", "attachments", "tasks", "summary", "participants", "sources"];
  const filterKeys = { status: "status", priority: "priority", task_type: "task_type", mine: "mine", queue_id: "queue", block_id: "block", event_id: "event", q: "search", season_id: "season", type: "type" } as const;
  const open_layers: ("dialog" | "popover" | "menu")[] = [];
  if (document.querySelector("dialog[open],[role=dialog]")) open_layers.push("dialog");
  if (document.querySelector("[data-anchored-popover]")) open_layers.push("popover");
  if (document.querySelector("[role=menu]")) open_layers.push("menu");
  return { version, route: diagnosticRoute(path), width: window.innerWidth, height: window.innerHeight,
    screen: { active_tab: tabs.includes(tab) ? tab : "", open_layers, filters: Object.entries(filterKeys).filter(([key]) => params.has(key)).map(([, code]) => code) },
    events: events.filter(event => event.at >= current - 120000).slice(-100) };
}

