import type { Broadcast, BroadcastAudience, BroadcastCounts, BroadcastState } from "../../utils/api/contract";
import type { Tone } from "../../components/Workspace/sections";
import { plural } from "./seasonAnalyticsView";

/** The longest broadcast VK takes from the site (BOT_API.md, «Рассылки»). */
export const BROADCAST_MAX = 4000;
/** The history and a sending broadcast reread this often, only while the tab is visible. */
export const BROADCAST_POLL_MS = 5000;

/** Characters as the server counts them: code points after trimming the edges, so an emoji
 *  is one character and the edge spaces are none. */
export const broadcastLength = (text: string) => Array.from(text.trim()).length;

export const broadcastStateNames: Record<BroadcastState, string> = {
  sending: "Идёт отправка",
  done: "Отправлена",
  cancelled: "Отменена",
};
export const broadcastStateTones: Record<BroadcastState, Tone | undefined> = {
  sending: "sky",
  done: "mint",
  cancelled: undefined,
};

/** VK did not take it: messages not allowed, a final error, or a day passed without sending. */
export const notDelivered = (counts: BroadcastCounts) => counts.denied + counts.failed + counts.expired;

/** «Отправлено 380 из 412 · не доставлено 7 · отменено 25»: one line of the history. */
export function progressText(counts: BroadcastCounts) {
  const parts = [`Отправлено ${counts.sent} из ${counts.total}`];
  const lost = notDelivered(counts);
  if (lost) parts.push(`не доставлено ${lost}`);
  if (counts.cancelled) parts.push(`отменено ${counts.cancelled}`);
  return parts.join(" · ");
}

/** The hint under the text: how many get it in VK and how many only on the site. `reachable`
 *  above `total` (the author linked, but not counted on the site) still reads sensibly. */
export function audienceHint({ total, reachable }: BroadcastAudience) {
  if (reachable <= 0) return "Сейчас рассылку некому отправить в VK: ни у кого не подключён бот.";
  const missing = Math.max(0, total - reachable);
  return `Получат в VK: ${reachable} из ${Math.max(total, reachable)}.` +
    (missing ? ` У ${missing} бот не подключён — они увидят рассылку только на сайте.` : "");
}

/** The question before sending: both counts and what cannot be undone. */
export function sendQuestion({ total, reachable }: BroadcastAudience) {
  return `Отправить рассылку? В VK её получат ${reachable} ${plural(reachable, "человек", "человека", "человек")}, ` +
    `на сайте в уведомлениях — ${total} ${plural(total, "участник", "участника", "участников")}. ` +
    "Отменить потом можно только то, что ещё не ушло.";
}

/** The start of the text on one line for the history. */
export function excerpt(text: string, limit = 140) {
  const flat = Array.from(text.replace(/\s+/g, " ").trim());
  return flat.length > limit ? `${flat.slice(0, limit).join("").trimEnd()}…` : flat.join("");
}

/** Reread every 5 s while a broadcast the reader sees the progress of is still sending;
 *  TanStack skips the ticks while the tab is hidden. Nothing sending: no polling. */
export const broadcastPollInterval = (items: readonly (Broadcast | undefined)[] | undefined) =>
  items?.some((item) => item?.state === "sending" && item.counts !== null) ? BROADCAST_POLL_MS : false;
