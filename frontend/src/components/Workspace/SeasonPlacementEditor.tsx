import { useQuery } from "@tanstack/react-query";
import { seasonsApi } from "../../utils/api/seasons.api";
import { can, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm } from "./ActionForm";
import { text } from "./formValues";
import { Empty, QueryState } from "./WorkspaceUI";
import s from "./Workspace.module.css";
export function SeasonPlacementEditor({ objectKind, objectId, currentSeasonId, revision, onSaved }: {
  objectKind: "event" | "block_task" | "merit"; objectId: string; currentSeasonId: string; revision: number; onSaved?: () => void;
}) {
  const { session } = useSession();const { perform, refresh } = useWorkspaceActions();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list, enabled: can(session, "correct_season") });
  if (!can(session, "correct_season")) return <Empty>Изменять принадлежность к сезону могут председатель и его заместители.</Empty>;
  const current = seasons.data?.items.find(item => item.season_id === currentSeasonId);
  const choices = seasons.data?.items.filter(item => item.season_id !== currentSeasonId && item.state !== "closed" && (objectKind === "event" || item.state !== "planned")) ?? [];
  return <QueryState keepDataOnError={!!seasons.data} loading={seasons.isLoading} error={seasons.error} retry={() => void seasons.refetch()}>
    {current && <p className={s.muted}>Текущий сезон: <strong>{current.title}</strong></p>}
    {objectKind === "event" && <p>В выбранный сезон перейдут мероприятие, его подмероприятия, задачи, отчёты и начисления. Перенос выполняется целиком.</p>}
    {current?.state === "closed" ? <Empty>Принадлежность к закрытому сезону зафиксирована. Расчётные исправления доступны в карточке соответствующей работы.</Empty> : !choices.length ? <Empty>Нет другого подходящего незакрытого сезона.</Empty> : <ActionForm
      revision={revision} record={`season-placement:${objectKind}:${objectId}`} submitLabel="Перенести в сезон" onConflict={refresh}
      fields={[
        { name: "target", label: "Сезон", type: "select", required: true, value: "", options: choices.map(item => ({ value: item.season_id, label: item.title })) },
        { name: "reason", label: "Причина изменения", type: "textarea", required: true },
      ]} onSubmit={async (values, expectedRevision) => {
        const result = await perform(() => seasonsApi.correctSeason({ object_kind: objectKind, object_id: objectId, expected_revision: expectedRevision!, target_season_id: text(values, "target"), reason: text(values, "reason") }));
        onSaved?.();return { revision: result.revision };
      }} />}
  </QueryState>;
}
