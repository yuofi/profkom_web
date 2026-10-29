import { useState } from "react";
import type { FileRef, Task } from "../../utils/api/contract";
import { richText } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { AttachmentPicker } from "../../components/Workspace/Attachments";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { statusNames, taskStatus } from "./trackerStatus";
import s from "./TaskStatusMenu.module.css";

export function TaskResultDialog({ task, onClose, onChanged }: { task: Task; onClose: () => void; onChanged?: () => void }) {
  const [body, setBody] = useState(""), [files, setFiles] = useState<FileRef[]>([]), [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false);
  const { perform, refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Сдать результат" onClose={onClose} busy={busy || uploading}>
    <ActionForm fields={[{ name: "links", label: "Ссылки — каждая с новой строки", type: "textarea" }]} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh} allowExitSave={false} submitLabel="Отправить результат"
      externalState={{ body, files }} savedExternalState={{ body: "", files: [] }} externalBusy={uploading} disabled={busy} onReplaceWithSaved={() => { setBody("");setFiles([]); }}
      savedDetails={<dl><div><dt>Статус задачи</dt><dd>{statusNames[taskStatus(task)]}</dd></div>{task.submissions?.at(-1) && <div><dt>Последняя общая сдача</dt><dd>{new Date(task.submissions.at(-1)!.submitted_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}</dd></div>}</dl>}
      onSubmit={async (values, expectedRevision) => {
        const links = text(values, "links").split("\n").map(value => value.trim()).filter(Boolean);
        if (links.some(link => !/^https?:\/\//i.test(link))) throw Error("Ссылки должны начинаться с https:// или http://");
        if (!body.trim() && !links.length && !files.length) throw Error("Добавьте результат работы, ссылку или файл");
        setBusy(true);
        try { const saved = await perform(() => tasksApi.submitResult(task.task_id, { expected_revision: expectedRevision!, text: richText(body), links, file_ids: files.map(file => file.file_id) }));onChanged?.();onClose();return saved; }
        finally { setBusy(false); }
      }}>
      <MarkdownEditor value={body} onChange={setBody} label="Результат работы" name="body" rows={8} context="result" draft={false} disabled={busy} />
      <fieldset className={s.pickerFields} disabled={busy}><AttachmentPicker owner_kind="task" owner_id={task.task_id} purpose="submission" files={files} onChange={setFiles} onBusyChange={setUploading} /></fieldset>
    </ActionForm>
  </TrackerTaskDialog>;
}
