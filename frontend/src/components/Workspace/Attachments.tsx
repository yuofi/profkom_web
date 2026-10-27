import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FileRef } from "../../utils/api/contract";
import { filesApi } from "../../utils/api/files.api";
import { apiUrl } from "../../utils/api";
import { fileAccept, fileLimitMiB } from "../../utils/filePolicy";
import s from "./Workspace.module.css";
import { userMessage } from "../../utils/api/messages";
import { idPath, normalizeApiError } from "../../utils/api/request";
import { FilePreview } from "./FilePreview";
function useFileDownload() {
  const client = useQueryClient();
  const [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const download = async (file: FileRef) => {
    setBusy(file.file_id);setError("");
    try {
      const checked = await filesApi.download(file.file_id);
      const expected = new URL(apiUrl(`/api/files/${idPath(file.file_id)}/content`), window.location.origin);
      const supplied = new URL(apiUrl(checked.download_url), window.location.origin);
      if (!["http:", "https:"].includes(supplied.protocol) || supplied.href !== expected.href) throw Error("Недопустимая ссылка на файл");
      const link = document.createElement("a");link.href = expected.href;link.download = file.name;link.rel = "noopener noreferrer";link.click();
    } catch (caught) {
      setError(userMessage(caught));
      if ([401, 403, 404].includes(normalizeApiError(caught).status)) void client.invalidateQueries({ queryKey: ["files"] });
    } finally { setBusy(null); }
  };
  return { error, busy, download };
}
export function Attachments({ files }: { files: FileRef[] }) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const { error, busy, download } = useFileDownload();
  const selected = files.find(file => file.file_id === previewId);
  return <>
    <ul className={s.list}>{files.map(file => <li key={file.file_id}>
      <button type="button" className={s.linkButton} aria-label={`Открыть ${file.name}`} onClick={() => setPreviewId(file.file_id)}>{file.name}</button>{" "}
      <span className={s.muted}>{Math.ceil(file.size_bytes / 1024)} КБ</span>{" "}
      <button type="button" className={s.linkButton} aria-label={`Скачать ${file.name}`} disabled={busy !== null} onClick={() => { void download(file); }}>Скачать</button>
    </li>)}</ul>
    {error && <p role="alert" className={s.error}>{error}</p>}
    {selected && <FilePreview key={selected.file_id} file={selected} onClose={() => setPreviewId(null)} onDownload={() => { void download(selected); }} downloading={busy === selected.file_id} downloadError={error} />}
  </>;
}
export function AttachmentPicker({
  owner_kind,
  owner_id,
  purpose,
  files,
  onChange,
  onBusyChange,
}: {
  owner_kind: string;
  owner_id?: string;
  purpose: string;
  files: FileRef[];
  onChange: (files: FileRef[]) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const fileDownload = useFileDownload();
  const selected = files.find(file => file.file_id === previewId);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  return (
    <div className={s.form}>
      <label className={s.field}>
        <span>Файлы до {fileLimitMiB(owner_kind)} МиБ</span>
        <input
          ref={input}
          type="file"
          multiple
          disabled={busy}
          accept={fileAccept(owner_kind)}
          onChange={async (event) => {
            const chosen = Array.from(event.target.files ?? []);
            if (!chosen.length) return;
            setError("");
            setBusy(true);
            onBusyChange?.(true);
            const uploaded = [...files];
            try {
              for (const file of chosen) {
                setProgress(0);
                uploaded.push(
                  await filesApi.upload(
                    file,
                    { owner_kind, owner_id, purpose },
                    setProgress,
                  ),
                );
                onChange([...uploaded]);
              }
            } catch (e) {
              setError(userMessage(e));
            } finally {
              setBusy(false);
              onBusyChange?.(false);
              if (input.current) input.current.value = "";
            }
          }}
        />
      </label>
      {busy && <p role="status">Загрузка файла: {progress}%</p>}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {files.map((file) => (
        <div className={s.between} key={file.file_id}>
          <button type="button" className={s.linkButton} aria-label={`Открыть ${file.name}`} onClick={() => setPreviewId(file.file_id)}>{file.name}</button>
          <button
            type="button"
            className={s.button}
            disabled={busy}
            onClick={() =>
              onChange(files.filter((f) => f.file_id !== file.file_id))
            }
          >
            Убрать
          </button>
        </div>
      ))}
      {selected && <FilePreview key={selected.file_id} file={selected} onClose={() => setPreviewId(null)} onDownload={() => { void fileDownload.download(selected); }} downloading={fileDownload.busy === selected.file_id} downloadError={fileDownload.error} />}
    </div>
  );
}
