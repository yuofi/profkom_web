import { useState } from "react";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UserChip } from "../../components/Workspace/UserChip";
import { Loading } from "../../components/Workspace/WorkspaceUI";
import { ids } from "../../components/Workspace/formValues";
import { eventsApi } from "../../utils/api/events.api";
import type { Leader } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import s from "../../components/Workspace/Workspace.module.css";
import e from "./EventEditor.module.css";

export function Leaders({ leaders }: { leaders: Leader[] }) {
  // Deputies arrive as user references with include_deputies (PF-13); the directory is read
  // only for a leader answered without them, e.g. a block master.
  const lookup = leaders.some(leader => leader.deputy_user_ids.length > 0 && leader.deputies?.length !== leader.deputy_user_ids.length);
  const people = usePeopleOptions({ includeNonMembers: true, enabled: lookup });
  return <div className={e.leaders}>
    {!leaders.length && <span className={`${s.muted} ${e.leaderHint}`}>Руководители пока не назначены</span>}
    {leaders.map(leader => <div key={leader.role_assignment_id} className={e.leader}><UserChip user={leader.user} />
      {leader.deputy_user_ids.length > 0 && <div className={e.deputies}><small>Заместители</small>{leader.deputy_user_ids.map((id, index) => {
        const user = leader.deputies?.length === leader.deputy_user_ids.length ? leader.deputies[index] : people.options.find(person => person.value === String(id))?.user;
        return user ? <UserChip key={id} user={user} /> : <span key={id} className={`${s.muted} ${e.leaderHint}`}>Участник #{id}</span>;
      })}</div>}
      {can(leader, "manage_deputies") && <DeputiesEditor leader={leader} />}
    </div>)}
  </div>;
}
/** The directory for the deputy picker loads when the editor is first opened, then the form stays. */
function DeputiesEditor({ leader }: { leader: Leader }) {
  const [opened, setOpened] = useState(false);
  return <details className={e.deputiesEditor} onToggle={event => { if (event.currentTarget.open) setOpened(true); }}><summary>Заместители</summary>{opened && <DeputiesForm leader={leader} />}</details>;
}
function DeputiesForm({ leader }: { leader: Leader }) {
  const people = usePeopleOptions({ includeNonMembers: true }), { perform, refresh } = useWorkspaceActions();
  if (people.isLoading) return <Loading />;
  return <ActionForm revision={leader.revision} fields={[{ name: "users", label: "До двух заместителей", type: "multi", value: leader.deputy_user_ids.map(String), options: people.options.filter(p => p.value !== String(leader.user.user_id)) }]} onSubmit={(values, revision) => perform(() => eventsApi.deputies(leader.role_assignment_id, ids(values, "users"), { expected_revision: revision! }))} onConflict={refresh} />;
}
