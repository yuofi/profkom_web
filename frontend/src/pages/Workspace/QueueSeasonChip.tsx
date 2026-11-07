import type { TaskQueueSeason } from "../../utils/api/contract";
import { InteractiveChip } from "../../components/Workspace/InteractiveChip";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import { getSeasonRoute } from "../../utils/routes";

const stateNotes: Partial<Record<TaskQueueSeason["state"], string>> = { planned: "запланирован", summarizing: "подводит итоги", closed: "закрыт" };
/** The season of an event or subevent queue (owner 2026-11-08, В8): a chip to the season's page. */
export function QueueSeasonChip({ season, interactive = true }: { season: TaskQueueSeason; interactive?: boolean }) {
  const note = stateNotes[season.state], label = note ? `${season.title} · ${note}` : season.title;
  const face = { label, icon: <Glyph name="calendar_month" />, title: `Сезон: ${label}` };
  return interactive ? <InteractiveChip kind="link" to={getSeasonRoute(season.season_id)} ariaLabel={`Открыть сезон: ${label}`} {...face} /> : <InteractiveChip kind="display" {...face} />;
}
