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
import s from "./Workspace.module.css";

export function BlockAvatarPicker({ block }: { block: Block }) {
  return can(block, "edit_block") ? <AvatarEditor key={block.block_id} block={block} /> : null;
}
function AvatarEditor({ block }: { block: Block }) {
  // undefined retains the saved image, null explicitly clears it; a file remains a local draft until PATCH.
  const [draft, setDraft] = useState<FileRef | null | undefined>(undefined);
  const [originalAvatar, setOriginalAvatar] = useState(block.avatar_url ?? null);
  const [uploading, setUploading] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const { perform, refresh } = useWorkspaceActions();
  useEffect(() => () => controller.current?.abort(), []);
  const preview = draft === undefined ? originalAvatar : draft ? `/api/files/${encodeURIComponent(draft.file_id)}/content` : null;
  const saved = block.avatar_url ?? null;
  return <ActionForm title="Аватар блока" fields={[]} revision={block.revision} record={`block:${block.block_id}`}
    externalState={{ avatar: preview }} savedExternalState={{ avatar: saved }} externalBusy={uploading}
    onReplaceWithSaved={() => { setDraft(undefined);setOriginalAvatar(saved);setError(""); }}
    savedDetails={<ChipAvatar src={saved} large fallback={<ChipInitials name={block.name} />} />}
    onSubmit={async (_, revision) => {
      if (draft === undefined) return { revision: revision! };
      return perform(() => membershipApi.updateBlock(block.block_id, { expected_revision: revision!, avatar_file_id: draft?.file_id ?? null }));
    }} onConflict={refresh} submitLabel="Сохранить аватар" successMessage="Аватар блока сохранён">
    <div className={s.row}><ChipAvatar src={preview} large fallback={<ChipInitials name={block.name} />} /><span>{draft === null ? "Будут показаны инициалы блока" : draft ? `Выбрано: ${draft.name}` : "Текущее изображение блока"}</span></div>
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
