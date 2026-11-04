import type { BotLinkMe, BotLinkState } from "../../utils/api/contract";

/** A reviewer's short label of an applicant's VK link: «Бот: …». */
export const botLinkLabels: Record<BotLinkState, string> = {
  ok: "привязан",
  none: "не привязан",
  messages_denied: "сообщения запрещены",
  token_missing: "нет токена",
  token_invalid: "токен не работает",
};

/** A link code for reading and retyping: ABCDE-FGHJK. Any other shape is shown as it came. */
export function groupCode(code: string) {
  const raw = code.replace(/[\s-]/g, "").toUpperCase();
  return raw.length === 10 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : code.trim();
}

/** Where the profile settings keep the bot block (the banner links to it). */
export const BOT_LINK_ANCHOR = "bot";

/** The own link read; the step polls it while it waits for the bot. */
export const botLinkKey = ["botLink", "me"] as const;
export const BOT_LINK_POLL_MS = 3000;

const unexpired = (expires: string | null | undefined, now: number) => !!expires && Date.parse(expires) > now;
/** The step polls every 3 s while a code waits to be used or the link is not `ok`; TanStack
 *  skips the ticks while the tab is hidden (no background polling). */
export function botLinkPollInterval(me: BotLinkMe | undefined, codeExpiresAt: string | null | undefined, now = Date.now()) {
  if (!me?.enabled) return false;
  return me.state !== "ok" || unexpired(me.code_expires_at, now) || unexpired(codeExpiresAt, now) ? BOT_LINK_POLL_MS : false;
}
