import { useQuery } from "@tanstack/react-query";
import { seasonsApi } from "../../utils/api/seasons.api";
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
  // Readiness rows name the task the reader may open (PF-06). A blocker from a refused
  // close carries no task_id, so it is found among the same season's readiness rows.
  const lookup = assignment && blocker.task_id === undefined;
  const readiness = useQuery({
    queryKey: ["seasons", "readiness", seasonId],
    queryFn: () => seasonsApi.readiness(seasonId, { include_task_ids: true }),
    enabled: lookup,
    retry: false,
  });
  const taskId = !assignment ? null : lookup
    ? readiness.data?.blockers.find((b) => b.owner_kind === "assignment" && b.owner_id === blocker.owner_id)?.task_id ?? null
    : blocker.task_id;
  const params = new URLSearchParams({
    assignment_id: blocker.owner_id,
    return_season: seasonId,
    return_to: "checks",
  });
  const link = blocker.kind === "missing_final_report" && ["event", "subevent"].includes(blocker.owner_kind)
    ? `/reports?owner_kind=${encodeURIComponent(blocker.owner_kind)}&owner_id=${encodeURIComponent(blocker.owner_id)}`
    : assignment
    ? taskId
      ? `${getTaskRoute(taskId)}?${params}`
      : null
    : targetRoute({ kind: blocker.owner_kind, id: blocker.owner_id });
  return link ? (
    <RouteLink to={link}>{blockerText(blocker)}</RouteLink>
  ) : (
    <>
      <span>{blockerText(blocker)}</span>{" "}
      <span>
        {lookup && readiness.isLoading
          ? "Ищем назначение…"
          : "Объект недоступен. Обновите данные сезона или проверьте доступ."}
      </span>
      {lookup && readiness.isError && (
        <button type="button" onClick={() => void readiness.refetch()}>
          Повторить поиск
        </button>
      )}
      {!assignment && (
        <RouteLink to={getSeasonRoute(seasonId)}>К сезону</RouteLink>
      )}
    </>
  );
}
