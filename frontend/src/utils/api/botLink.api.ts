import type { BotLinkCode, BotLinkMe } from "./contract";
import { request } from "./request";

/** The own VK link through HereBot (BOT_API.md, «Привязка VK»): open to a pending account too. */
export const botLinkApi = {
  me: () => request<BotLinkMe>("get", "/bot-link/me"),
  /** A new one-time code; it replaces the previous one. 429 link_code_rate_limited after 10 an hour. */
  createCode: () => request<BotLinkCode>("post", "/bot-link/code"),
};
