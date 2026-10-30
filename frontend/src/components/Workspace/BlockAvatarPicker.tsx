import { useEffect, useRef, useState } from "react";
import type { Block, FileRef } from "../../utils/api/contract";
import { membershipApi } from "../../utils/api/membership.api";
import { filesApi } from "../../utils/api/files.api";
import { userMessage } from "../../utils/api/messages";
import { fileAccept } from "../../utils/filePolicy";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { can } from "../../utils/session";
import { ActionForm } from "./ActionForm";
import { ChipAvatar, ChipInitials } from "./ChipFace";
import { UnsavedChangesScope } from "./UnsavedChanges";
import { TrackerTaskDialog } from "../../pages/Workspace/TrackerTaskDialog";
import { blockLogo } from "../../utils/teamLogos";
import { Glyph } from "./WorkspaceUI";
import s from "./Workspace.module.css";
import a from "./BlockAvatarPicker.module.css";

export function BlockAvatarPicker({ block }: { block: Block }) {
  const [editing, setEditing] = useState(false);
  const allowed = can(block, "edit_block");
  return <div className={a.headerAvatar} aria-label="Аватар блока">
    <ChipAvatar src={block.avatar_url ?? blockLogo(block.name)} presentation="logo" large fallback={<ChipInitials name={block.name} />} />
    {allowed && <button type="button" className={a.edit} aria-label="Изменить аватар блока" onClick={() => setEditing(true)}><Glyph name="edit" /></button>}
    {editing && allowed && <UnsavedChangesScope><TrackerTaskDialog title="Аватар блока" onClose={() => setEditing(false)}><AvatarEditor key={block.block_id} block={block} onSaved={() => setEditing(false)} /></TrackerTaskDialog></UnsavedChangesScope>}
  </div>;
}
function AvatarEditor({ block, onSaved }: { block: Block; onSaved: () => void }) {
  // undefined retains the saved image, null explicitly clears it; a file remains a local draft until PATCH.
  const [draft, setDraft] = useState<FileRef | null | undefined>(undefined);
  const [originalAvatar, setOriginalAvatar] = useState(block.avatar_url ?? null);
  const [uploading, setUploading] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const { perform, refresh } = useWorkspaceActions();
  useEffect(() => () => controller.current?.abort(), []);
  const preview = draft === undefined ? originalAvatar : draft ? `/api/files/${encodeURIComponent(draft.file_id)}/content` : null;
  const saved = block.avatar_url ?? null;
  return <ActionForm fields={[]} revision={block.revision} record={`block:${block.block_id}`}
    externalState={{ avatar: preview }} savedExternalState={{ avatar: saved }} externalBusy={uploading}
    onReplaceWithSaved={() => { setDraft(undefined);setOriginalAvatar(saved);setError(""); }}
    savedDetails={<ChipAvatar src={saved ?? blockLogo(block.name)} presentation="logo" large fallback={<ChipInitials name={block.name} />} />}
    onSubmit={async (_, revision) => {
      if (draft === undefined) return { revision: revision! };
      const result = await perform(() => membershipApi.updateBlock(block.block_id, { expected_revision: revision!, avatar_file_id: draft?.file_id ?? null }));
      onSaved();return result;
    }} onConflict={refresh} submitLabel="Сохранить аватар" successMessage="Аватар блока сохранён">
    <div className={s.row}><ChipAvatar src={preview ?? blockLogo(block.name)} presentation="logo" large fallback={<ChipInitials name={block.name} />} /><span>{draft === null ? blockLogo(block.name) ? "Будет показан логотип блока" : "Будут показаны инициалы блока" : draft ? `Выбрано: ${draft.name}` : "Текущее изображение блока"}</span></div>
    <label className={s.field}>Загрузить аватар блока<input type="file" accept={fileAccept("block")} disabled={uploading}
      onChange={async event => {
        const input = event.currentTarget, file = input.files?.[0];if (!file) return;
        setError("");setUploading(true);setProgress(0);controller.current = new AbortController();
        try { setDraft(await filesApi.upload(file, { owner_kind: "block", owner_id: block.block_id, purpose: "avatar" }, setProgress, controller.current.signal)); }
        catch (failure) { setError(userMessage(failure)); }
        finally { setUploading(false);controller.current = null;input.value = ""; }
      }} /></label>
    <small>PNG, JPEG или WebP до 10 МиБ. Изменение появится у всех после сохранения.</small>
    {uploading && <p role="status">Загрузка аватара: {progress}%</p>}
    {error && <p role="alert" className={s.error}>{error}</p>}
    {(preview || draft) && <button type="button" className={s.button} disabled={uploading} onClick={() => setDraft(null)}>Убрать аватар</button>}
    {draft !== undefined && <button type="button" className={s.linkButton} disabled={uploading} onClick={() => { setDraft(undefined);setOriginalAvatar(saved);setError(""); }}>Вернуть сохранённый аватар</button>}
  </ActionForm>;
}
