/** Synthetic broadcasts through the bot (BOT_API.md, «Рассылки», stage 4). Nothing goes to VK:
 *  a sending broadcast moves on by itself each time it is read, unless the console paused sending. */
import type { Fixtures } from "./fixtures";
import { mockNow } from "./fixtures";
import type { Broadcast, BroadcastCounts, SendingPause, UserRef } from "../utils/api/contract";

type Reply = [number, unknown];
type Body = Record<string, unknown>;
const copy = <T,>(value: T): T => structuredClone(value);
const fail = (status: number, code: string, message: string, fields?: object): Reply => [status, { detail: { code, message, fields } }];
const PAGE = 20;
// As the server: a refusal by the right names the broadcasts' own code.
const notSender = (): Reply => fail(403, "broadcast_send_forbidden", "Broadcast sender rights required");
const notManager = (): Reply => fail(403, "broadcast_senders_forbidden", "Only the chair and deputies manage broadcast senders");
const at = (minutesBefore: number) => new Date(Date.parse(mockNow) - minutesBefore * 60_000).toISOString();
const counts = (total: number, rest: Partial<BroadcastCounts> = {}): BroadcastCounts => {
  const known = { pending: 0, denied: 0, failed: 0, cancelled: 0, expired: 0, ...rest };
  const sent = rest.sent ?? total - known.pending - known.denied - known.failed - known.cancelled - known.expired;
  return { total, sent, ...known };
};

/** `enabled()` is the demo's integration switch (the «Бот ВКонтакте» picker, «Выключен»);
 *  `pause()` is the bot console's pause. */
