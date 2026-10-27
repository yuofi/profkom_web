import { useState } from "react";
import { UserChip } from "../../components/Workspace/UserChip";
import { Glyph, QueryState } from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { text } from "../../components/Workspace/formValues";
import type { Block } from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { can } from "../../utils/session";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "../../components/Workspace/Workspace.module.css";

export function BlockHr({ block }: { block: Block }) {
  const [editing, setEditing] = useState(false);
  return <>
    <div className={s.row}>
      {block.hr ? <UserChip user={block.hr} /> : <span className={s.muted}>HR не назначен</span>}
      {can(block, "assign_block_hr") && <button type="button" className={s.button} aria-label="Изменить HR блока" title="Изменить HR блока" onClick={() => setEditing(true)}><Glyph name="edit" /></button>}
    </div>
    {editing && can(block, "assign_block_hr") && <UnsavedChangesScope><TrackerTaskDialog title="HR блока" onClose={() => setEditing(false)}><BlockHrForm block={block} onSaved={() => setEditing(false)} /></TrackerTaskDialog></UnsavedChangesScope>}
  </>;
}
function BlockHrForm({ block, onSaved }: { block: Block; onSaved: () => void }) {
  const people = usePeopleOptions({ includeNonMembers: true }), { perform, refresh } = useWorkspaceActions();
  return <QueryState loading={people.isLoading} error={people.error} keepDataOnError={!!people.data} retry={() => { void people.refetch(); }}><ActionForm revision={block.revision} record={`block:${block.block_id}`} onConflict={refresh} disabled={people.isLoading || !!people.error}
    fields={[{ name: "user", label: "HR блока", type: "select", entity: "person", value: block.hr?.user_id == null ? "" : String(block.hr.user_id), options: people.options, loading: people.isLoading, hint: "Очистите выбор, чтобы снять назначение. Роль HR не включает вступление в блок." }]}
    submitLabel="Сохранить HR блока" onSubmit={async (values, revision) => {
      const value = text(values, "user");
      const saved = await perform(() => membershipApi.assignHr(block.block_id, { expected_revision: revision!, user_id: value ? Number(value) : null }));
      onSaved();return saved;
    }} /></QueryState>;
}
