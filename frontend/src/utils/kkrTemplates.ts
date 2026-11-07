import { useQuery } from "@tanstack/react-query";
import { eventsApi } from "./api/events.api";
import type { KkrTemplate } from "./api/profileFeatures.api";
import { normalizeApiError } from "./api/request";

const TEMPLATE_REFUSALS = new Set(["template_changed", "template_archived", "template_scope_mismatch", "template_unavailable"]);
/** The server refused a save because of its applied template, not because of the record (B6). */
export const templateRefused = (error: unknown) => TEMPLATE_REFUSALS.has(normalizeApiError(error).code);

/** The team of the record a template is applied to; `eventId` is a subevent's event. */
export interface TemplateTarget { kind: "block" | "event" | "subevent" | "chair"; id: string | null; eventId?: string | null }

/**
 * Whether the server takes this template for a record of this team, as
 * backend profile_features.capture_template_use does (template_scope_mismatch otherwise):
 * a personal template, a template of «Весь Профком», of this team or of a subevent's event.
 */
export function templateFits(template: KkrTemplate, target: TemplateTarget): boolean {
  if (template.visibility === "personal") return true;
  const scope = template.scope;
  if (!scope) return false;
  if (scope.kind === "global") return true;
  if (!target.id) return false;
  if (scope.kind === "event" && target.kind === "subevent") return !!target.eventId && scope.id === target.eventId;
  // A block task names its block by name, a template by the block's stable id.
  return scope.kind === target.kind && (scope.id === target.id || (scope.kind === "block" && scope.name === target.id));
}

/** The active templates a picker offers for this target (B3, owner 2026-11-08); every active one without a target. */
export function useFittingTemplates(templates: KkrTemplate[] | undefined, target: TemplateTarget | undefined) {
  const subevent = target?.kind === "subevent" && !target.eventId ? target.id : null;
  const eventTemplates = !!templates?.some(row => row.visibility === "team" && row.scope?.kind === "event");
  // The same read as the subevent's team chip; only when an event template could fit.
  const parent = useQuery({ queryKey: ["events", "subevent", subevent], queryFn: () => eventsApi.subevent(subevent!), enabled: !!subevent && eventTemplates });
  const resolved = target && subevent ? { ...target, eventId: parent.data?.event_id ?? null } : target;
  return (templates ?? []).filter(row => !row.archived && (!resolved || templateFits(row, resolved)));
}