export function broadcastMock(state: Fixtures, enabled: () => boolean, pause: () => SendingPause | null = () => null) {
  const person = (id: number): UserRef => copy(state.people.find((p) => p.user_id === id)!);
  const store = {
    /** Active accounts without the author, and how many of them have the bot. */
    audience: { total: 430, reachable: 412 },
    /** Recipients a read of a sending broadcast moves on; 0 holds it still. */
    step: 60,
    senders: [103] as number[],
    keys: new Map<string, { text: string; id: string }>(),
    items: [
      { broadcast_id: "broadcast-3", author: person(104), created_at: at(8), state: "sending", cancelled_at: null,
        text: "Собрание актива в четверг в 18:30, аудитория П-8.\nВозьмите студенческий: на входе проверяют.\n\nПовестка — в группе профкома.",
        counts: counts(412, { pending: 172, denied: 6, failed: 2 }) },
      { broadcast_id: "broadcast-2", author: person(105), created_at: at(60 * 26), state: "done", cancelled_at: null,
        text: "До 25 октября продлили приём заявок на материальную помощь.\nЗаявление — у старост и в кабинете профкома.",
        counts: counts(405, { denied: 5, failed: 2, expired: 2 }) },
      { broadcast_id: "broadcast-1", author: person(103), created_at: at(60 * 72), state: "cancelled", cancelled_at: at(60 * 72 - 3),
        text: "Тестовая рассылка: проверяем, как текст доходит в VK.",
        counts: counts(398, { sent: 120, cancelled: 270, denied: 3, failed: 5 }) },
      // Older ones, for the second page of the history; one author's account no longer exists.
      ...Array.from({ length: PAGE }, (_, index) => ({
        broadcast_id: `broadcast-old-${index + 1}`, author: index === 4 ? null : person(104),
        created_at: at(60 * 24 * (7 + index * 7)), state: "done" as const, cancelled_at: null,
        text: `Новости профкома, выпуск ${PAGE - index}.\nПодробности — в группе профкома.`,
        counts: counts(380 - index, { denied: 2, failed: 1 }),
      })),
    ] as Broadcast[],
  };
  const sends = () => state.session.capabilities.includes("send_broadcast");
  const manages = () => state.session.capabilities.includes("manage_broadcast_senders");
  /** The bot takes the next recipients; the last one done ends the sending. */
  const advance = (item: Broadcast) => {
    if (item.state !== "sending" || !item.counts || !store.step || pause()) return;
    const c = item.counts, step = Math.min(c.pending, store.step), failed = step >= store.step ? 1 : 0;
    c.pending -= step;c.sent += step - failed;c.failed += failed;
    if (!c.pending) item.state = "done";
  };
  const view = (item: Broadcast): Broadcast => ({
    ...copy(item), counts: sends() ? copy(item.counts) : null, paused: sends() && item.state === "sending" ? pause() : null,
  });
  const handle = (path: string, method: string, data: Body, search?: URLSearchParams): Reply | undefined => {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] !== "broadcasts") return undefined;
    if (parts[1] === "senders") {
      if (!manages()) return notManager();
      if (!parts[2] && method === "get")
        return [200, { items: store.senders.map((id) => person(id)), next_cursor: null }];
      if (parts[2] && method === "put") {
        const userId = Number(parts[2]), extra = Object.keys(data).filter((name) => name !== "sender");
        if (extra.length || typeof data.sender !== "boolean") return fail(422, "invalid_input", "Проверьте поля формы");
        if (!state.people.some((p) => p.user_id === userId)) return fail(404, "not_found", "Unknown account");
        store.senders = store.senders.filter((id) => id !== userId);
        if (data.sender) store.senders.push(userId);
        return [200, { user_id: userId, sender: data.sender }];
      }
      return fail(405, "method_not_allowed", "Method not allowed");
    }
    if (parts[1] === "audience") {
      if (!sends()) return notSender();
      if (!enabled()) return fail(404, "bot_api_disabled", "Bot integration is disabled");
      return [200, { ...copy(store.audience), paused: pause() }];
    }
    if (!parts[1]) {
      if (!sends()) return notSender();
      if (method === "get") {
        store.items.forEach(advance);
        const sorted = [...store.items].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.broadcast_id.localeCompare(a.broadcast_id));
        const start = Number(search?.get("cursor") ?? 0) || 0;
        const items = sorted.slice(start, start + PAGE);
        return [200, { items: items.map(view), next_cursor: start + PAGE < sorted.length ? String(start + PAGE) : null }];
      }
      if (method !== "post") return fail(405, "method_not_allowed", "Method not allowed");
      if (!enabled()) return fail(404, "bot_api_disabled", "Bot integration is disabled");
      const extra = Object.keys(data).filter((name) => !["text", "idempotency_key"].includes(name));
      const key = data.idempotency_key;
      if (extra.length || typeof key !== "string" || !/^[0-9a-f-]{36}$/i.test(key) || typeof data.text !== "string")
        return fail(422, "invalid_input", "Проверьте поля формы");
      const text = data.text.trim(), length = Array.from(text).length;
      if (length < 1 || length > 4000)
        return fail(422, "invalid_input", "Проверьте поля формы", { errors: [{ loc: ["body", "text"], msg: "Bad length", type: length ? "string_too_long" : "string_too_short" }] });
      const known = store.keys.get(key);
      if (known) {
        if (known.text !== text) return fail(409, "duplicate_request_key", "Idempotency key has already been used");
        return [200, view(store.items.find((item) => item.broadcast_id === known.id)!)];
      }
      if (store.audience.reachable <= 0) return fail(409, "broadcast_no_recipients", "No VK recipients");
      const item: Broadcast = {
        broadcast_id: `broadcast-new-${store.keys.size + 1}`, text, author: copy(state.user), created_at: new Date().toISOString(),
        state: "sending", cancelled_at: null, counts: counts(store.audience.reachable, { pending: store.audience.reachable, sent: 0 }),
        paused: null,
      };
      store.items.push(item);store.keys.set(key, { text, id: item.broadcast_id });
      return [200, view(item)];
    }
    const item = store.items.find((row) => row.broadcast_id === parts[1]);
    if (!parts[2] && method === "get") {
      if (!item) return fail(404, "not_found", "No such broadcast");
      advance(item);
      return [200, view(item)];
    }
    if (parts[2] === "cancel" && method === "post") {
      if (!sends()) return notSender();
      if (!item) return fail(404, "not_found", "No such broadcast");
      if (item.state !== "sending") return fail(409, "broadcast_not_sending", "The broadcast is not sending");
      const c = item.counts!;
      c.cancelled += c.pending;c.pending = 0;
      item.state = "cancelled";item.cancelled_at = new Date().toISOString();
      return [200, view(item)];
    }
    return fail(405, "method_not_allowed", "Method not allowed");
  };
  return Object.assign(handle, { store });
}
