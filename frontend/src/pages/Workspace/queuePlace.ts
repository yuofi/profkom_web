import type { TaskQueue } from "../../utils/api/contract";

/** Why a task cannot be created in the queue now (owner 2026-11-08, В8); null when it can or the server says nothing. */
export function queueCreationNotice(queue: Pick<TaskQueue, "season" | "task_creation">): string | null {
  const creation = queue.task_creation, season = queue.season?.title;
  if (!creation || creation.available) return null;
  const tail = "новые задачи в этой очереди создать нельзя.";
  switch (creation.reason) {
    case "season_summarizing": return `${season ? `Сезон «${season}»` : "Сезон мероприятия"} подводит итоги — ${tail}`;
    case "season_closed": return `${season ? `Сезон «${season}»` : "Сезон мероприятия"} закрыт — ${tail}`;
    case "no_open_season": return `Сейчас нет открытого сезона — ${tail}`;
    case "no_season": return `Сейчас нет открытого или запланированного сезона — ${tail}`;
    case "team_missing": return `Команда этой очереди недоступна — ${tail}`;
    default: return `Сейчас ${tail}`;
  }
}
/** Only creation the server is known to refuse stops it; an older server says nothing. */
export const queueTakesTasks = (queue: Pick<TaskQueue, "task_creation">) => queue.task_creation?.available !== false;
/** «KEY · Name · Team» for a plain option of a queue select. */
export const queueOptionLabel = (queue: Pick<TaskQueue, "key" | "name" | "scope_title">) => [queue.key, queue.name, queue.scope_title].filter(Boolean).join(" · ");
