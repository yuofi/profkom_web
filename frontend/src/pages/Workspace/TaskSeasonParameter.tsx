import { useState } from "react";
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

export function TaskSeasonParameter({ task }: { task: Task }) {
  const { session } = useSession();
  const [editing, setEditing] = useState(false);
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const correctionAllowed = can(session, "correct_season");
  const subevent = useQuery({ queryKey: ["events", "subevent", task.scope.id], queryFn: () => eventsApi.subevent(task.scope.id), enabled: correctionAllowed && task.scope.kind === "subevent" });
  const season = seasons.data?.items.find(item => item.season_id === task.season_id);
  return <div><dt>Сезон</dt><dd>
    {task.season_id ? <Link to={getSeasonRoute(task.season_id)}>{season?.title ?? "Открыть сезон"}</Link> : <span>Без сезона</span>}
    {correctionAllowed && task.scope.kind === "block" && <button type="button" className={s.seasonEdit} onClick={() => setEditing(true)}><Glyph name="edit" />Изменить сезон</button>}
    {correctionAllowed && task.scope.kind === "subevent" && <div className={s.seasonContext}>
      <p>Сезон меняется вместе с мероприятием и его задачами.</p>
      <QueryState loading={subevent.isLoading} error={subevent.error}>{subevent.data && <Link to={getEventRoute(subevent.data.event_id)}>Изменить сезон мероприятия</Link>}</QueryState>
    </div>}
    {correctionAllowed && task.season_id && task.scope.kind === "queue" && <p className={s.seasonContext}>Перенос независимой задачи в другой сезон пока не поддерживается.</p>}
    {editing && correctionAllowed && task.scope.kind === "block" && task.season_id && <UnsavedChangesScope><TrackerTaskDialog title="Сезон задачи" onClose={() => setEditing(false)}>
      <p>Задача: {task.task_key ? `${task.task_key} · ` : ""}{task.title}</p>
      <SeasonPlacementEditor objectKind="block_task" objectId={task.task_id} currentSeasonId={task.season_id} revision={task.revision} onSaved={() => setEditing(false)} />
    </TrackerTaskDialog></UnsavedChangesScope>}
  </dd></div>;
}
