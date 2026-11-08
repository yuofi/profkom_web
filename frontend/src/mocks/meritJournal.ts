/** GET /merits/history of the demo (B9, owner 2026-11-08): each saved edit of a merit record
 *  (PATCH /merits/{id}, a closed season's correction) is kept with its changes as the server's
 *  journal shows them, a minute after the previous one. No hidden versions in the demo. */
import type { HistoryChange, HistoryEntry, Merit, MeritJournalItem, MeritTeam, UserRef } from "../utils/api/contract";
import type { Fixtures } from "./fixtures";
import { mockNow } from "./fixtures";

type Reply = [number, unknown];
type Recipient = Merit["recipients"][number];
const fail = (status: number, code: string, message: string): Reply => [status, { detail: { code, message } }];
const moment = (value: string | null | undefined) => value ? Date.parse(value) : null;
const flags = (merit: Merit) => merit.criteria as unknown as Record<string, boolean>;
const recipientOf = (change: HistoryChange) => ((change.after ?? change.before) as { user?: UserRef } | null)?.user?.user_id ?? null;

export function meritJournalMock(state: Fixtures, readable: () => Merit[]) {
  const edits: { merit_id: string; entry: HistoryEntry }[] = [];
  const person = (userId: number): UserRef => structuredClone(state.people.find(item => item.user_id === userId) ?? { user_id: null, display_name: "Бывший участник", avatar_url: null });
  /** As the server: an added or removed recipient whole, a kept one by the inputs that changed. */
  const recipients = (before: Recipient[], after: Recipient[]): HistoryChange[] => {
    const old = new Map(before.map(item => [item.user_id, item])), next = new Map(after.map(item => [item.user_id, item]));
    return [...old.keys(), ...[...next.keys()].filter(user => !old.has(user))].flatMap((user): HistoryChange[] => {
      const was = old.get(user), now = next.get(user);
      if (was && now) {
        const keys = (["hours", "evaluation", "completed_at"] as const).filter(key =>
          key === "completed_at" ? moment(was.completed_at) !== moment(now.completed_at) : was[key] !== now[key]);
        const pick = (item: Recipient) => ({ user: person(user), ...Object.fromEntries(keys.map(key => [key, item[key] ?? null])) });
        return keys.length ? [{ field: "recipients", label: "Исходные поля получателя", before: pick(was), after: pick(now) }] : [];
      }
      const whole = (item?: Recipient) => item ? { user: person(user), hours: item.hours, evaluation: item.evaluation, completed_at: item.completed_at ?? null } : null;
      return [{ field: "recipients", label: now ? "Добавлен получатель" : "Убран получатель", before: whole(was), after: whole(now) }];
    });
  };
  /** The changed fields in the server's order (by name); criteria by the flags that changed. */
  const changes = (before: Merit, after: Merit): HistoryChange[] => {
    const criteria = [...new Set([...Object.keys(flags(before)), ...Object.keys(flags(after))])].filter(key => !!flags(before)[key] !== !!flags(after)[key]);
    const pick = (merit: Merit) => Object.fromEntries(criteria.map(key => [key, !!flags(merit)[key]]));
    return [
      ...(moment(before.assigned_at) !== moment(after.assigned_at) ? [{ field: "assigned_at", label: "Дата выдачи", before: before.assigned_at, after: after.assigned_at }] : []),
      ...(criteria.length ? [{ field: "criteria", label: "Критерии", before: pick(before), after: pick(after) }] : []),
      ...(moment(before.deadline_at) !== moment(after.deadline_at) ? [{ field: "deadline_at", label: "Дедлайн", before: before.deadline_at, after: after.deadline_at }] : []),
      ...(before.description.body !== after.description.body ? [{ field: "description", label: "Описание", before: before.description.body, after: after.description.body }] : []),
      ...recipients(before.recipients, after.recipients),
      ...(before.title !== after.title ? [{ field: "title", label: "Название", before: before.title, after: after.title }] : []),
    ];
  };
  const remember = (before: Merit, after: Merit, reason: string) => {
    const found = changes(before, after);
    if (!found.length) return;
    const source = `fixture-merit-edit-${String(edits.length + 1).padStart(4, "0")}`;
    edits.push({ merit_id: after.merit_id, entry: { id: `audit:${source}`, source_kind: "audit", source_id: source, target: { kind: "merit", id: after.merit_id },
      changed_by: structuredClone(state.user), created_at: new Date(Date.parse(mockNow) + (edits.length + 1) * 60_000).toISOString(),
      description: "Изменены исходные поля ККР", changes: found, reason, hidden: false, hidden_by: null, hidden_at: null, revision: 1, can_hide: false } });
  };
  const team = (merit: Merit): MeritTeam => {
    if (merit.source_kind === "chair_merit") return { kind: "chair", id: null, title: null };
    if (merit.source_kind === "head_merit") return { kind: "event", id: merit.event_id ?? null, title: state.events.find(event => event.event_id === merit.event_id)?.title ?? null };
    const id = merit.scope?.id ?? null;
    return merit.source_kind === "block_volunteer"
      ? { kind: "block", id, title: state.blocks.find(block => block.block_id === id)?.name ?? null }
      : { kind: "subevent", id, title: state.subevents.find(sub => sub.subevent_id === id)?.title ?? null };
  };
  /** The readable records' edits, newest first; a participant keeps their own recipient lines
   *  and the common changes of the records they receive. */
  const list = (search: URLSearchParams): Reply => {
    const seasonId = search.get("season_id"), kind = search.get("scope_kind"), scopeId = search.get("scope_id"), user = search.get("user_id");
    if (!seasonId) return fail(422, "invalid_input", "season_id is required");
    if ((scopeId === null) !== (kind === null || kind === "chair")) return fail(422, "invalid_input", "scope_id names the block, event or subevent of scope_kind; the chair has none");
    const records = new Map(readable().filter(merit => merit.season_id === seasonId).map(merit => [merit.merit_id, merit]));
    const items = edits.flatMap(({ merit_id, entry }): MeritJournalItem[] => {
      const merit = records.get(merit_id), where = merit && team(merit);
      if (!merit || !where || (kind && (where.kind !== kind || where.id !== scopeId))) return [];
      if (user === null) return [{ entry: structuredClone(entry), merit: { merit_id, title: merit.title, source_kind: merit.source_kind, team: where } }];
      const own = (change: HistoryChange) => change.field === "recipients" && recipientOf(change) === Number(user);
      const common = entry.changes.some(change => change.field !== "recipients") && merit.recipients.some(item => item.user_id === Number(user));
      return entry.changes.some(own) || common
        ? [{ entry: structuredClone({ ...entry, changes: entry.changes.filter(change => change.field !== "recipients" || own(change)) }), merit: { merit_id, title: merit.title, source_kind: merit.source_kind, team: where } }]
        : [];
    }).reverse();
    const cursor = search.get("cursor"), limit = Math.min(Math.max(Number(search.get("limit") ?? 30) || 30, 1), 100);
    const start = cursor === null ? 0 : items.findIndex(item => item.entry.id === cursor) + 1;
    if (cursor !== null && !start) return fail(422, "invalid_input", "Invalid cursor");
    const page = items.slice(start, start + limit);
    return [200, { items: page, next_cursor: start + limit < items.length ? page.at(-1)!.entry.id : null, total: items.length,
      records: new Set(items.map(item => item.merit.merit_id)).size }];
  };
  return { remember, list };
}
