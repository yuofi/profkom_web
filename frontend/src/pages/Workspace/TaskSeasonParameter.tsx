import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { SeasonPlacementEditor } from "../../components/Workspace/SeasonPlacementEditor";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { Glyph, QueryState } from "../../components/Workspace/WorkspaceUI";
import type { Task } from "../../utils/api/contract";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { getEventRoute, getSeasonRoute } from "../../utils/routes";
import { can, useSession } from "../../utils/session";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "./TrackerTaskDetail.module.css";

const SUBEVENT_SEASON_HINT = "Сезон меняется вместе с мероприятием и его задачами.";

export function TaskSeasonParameter({ task }: { task: Task }) {
  const { session } = useSession();
  const [editing, setEditing] = useState(false), hintId = useId();
  // The task page reads the seasons with the task (PF-14); the parameter joins that entry.
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, refetchOnMount: false });
  const correctionAllowed = can(session, "correct_season");
  const subevent = useQuery({ queryKey: ["events", "subevent", task.scope.id], queryFn: () => eventsApi.subevent(task.scope.id), enabled: correctionAllowed && task.scope.kind === "subevent" });
  const season = seasons.data?.items.find(item => item.season_id === task.season_id);
  // The hint is the links' tooltip (D-03); it stays their description and shows on a touch screen.
  const hint = correctionAllowed && task.scope.kind === "subevent" ? { title: SUBEVENT_SEASON_HINT, "aria-describedby": hintId } : {};
  return <div><dt>Сезон</dt><dd>
    {task.season_id ? <Link to={getSeasonRoute(task.season_id)} {...hint}>{season?.title ?? "Открыть сезон"}</Link> : <span>Без сезона</span>}
    {correctionAllowed && task.scope.kind === "block" && <button type="button" className={s.seasonEdit} onClick={() => setEditing(true)}><Glyph name="edit" />Изменить сезон</button>}
    {correctionAllowed && task.scope.kind === "subevent" && <div className={s.seasonContext}>
      <p id={hintId} className={s.seasonHint}>{SUBEVENT_SEASON_HINT}</p>
      <QueryState loading={subevent.isLoading} error={subevent.error}>{subevent.data && <Link to={getEventRoute(subevent.data.event_id)} {...hint}>Изменить сезон мероприятия</Link>}</QueryState>
    </div>}
    {correctionAllowed && task.season_id && task.scope.kind === "queue" && <p className={s.seasonContext}>Перенос независимой задачи в другой сезон пока не поддерживается.</p>}
    {editing && correctionAllowed && task.scope.kind === "block" && task.season_id && <UnsavedChangesScope><TrackerTaskDialog title="Сезон задачи" onClose={() => setEditing(false)}>
      <p>Задача: {task.task_key ? `${task.task_key} · ` : ""}{task.title}</p>
      <SeasonPlacementEditor objectKind="block_task" objectId={task.task_id} currentSeasonId={task.season_id} revision={task.revision} onSaved={() => setEditing(false)} />
    </TrackerTaskDialog></UnsavedChangesScope>}
  </dd></div>;
}
