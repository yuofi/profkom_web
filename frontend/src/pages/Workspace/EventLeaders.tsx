import { ActionForm } from "../../components/Workspace/ActionForm";
import { UserChip } from "../../components/Workspace/UserChip";
import { ids } from "../../components/Workspace/formValues";
import { eventsApi } from "../../utils/api/events.api";
import type { Leader } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import s from "../../components/Workspace/Workspace.module.css";
import e from "./EventEditor.module.css";

export function Leaders({ leaders }: { leaders: Leader[] }) {
  const people = usePeopleOptions({ includeNonMembers: true }), { perform, refresh } = useWorkspaceActions();
  return <div className={e.leaders}>
    {!leaders.length && <span className={`${s.muted} ${e.leaderHint}`}>Руководители пока не назначены</span>}
    {leaders.map(leader => <div key={leader.role_assignment_id} className={e.leader}><UserChip user={leader.user} />
      {leader.deputy_user_ids.length > 0 && <div className={e.deputies}><small>Заместители</small>{leader.deputy_user_ids.map(id => {
        const person = people.options.find(person => person.value === String(id));
        return person?.user ? <UserChip key={id} user={person.user} /> : <span key={id} className={`${s.muted} ${e.leaderHint}`}>Участник #{id}</span>;
      })}</div>}
      {can(leader, "manage_deputies") && <details className={e.deputiesEditor}><summary>Заместители</summary><ActionForm revision={leader.revision} fields={[{ name: "users", label: "До двух заместителей", type: "multi", value: leader.deputy_user_ids.map(String), options: people.options.filter(p => p.value !== String(leader.user.user_id)) }]} onSubmit={(values, revision) => perform(() => eventsApi.deputies(leader.role_assignment_id, ids(values, "users"), { expected_revision: revision! }))} onConflict={refresh} /></details>}
    </div>)}
  </div>;
}
