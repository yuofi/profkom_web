import { useRef, useState } from "react";
import type { FileRef } from "../../utils/api/contract";
import { filesApi } from "../../utils/api/files.api";
import { normalizeApiError } from "../../utils/api/request";
import s from "./Workspace.module.css";
const allowed = /\.(png|jpe?g|webp|gif|pdf|docx?|xlsx?|pptx?|zip|txt)$/i;
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
                  const result = await filesApi.download(file.file_id);
                  const protocol = new URL(
                    result.download_url,
                    window.location.origin,
                  ).protocol;
                  if (
                    !["http:", "https:"].includes(protocol) &&
                    !(import.meta.env.DEV && protocol === "data:")
                  )
                    throw Error("Недопустимая ссылка на файл");
                  const link = document.createElement("a");
                  link.href = result.download_url;
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
  maxMiB = 20,
}: {
  owner_kind: string;
  owner_id?: string;
  purpose: string;
  files: FileRef[];
  onChange: (files: FileRef[]) => void;
  onBusyChange?: (busy: boolean) => void;
  maxMiB?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  return (
    <div className={s.form}>
      <label className={s.field}>
        <span>Файлы до {maxMiB} МБ</span>
        <input
          ref={input}
          type="file"
          multiple
          disabled={busy}
          accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt"
          onChange={async (event) => {
            const chosen = Array.from(event.target.files ?? []);
            if (!chosen.length) return;
            setError("");
            setBusy(true);
            onBusyChange?.(true);
            const uploaded = [...files];
            try {
              for (const file of chosen) {
                if (file.size > maxMiB * 1024 * 1024)
                  throw Error(`${file.name}: размер больше ${maxMiB} МБ`);
                if (!allowed.test(file.name))
                  throw Error(`${file.name}: неподдерживаемый формат`);
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
