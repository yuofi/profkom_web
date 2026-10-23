import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "../../utils/api/tasks.api";
import type { SeasonBlocker } from "../../utils/api/contract";
import { getSeasonRoute, getTaskRoute, targetRoute } from "../../utils/routes";
import { RouteLink } from "./WorkspaceUI";
import { blockerText } from "../../utils/api/messages";

export function SeasonBlockerLink({
  blocker,
  seasonId,
}: {
  blocker: SeasonBlocker;
  seasonId: string;
}) {
  const assignment = blocker.owner_kind === "assignment";
  const tasks = useQuery({
    queryKey: ["tasks", "season-blockers", seasonId],
    queryFn: () => tasksApi.list({ season_id: seasonId, mine: false }),
    enabled: assignment,
    retry: false,
  });
  const task = tasks.data?.items.find((t) =>
    t.assignments.some((a) => a.assignment_id === blocker.owner_id),
  );
  const params = new URLSearchParams({
    assignment_id: blocker.owner_id,
    return_season: seasonId,
  });
  const link = assignment
    ? task
      ? `${getTaskRoute(task.task_id)}?${params}`
      : null
    : targetRoute({ kind: blocker.owner_kind, id: blocker.owner_id });
  return link ? (
    <RouteLink to={link}>{blockerText(blocker)}</RouteLink>
  ) : (
    <>
      <span>{blockerText(blocker)}</span>{" "}
      <span>
        {tasks.isLoading
          ? "Ищем назначение…"
          : "Объект недоступен. Обновите данные сезона или проверьте доступ."}
      </span>
      {tasks.isError && (
        <button type="button" onClick={() => void tasks.refetch()}>
          Повторить поиск
        </button>
      )}
      {!assignment && (
        <RouteLink to={getSeasonRoute(seasonId)}>К сезону</RouteLink>
      )}
    </>
  );
}
