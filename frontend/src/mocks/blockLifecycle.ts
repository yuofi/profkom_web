import type { Block } from "../utils/api/contract";
import { richText } from "../utils/api/contract";
import type { createFixtures, MockRole } from "./fixtures";
import { createClientId } from "../utils/clientId";

/** Synthetic lifecycle only; real authority and durable timers are on the backend. */
export function blockLifecycleMock(state: ReturnType<typeof createFixtures>, role: MockRole) {
  const leadership = role === "chair" || role === "chair-deputy";
  if (leadership) state.session.capabilities.push("create_block");
  const decorate = (block: Block) => {
    block.archived_at ??= null;block.deletion_request ??= null;
    block.capabilities = block.capabilities.filter(cap => !["rename_block", "start_block_deletion"].includes(cap));
    if (block.archived_at) block.capabilities = block.capabilities.filter(cap => ["view_tasks", "read_guide"].includes(cap));
    else if (leadership) block.capabilities.push("rename_block", "start_block_deletion");
    const request = block.deletion_request;
    if (request) request.capabilities = leadership && ["pending", "scheduled"].includes(request.state) ? ["cancel_block_deletion", ...(request.state === "pending" && !request.approvals.some(approval => approval.actor.user_id === state.session.user_id) ? ["approve_block_deletion"] : [])] : [];
    return block;
  };
  state.blocks.forEach(decorate);
  type Reply = [number, unknown];
  const fail = (code: string, status = 409): Reply => [status, { detail: { code, message: code } }];
  return { decorate, handle(path: string, method: string, data: Record<string, unknown>): Reply | undefined {
    if (path === "/blocks" && method === "post") {
      if (!leadership) return fail("forbidden", 403);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name || name.length > 120 || /[,/\\]/.test(name) || [...name].some(char => char.charCodeAt(0) < 32)) return fail("invalid_block_name", 422);
      if (state.blocks.some(block => block.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return fail("name_taken");
      const block: Block = { block_id: `block-${createClientId()}`, name, is_hr: false, description: data.description as Block["description"] ?? richText(""), community_url: data.community_url as string | null ?? null, master: null, members: [], guide_material_id: null, revision: 1, capabilities: ["edit_block", "manage_leaders", "view_tasks"] };
      state.blocks.push(decorate(block));return [200, structuredClone(block)];
    }
    const match = /^\/blocks\/([^/]+)\/deletion-request(?:\/(approve|cancel))?$/.exec(path);
    if (!match || method !== "post") return;
    const block = state.blocks.find(item => item.block_id === decodeURIComponent(match[1]));
    if (!block) return fail("not_found", 404);
    if (!leadership) return fail("block_deletion_human_required", 403);
    if (data.expected_revision !== block.revision) return fail("revision_conflict");
    if (block.archived_at) return fail("block_archived");
    const request = block.deletion_request, at = new Date().toISOString();
    if (!match[2]) {
      if (request && ["pending", "scheduled"].includes(request.state)) return fail("block_deletion_pending");
      block.deletion_request = { request_id: createClientId(), state: "pending", revision: 1, created_at: at, scheduled_at: null, delete_after: null, finished_at: null, cancel_reason: null, approvals: [{ actor: state.user, at }], capabilities: [] };
    } else {
      if (!request || request.request_id !== data.request_id) return fail("block_deletion_request_changed");
      if (!["pending", "scheduled"].includes(request.state)) return fail("block_deletion_terminal");
      if (match[2] === "approve") {
        if (request.state !== "pending") return fail("block_deletion_already_scheduled");
        if (request.approvals.some(item => item.actor.user_id === state.session.user_id)) return fail("block_deletion_self_approval", 403);
        request.approvals.push({ actor: state.user, at });request.state = "scheduled";request.scheduled_at = at;request.delete_after = new Date(Date.parse(at) + 72 * 3600_000).toISOString();
      } else { request.state = "cancelled";request.finished_at = at;request.cancel_reason = "cancelled_by_leader"; }
      request.revision++;
    }
    block.revision++;return [200, structuredClone(decorate(block))];
  } };
}
