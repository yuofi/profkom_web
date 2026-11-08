import type { BotCommand, BotCommandInput, BotConsoleStatus, BotMaintainerChange, UserRef } from "./contract";
import { allPages, idPath, page, request } from "./request";

/** The bot console (BOT_API.md, «Консоль бота», stages 1 and 5). With the integration off the
 *  pause and a new command answer 404 bot_api_disabled; the reads still work. */
export const botConsoleApi = {
  status: (signal?: AbortSignal) => request<BotConsoleStatus>("get", "/bot/console/status", undefined, undefined, signal),
  /** A repeat changes nothing; the answer is the status. */
  pause: (paused: boolean) => request<BotConsoleStatus>("put", "/bot/console/pause", { paused }),
  /** 409 bot_offline, bot_command_pending, bot_console_service_vk, bot_console_vk_required, duplicate_request_key;
   *  429 bot_command_rate_limited. */
  create: (input: BotCommandInput) => request<BotCommand>("post", "/bot/console/commands", input),
  /** Newest first, 20 a page, `output` null. */
  commands: (cursor?: string | null, signal?: AbortSignal) =>
    page<BotCommand>("/bot/console/commands", cursor ? { cursor } : undefined, signal),
  /** With `output`; 404 not_found. */
  command: (id: string, signal?: AbortSignal) =>
    request<BotCommand>("get", `/bot/console/commands/${idPath(id)}`, undefined, undefined, signal),
  maintainers: () => allPages<UserRef>("/bot/maintainers"),
  setMaintainer: (userId: number, maintainer: boolean) =>
    request<BotMaintainerChange>("put", `/bot/maintainers/${idPath(userId)}`, { maintainer }),
};

/** Query keys of the console: one prefix, so a command can reread all of them. */
export const botConsoleKeys = {
  all: ["botConsole"] as const,
  status: ["botConsole", "status"] as const,
  commands: ["botConsole", "commands"] as const,
  command: (id: string) => ["botConsole", "command", id] as const,
  maintainers: ["botConsole", "maintainers"] as const,
};
