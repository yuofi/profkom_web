import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Page, Card, QueryState, RouteLink, Badge, Empty } from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text, number } from "../../components/Workspace/formValues";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { tasksApi } from "../../utils/api/tasks.api";
import type { UnresolvedAssignment } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getTaskRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { statusNames, statusTones } from "./trackerStatus";
import s from "../../components/Workspace/Workspace.module.css";
export { TrackerListPage as TasksListPage } from "./TrackerList";
export { TrackerTaskPage as TaskPage } from "./TrackerTaskDetail";
export { TaskCreateForm } from "./TaskCreateForm";
function ReassignForm({ item }: { item: UnresolvedAssignment }) {
  const members = useScopeMembers(item.scope);
  const { perform, refresh } = useWorkspaceActions();
  const a = item.assignment;
  return (
    <QueryState loading={members.loading} error={members.error}>
      <ActionForm
        key={a.assignment_id}
        revision={a.revision}
        record={`assignment:${a.assignment_id}`}
        fields={[
          {
            name: "user",
            label: "Новый исполнитель",
            type: "select",
            required: true,
            options: members.options.filter(
              (p) => p.value !== String(a.assignee.user_id),
            ),
          },
          {
            name: "hours",
            label: "Часы нового назначения",
            type: "number",
            min: 0,
            required: true,
          },
          {
            name: "outcome",
            label: "Исход прежнего назначения",
            type: "select",
            required: true,
            options: [
              { value: "cancelled", label: "Отменить без оценки" },
              { value: "0", label: "Не выполнено — 0" },
              { value: "-1", label: "Не выполнено — −1" },
            ],
          },
          {
            name: "reason",
            label: "Причина переназначения",
            required: true,
            type: "textarea",
          },
        ]}
        onSubmit={async (v, expectedRevision) => {
          const outcome = text(v, "outcome");
          const saved = await perform(() =>
            tasksApi.reassign(a.assignment_id, {
              expected_revision: expectedRevision!,
              new_assignee_user_id: number(v, "user"),
              hours: number(v, "hours"),
              previous_outcome:
                outcome === "cancelled" ? "cancelled" : "not_completed",
              ...(outcome === "cancelled"
                ? {}
                : { evaluation: Number(outcome) as 0 | -1 }),
              reason: text(v, "reason"),
            }),
          );
          return {revision: saved.previous_assignment.revision};
        }}
        onConflict={refresh}
        submitLabel="Закрыть прежнее и назначить заново"
      />
    </QueryState>
  );
}
export function UnresolvedPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const seasonId = params.get("season_id");
  const [onlyUnavailable, setOnlyUnavailable] = useState(false);
  const query = useQuery({
    queryKey: ["tasks", "unresolved"],
    queryFn: () => tasksApi.unresolved(),
    enabled: can(session, "view_unresolved_assignments"),
  });
  if (!can(session, "view_unresolved_assignments"))
    return (
      <Page title="Оставшаяся работа">
        <Empty>Нет доступа к очереди.</Empty>
      </Page>
    );
  const items = query.data?.items.filter(
    (x) =>
      (!seasonId || x.season_id === seasonId) &&
      (!onlyUnavailable || x.assignment.assignee_unavailable_reason),
  );
  return (
    <Page
      title="Оставшаяся работа"
      description="Прежняя история сохраняется. Новое назначение создаётся отдельно."
      actions={
        seasonId && <RouteLink to="/tasks/unresolved">Все сезоны</RouteLink>
      }
    >
      <label className={s.check}>
        <input
          type="checkbox"
          checked={onlyUnavailable}
          onChange={(e) => setOnlyUnavailable(e.target.checked)}
        />
        Только без доступного исполнителя
      </label>
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        <div className={s.stack}>
          {items?.map((item) => (
            <Card title={item.task_title} key={item.assignment.assignment_id}>
              <div className={s.badges}>
                <Badge tone={statusTones[item.assignment.status]}>
                  {statusNames[item.assignment.status]}
                </Badge>
                <Badge>Дедлайн: {displayDate(item.deadline_at)}</Badge>
              </div>
              <p>{item.assignment.assignee.display_name}</p>
              <RouteLink to={getTaskRoute(item.task_id)}>
                Задача и история
              </RouteLink>
              {can(item.assignment, "reassign_assignment") && (
                <details className={s.details}>
                  <summary>Переназначить</summary>
                  <ReassignForm item={item} />
                </details>
              )}
            </Card>
          ))}
          {items?.length === 0 && <Empty>Оставшейся работы нет.</Empty>}
        </div>
      </QueryState>
    </Page>
  );
}
