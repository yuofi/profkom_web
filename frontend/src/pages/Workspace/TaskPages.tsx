import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { QueryState, Badge, Empty, Glyph } from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { TrackerHomeLink } from "../../components/Workspace/TrackerHomeLink";
import { UserChip } from "../../components/Workspace/UserChip";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { text, number } from "../../components/Workspace/formValues";
import { useScopeMembers } from "../../components/Workspace/ScopeMembers";
import { tasksApi } from "../../utils/api/tasks.api";
import type { AssignmentStatus, UnresolvedAssignment } from "../../utils/api/contract";
import { can, useSession } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getTaskRoute, getBlockRoute, getSubeventRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { statusTones } from "./trackerStatus";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./UnresolvedPage.module.css";
export { TrackerListPage as TasksListPage } from "./TrackerList";
export { TrackerTaskPage as TaskPage } from "./TrackerTaskDetail";
export { TaskCreateForm } from "./TaskCreateForm";

const unresolvedStates = new Set<AssignmentStatus>(["assigned", "in_progress", "help_required", "submitted", "needs_revision"]);
const accountingNames: Record<AssignmentStatus, string> = {
  assigned: "Ожидает оценки", in_progress: "В работе", help_required: "Нужны уточнения", submitted: "Ожидает проверки",
  needs_revision: "На доработке", accepted: "Зачтено", not_completed: "Не выполнено", cancelled: "Исключено из ККР",
};
function ReassignForm({ item, onSaved, onBusy }: { item: UnresolvedAssignment; onSaved: () => void; onBusy: (busy: boolean) => void }) {
  const members = useScopeMembers(item.scope);
  const { perform, refresh } = useWorkspaceActions();
  const assignment = item.assignment;
  const inputs = useQuery({ queryKey: ["assessments", assignment.assignment_id], queryFn: () => tasksApi.assessment(assignment.assignment_id), enabled: can(assignment, "view_assessment_inputs") });
  const available = members.options.filter(person => person.value !== String(assignment.assignee.user_id));
  if (!can(assignment, "view_assessment_inputs")) return <Empty>Нет доступа к исходным данным назначения. Обновите очередь перед переназначением.</Empty>;
  const stillUnresolved = !inputs.data?.workflow_status || unresolvedStates.has(inputs.data.workflow_status);
  return <QueryState loading={members.loading || inputs.isLoading} error={members.error ?? inputs.error} keepDataOnError={!!inputs.data} retry={() => { void refresh(); }}>
    {inputs.data && <>
      {!stillUnresolved && <p role="status" className={w.warning}>Учётное решение уже принято. Это назначение больше нельзя переназначить из очереди оставшейся работы.</p>}
      {!available.length && <p className={w.muted}>В команде нет другого доступного участника для нового назначения.</p>}
      <ActionForm key={assignment.assignment_id} revision={inputs.data.revision} record={`assignment-inputs:${assignment.assignment_id}`} disabled={!stillUnresolved || !available.length}
        fields={[
          { name: "user", label: "Новый исполнитель", type: "select", entity: "person", required: true, options: available, hint: "Участники и руководители этой команды." },
          { name: "hours", label: "Часы нового назначения", type: "number", min: 0, required: true },
          { name: "outcome", label: "Исход прежнего назначения", type: "select", required: true, options: [
            { value: "cancelled", label: "Исключить из ККР без оценки" },
            { value: "0", label: "Не выполнено — 0" }, { value: "-1", label: "Не выполнено — −1" },
          ] },
          { name: "reason", label: "Причина переназначения", required: true, type: "textarea" },
        ]}
        onSubmit={async (values, revision) => {
          onBusy(true);
          try {
            const outcome = text(values, "outcome");
            // This endpoint checks inputs_revision, which may differ from Assignment.revision.
            await perform(() => tasksApi.reassign(assignment.assignment_id, {
              expected_revision: revision!, new_assignee_user_id: number(values, "user"), hours: number(values, "hours"),
              previous_outcome: outcome === "cancelled" ? "cancelled" : "not_completed",
              ...(outcome === "cancelled" ? {} : { evaluation: Number(outcome) as 0 | -1 }),
              reason: text(values, "reason"),
            }));
            // The reply carries the raw assignment counter, not the input counter. The editor
            // closes after this accepted command; do not rebase other input forms to that value.
            onSaved();
          } finally { onBusy(false); }
        }} onConflict={refresh} allowExitSave={false} submitLabel="Закрыть прежнее и назначить заново" />
    </>}
  </QueryState>;
}
function TeamLink({ item }: { item: UnresolvedAssignment }) {
  const block = item.scope.kind === "block";
  return <Link className={s.team} to={block ? getBlockRoute(item.scope.id) : getSubeventRoute(item.scope.id)}><Glyph name={block ? "groups" : "event"} />{block ? "Блок" : "Подмероприятие"}</Link>;
}
export function UnresolvedPage() {
  const { session } = useSession(), [params] = useSearchParams();
  const seasonId = params.get("season_id");
  const [onlyUnavailable, setOnlyUnavailable] = useState(false), [editingId, setEditingId] = useState<string | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState("");
  const allowed = can(session, "view_unresolved_assignments");
  const query = useQuery({ queryKey: ["tasks", "unresolved"], queryFn: () => tasksApi.unresolved(), enabled: allowed });
  const items = query.data?.items.filter(item => (!seasonId || item.season_id === seasonId) && (!onlyUnavailable || item.assignment.assignee_unavailable_reason));
  const editing = query.data?.items.find(item => item.assignment.assignment_id === editingId && can(item.assignment, "reassign_assignment"));
  return <section className={s.page}>
    <BrandedHeader className={s.header}><div><TrackerHomeLink /><h1 className={w.title}>Оставшаяся работа</h1><p className={w.description}>Незавершённые назначения и решения по ККР. Прежняя история сохраняется; новое назначение создаётся отдельно.</p></div><div className={s.headerActions}><Link to="/tasks" className={w.button}>Все задачи</Link>{seasonId && <Link to="/tasks/unresolved" className={w.button}>Все сезоны</Link>}</div></BrandedHeader>
    {!allowed ? <Empty>Нет доступа к очереди.</Empty> : <>
      <div className={s.toolbar}><label className={w.check}><input type="checkbox" checked={onlyUnavailable} onChange={event => setOnlyUnavailable(event.target.checked)} />Только без доступного исполнителя</label>{seasonId && <span className={s.seasonFilter}>Выбранный сезон</span>}<span className={s.count} aria-live="polite">Назначений: {items?.length ?? 0}</span></div>
      {saved && <p role="status" className={w.success}>{saved}</p>}
      <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error} retry={() => { void query.refetch(); }}>
        {!!items?.length && <div className={s.tableWrap}><table className={s.table} aria-label="Оставшаяся работа по назначениям">
          <thead><tr>{["Задача", "Исполнитель", "Команда", "Учёт ККР", "Доступ исполнителя", "Дедлайн, МСК", "Действия"].map(title => <th scope="col" key={title}>{title}</th>)}</tr></thead>
          <tbody>{items.map(item => <tr key={item.assignment.assignment_id}>
            <td className={s.task}><Link to={getTaskRoute(item.task_id)}>{item.task_title}</Link><Link className={s.history} to={`${getTaskRoute(item.task_id)}?assignment_id=${encodeURIComponent(item.assignment.assignment_id)}`}>Задача и история</Link></td>
            <td className={s.person} data-label="Исполнитель"><UserChip user={item.assignment.assignee} /></td>
            <td className={s.scope} data-label="Команда"><TeamLink item={item} /></td>
            <td className={s.status} data-label="Учёт ККР"><Badge tone={statusTones[item.assignment.status]}>{accountingNames[item.assignment.status]}</Badge></td>
            <td className={s.availability} data-label="Доступ исполнителя">{item.assignment.assignee_unavailable_reason === "archived" ? <span className={s.unavailable}>В архиве</span> : item.assignment.assignee_unavailable_reason === "left_scope" ? <span className={s.unavailable}>Нет доступа к задаче</span> : <span>Доступен</span>}</td>
            <td className={s.deadline} data-label="Дедлайн, МСК"><time dateTime={item.deadline_at}>{displayDate(item.deadline_at)}</time></td>
            <td className={s.action}>{can(item.assignment, "reassign_assignment") ? <button type="button" className={s.reassign} aria-label={`Переназначить: ${item.task_title} · ${item.assignment.assignee.display_name}`} onClick={() => { setSaved("");setEditingId(item.assignment.assignment_id); }}>Переназначить</button> : <span className={s.readonly}>Только просмотр</span>}</td>
          </tr>)}</tbody>
        </table></div>}
        {items?.length === 0 && <div className={s.empty}><Glyph name="task_alt" /><h2>Оставшейся работы нет.</h2><p>{onlyUnavailable ? "Нет назначений без доступного исполнителя. Снимите фильтр, чтобы увидеть остальные." : seasonId ? "В выбранном сезоне нет незавершённых назначений." : "Все доступные назначения завершены или получили учётное решение."}</p><Link to="/tasks" className={w.button}>Открыть задачи</Link></div>}
      </QueryState>
      {editing && <UnsavedChangesScope><TrackerTaskDialog title="Переназначить работу" onClose={() => setEditingId(null)} busy={busy}>
        <div className={s.dialogContext}><Link to={getTaskRoute(editing.task_id)}>{editing.task_title}</Link><UserChip user={editing.assignment.assignee} /><p>Прежнее назначение останется в истории с выбранным учётным исходом. Новому исполнителю будет создано отдельное назначение.</p></div>
        <ReassignForm item={editing} onBusy={setBusy} onSaved={() => { setEditingId(null);setSaved("Прежнее назначение закрыто. Новое назначение создано."); }} />
      </TrackerTaskDialog></UnsavedChangesScope>}
    </>}
  </section>;
}
