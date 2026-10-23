import { useRef, useState } from "react";
import type { FileRef } from "../../utils/api/contract";
import { filesApi } from "../../utils/api/files.api";
import { normalizeApiError } from "../../utils/api/request";
import { apiUrl } from "../../utils/api";
import { fileAccept, fileLimitMiB } from "../../utils/filePolicy";
import s from "./Workspace.module.css";
export function Attachments({ files }: { files: FileRef[] }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <ul className={s.list}>
        {files.map((file) => (
          <li key={file.file_id}>
            <button
              type="button"
              className={s.button}
              disabled={busy === file.file_id}
              onClick={async () => {
                setBusy(file.file_id);
                setError("");
                try {
                  // Asking first checks access and renews the session the link then uses.
                  const result = await filesApi.download(file.file_id);
                  const url = new URL(apiUrl(result.download_url), window.location.origin);
                  const protocol = url.protocol;
                  if (
                    !["http:", "https:"].includes(protocol) &&
                    !(import.meta.env.DEV && protocol === "data:")
                  )
                    throw Error("Недопустимая ссылка на файл");
                  const link = document.createElement("a");
                  link.href = url.href;
                  link.download = file.name;
                  link.rel = "noopener noreferrer";
                  link.click();
                } catch (e) {
                  setError(normalizeApiError(e).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Скачать {file.name}
            </button>{" "}
            <span className={s.muted}>
              {Math.ceil(file.size_bytes / 1024)} КБ
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </>
  );
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
              setError(normalizeApiError(e).message);
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
          <span>{file.name}</span>
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
    </div>
  );
}
