import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { directoryApi } from "../../utils/api/directory.api";
import { filesApi } from "../../utils/api/files.api";
import { fileAccept } from "../../utils/filePolicy";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { QueryState } from "./WorkspaceUI";
import s from "./Workspace.module.css";
import { userMessage } from "../../utils/api/messages";
import { useMe } from "../../utils/me";
export function AvatarPicker() {
  const me = useMe();
  const query = useQuery({
    queryKey: ["avatars"],
    queryFn: directoryApi.avatars,
  });
  const { perform } = useWorkspaceActions();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const save = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      await perform(action);
      setSuccess(true);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.form}>
      <QueryState loading={query.isLoading} error={query.error}>
        <div className={s.avatars}>
          {query.data?.items.map((p) => (
            <button
              className={s.avatarTile}
              key={p.preset_id}
              type="button"
              aria-pressed={me?.photo_url === p.image_url}
              disabled={busy}
              onClick={() => {
                void save(() =>
                  directoryApi.avatar({ preset_id: p.preset_id }),
                );
              }}
            >
              <img src={p.image_url} alt="" width={56} height={56} />
              <span>{p.title}</span>
            </button>
          ))}
        </div>
      </QueryState>
      {/* The system's file field is hidden: the label is the site's button that opens it. */}
      <label className={s.upload}>
        <span className={s.linkButton}>Загрузить своё фото</span>
        <small>PNG, JPEG или WebP до 10 МиБ</small>
        <input
          className={s.visuallyHidden}
          type="file"
          accept={fileAccept("avatar")}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void save(async () => {
              const uploaded = await filesApi.upload(
                file,
                { owner_kind: "avatar", purpose: "avatar" },
                setProgress,
              );
              await directoryApi.avatar({ file_id: uploaded.file_id });
            });
          }}
        />
      </label>
      {busy && <p role="status">Сохраняем аватар · загрузка {progress}%</p>}
      {success && (
        <p role="status" className={s.success}>
          Аватар сохранён
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </div>
  );
}
