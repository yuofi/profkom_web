import { useState } from "react";
import { createPortal } from "react-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UserChip } from "../../components/Workspace/UserChip";
import { Glyph, Loading } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { ids } from "../../components/Workspace/formValues";
import { eventsApi } from "../../utils/api/events.api";
import type { Leader } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "../../components/Workspace/Workspace.module.css";
import e from "./EventEditor.module.css";

/** One leader's deputies; the command carries the leader's own revision. The directory loads with the form. */
export function DeputiesForm({ leader, onSaved }: { leader: Leader; onSaved?: () => void }) {
  const people = usePeopleOptions({ includeNonMembers: true }), { perform, refresh } = useWorkspaceActions();
  if (people.isLoading) return <Loading />;
  return <ActionForm revision={leader.revision} changeRequired={["users"]}
    fields={[{ name: "users", label: "До двух заместителей", type: "multi", value: leader.deputy_user_ids.map(String), options: people.options.filter(p => p.value !== String(leader.user.user_id)) }]}
    onSubmit={async (values, revision) => { const saved = await perform(() => eventsApi.deputies(leader.role_assignment_id, ids(values, "users"), { expected_revision: revision! }));onSaved?.();return saved; }} onConflict={refresh} />;
}
/** Each leader with one "Заместители" line; `editable` adds the pencil that opens the deputies dialog. */
export function Leaders({ leaders, editable = true }: { leaders: Leader[]; editable?: boolean }) {
  // Deputies arrive as user references with include_deputies (PF-13); the directory is read
  // only for a leader answered without them, e.g. a block master.
  const lookup = leaders.some(leader => leader.deputy_user_ids.length > 0 && leader.deputies?.length !== leader.deputy_user_ids.length);
  const people = usePeopleOptions({ includeNonMembers: true, enabled: lookup });
  const [editing, setEditing] = useState<string | null>(null);
  const edited = leaders.find(leader => leader.role_assignment_id === editing && can(leader, "manage_deputies"));
  return <div className={e.leaders}>
    {!leaders.length && <span className={`${s.muted} ${e.leaderHint}`}>Руководители пока не назначены</span>}
    {leaders.map(leader => { const manage = editable && can(leader, "manage_deputies");return <div key={leader.role_assignment_id} className={e.leader}><UserChip user={leader.user} />
      {(leader.deputy_user_ids.length > 0 || manage) && <div className={e.deputies}><small>Заместители:</small>{leader.deputy_user_ids.map((id, index) => {
        const user = leader.deputies?.length === leader.deputy_user_ids.length ? leader.deputies[index] : people.options.find(person => person.value === String(id))?.user;
        return user ? <UserChip key={id} user={user} /> : <span key={id} className={`${s.muted} ${e.leaderHint}`}>Участник #{id}</span>;
      })}{!leader.deputy_user_ids.length && <span className={`${s.muted} ${e.leaderHint}`}>не назначены</span>}
      {manage && <button type="button" className={e.iconButton} aria-label={`Изменить заместителей: ${leader.user.display_name}`} onClick={() => setEditing(leader.role_assignment_id)}><Glyph name="edit" /></button>}</div>}
    </div>; })}
    {/* Leaders sit in the branded header; the dialog leaves it, so header button styles do not reach the form. */}
    {edited && createPortal(<UnsavedChangesScope><TrackerTaskDialog title="Заместители" onClose={() => setEditing(null)}>
      <p className={s.muted}>Руководитель: {edited.user.display_name}</p>
      <DeputiesForm leader={edited} onSaved={() => setEditing(null)} />
    </TrackerTaskDialog></UnsavedChangesScope>, document.body)}
  </div>;
}
