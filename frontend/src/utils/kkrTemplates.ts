import { normalizeApiError } from "./api/request";

const TEMPLATE_REFUSALS = new Set(["template_changed", "template_archived", "template_scope_mismatch", "template_unavailable"]);
/** The server refused a save because of its applied template, not because of the record (B6). */
export const templateRefused = (error: unknown) => TEMPLATE_REFUSALS.has(normalizeApiError(error).code);
