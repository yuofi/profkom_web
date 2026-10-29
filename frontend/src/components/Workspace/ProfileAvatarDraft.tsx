import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { directoryApi } from "../../utils/api/directory.api";
import { filesApi } from "../../utils/api/files.api";
import type { AvatarSelection } from "../../utils/api/profileFeatures.api";
import { userMessage } from "../../utils/api/messages";
import { fileAccept } from "../../utils/filePolicy";
import { Card, QueryState } from "./WorkspaceUI";
import s from "./ProfileFeatures.module.css";
import w from "./Workspace.module.css";
export function ProfileAvatarDraft({ value, savedUrl, onChange, onBusy, disabled }: {
  value: AvatarSelection | null; savedUrl?: string | null; onChange: (value: AvatarSelection) => void;
  onBusy: (busy: boolean) => void; disabled: boolean;
}) {
  const query = useQuery({ queryKey: ["avatars"], queryFn: directoryApi.avatars });
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const preview = value ? "preset_id" in value ? `/avatars/${value.preset_id}.svg` : `/api/files/${encodeURIComponent(value.file_id)}/content` : savedUrl;
  return <Card title="Аватар"><p>Выбор применится общей кнопкой «Сохранить».</p>
    {preview && <img src={preview} className={s.preview} alt="Предпросмотр аватара" />}
    <QueryState loading={query.isLoading} error={query.error}><div className={s.presets}>{query.data?.items.map(preset => <button type="button" key={preset.preset_id} className={s.preset}
      disabled={disabled || busy} aria-pressed={value && "preset_id" in value ? value.preset_id === preset.preset_id : savedUrl === preset.image_url}
      onClick={() => { setError("");onChange({ preset_id: preset.preset_id }); }}><img src={preset.image_url} width={48} height={48} alt="" /><span>{preset.title}</span></button>)}</div></QueryState>
    <label className={w.upload}><span className={w.linkButton}>Загрузить своё фото</span><small>PNG, JPEG или WebP до 10 МиБ</small><input className={w.visuallyHidden} type="file" accept={fileAccept("avatar")} disabled={disabled || busy}
      onChange={event => { const file = event.target.files?.[0];event.target.value = "";if (!file) return;setBusy(true);onBusy(true);setError("");controller.current = new AbortController();
        void filesApi.upload(file, { owner_kind: "avatar", purpose: "avatar" }, setProgress, controller.current.signal)
          .then(uploaded => onChange({ file_id: uploaded.file_id }))
          .catch(failure => { if (!controller.current?.signal.aborted) setError(userMessage(failure)); })
          .finally(() => { setBusy(false);onBusy(false); });
      }} /></label>
    {busy && <p role="status">Подготавливаем фото · {progress}%</p>}{error && <p role="alert" className={w.error}>{error}</p>}
  </Card>;
}
