import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { profileFeaturesApi, type NotificationPreferences as Preferences, type NotificationCategory, type NotificationChannel } from "../../utils/api/profileFeatures.api";
import { canRetainData } from "../../utils/api/request";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { Card, QueryState } from "./WorkspaceUI";
import { useUnsavedChanges } from "./unsavedChangesHooks";
import s from "./ProfileFeatures.module.css";
import w from "./Workspace.module.css";
const categories: [NotificationCategory, string][] = [["tracker", "Изменения тикетов трекера"], ["applications", "Новые и одобренные заявки"], ["pgas", "Новые документы ПГАС"]];
const channels: [NotificationChannel, string][] = [["email", "Почта"], ["telegram", "Telegram"], ["vk", "VK"]];
export function NotificationPreferences() {
  const query = useQuery({ queryKey: ["notificationPreferences"], queryFn: profileFeaturesApi.preferences });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const [baseline, setBaseline] = useState<typeof data>(undefined);
  const [draft, setDraft] = useState<Preferences | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [success, setSuccess] = useState(false);
  const { refresh } = useWorkspaceActions();
  const dirty = !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline.preferences);
  if (data && !baseline) { setBaseline(data);setDraft(data.preferences); }
  const save = async () => {
    if (!draft || !baseline || busy || !data) return false;
    setBusy(true);setError(null);setSuccess(false);
    try { const saved = await profileFeaturesApi.savePreferences(baseline.revision, draft);setBaseline(saved);setDraft(saved.preferences);setSuccess(true);await refresh();return true; }
    catch (failure) { setError(failure);return false; }
    finally { setBusy(false); }
  };
  useUnsavedChanges({ dirty, busy, label: "Настройки уведомлений", save, discard: () => { setDraft(baseline?.preferences ?? null); } });
  return <Card title="Уведомления вне сайта"><p className={w.warning}>Отправка ещё не подключена. Выбор сохраняется для будущего подключения каналов.</p>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data}>
      {data && draft && <form className={w.form} onSubmit={event => { event.preventDefault();void save(); }}><div className={s.preferences}><table>
        <thead><tr><th scope="col">Событие</th>{channels.map(([key, title]) => <th scope="col" key={key}>{title}</th>)}</tr></thead>
        <tbody>{categories.map(([category, title]) => <tr key={category}><th scope="row">{title}</th>{channels.map(([channel, label]) => <td key={channel}><input type="checkbox" aria-label={`${title}: ${label}`} checked={draft[category][channel]} disabled={busy}
          onChange={event => { const checked = event.target.checked;setDraft(current => current && { ...current, [category]: { ...current[category], [channel]: checked } });setSuccess(false); }} /></td>)}</tr>)}</tbody>
      </table></div><button type="submit" className={`${w.button} ${w.primary}`} disabled={busy || !dirty}>{busy ? "Сохраняем…" : "Сохранить настройки уведомлений"}</button>{success && <p role="status">Настройки сохранены</p>}</form>}
    </QueryState>
    {error != null && <QueryState loading={false} error={error}><button className={w.button} onClick={() => { void query.refetch().then(result => { if (result.data) { setBaseline(result.data);setDraft(result.data.preferences);setError(null); } }); }}>Перечитать настройки</button></QueryState>}
  </Card>;
}
