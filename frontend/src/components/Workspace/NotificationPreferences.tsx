import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { profileFeaturesApi, type NotificationPreferences as Preferences, type NotificationCategory, type NotificationChannel, type PreferenceSettings } from "../../utils/api/profileFeatures.api";
import { canRetainData } from "../../utils/api/request";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { getProfileSettingsRoute } from "../../utils/routes";
import { useSession } from "../../utils/session";
import { BOT_LINK_ANCHOR } from "./botLink";
import { Card, QueryState } from "./WorkspaceUI";
import { useUnsavedChanges } from "./unsavedChangesHooks";
import s from "./ProfileFeatures.module.css";
import w from "./Workspace.module.css";
const categories: [NotificationCategory, string][] = [["tracker", "Изменения тикетов трекера"], ["applications", "Новые и одобренные заявки"], ["pgas", "Новые документы ПГАС"]];
const channels: [NotificationChannel, string][] = [["email", "Почта"], ["telegram", "Telegram"], ["vk", "VK"]];
/** «не подключён» in agreement with the channel's name, for a single one. */
const notConnected: Record<NotificationChannel, string> = { email: "не подключена", telegram: "не подключён", vk: "не подключён" };

/** What each channel does now (BOT_API.md, stage 3). An older server sends no `channels`:
 *  the former line stays. The choice of a channel without sending is kept as before. */
function ChannelNotes({ state }: { state: PreferenceSettings["channels"] }) {
  if (!state) return <p className={w.muted}>Отправка ещё не подключена. Выбор сохраняется для будущего подключения каналов.</p>;
  const off = channels.filter(([key]) => state[key] === "not_connected");
  const names = off.map(([, title]) => title), last = names.length - 1;
  return <div className={s.channelNotes}>
    {state.vk === "ready" && <p className={w.muted}>В VK уведомления приходят от бота сообщества: вид события, название и ссылка.</p>}
    {state.vk === "link_required" && <p className={w.muted}>Чтобы получать уведомления в VK, <Link to={`${getProfileSettingsRoute()}#${BOT_LINK_ANCHOR}`}>привяжите бота</Link>.</p>}
    {off.length > 0 && <p className={w.muted}>{off.length === 1 ? `${names[0]} пока ${notConnected[off[0][0]]}` : `${names.slice(0, last).join(", ")} и ${names[last]} пока не подключены`}: выбор сохраняется на будущее.</p>}
  </div>;
}

export function NotificationPreferences() {
  const query = useQuery({ queryKey: ["notificationPreferences"], queryFn: profileFeaturesApi.preferences });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const [baseline, setBaseline] = useState<typeof data>(undefined);
  const [draft, setDraft] = useState<Preferences | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [success, setSuccess] = useState(false);
  const { refresh } = useWorkspaceActions();
  const client = useQueryClient();
  const dirty = !!draft && !!baseline && JSON.stringify(draft) !== JSON.stringify(baseline.preferences);
  if (data && !baseline) { setBaseline(data);setDraft(data.preferences); }
  // The server changed the settings (the first VK link turns VK on): shown when nothing is unsaved.
  else if (data && baseline && !dirty && !busy && (data.revision > baseline.revision || (data.revision === baseline.revision && JSON.stringify(data.preferences) !== JSON.stringify(baseline.preferences)))) { setBaseline(data);setDraft(data.preferences); }
  // A new state of the VK link (the bot block above, a session reread) changes the VK channel
  // and, at the first link, the settings: reread them. Not when the session first arrives.
  const { session } = useSession();
  const linkState = session ? session.bot_link?.state ?? "off" : null;
  const seenLink = useRef(linkState);
  useEffect(() => {
    const seen = seenLink.current;
    seenLink.current = linkState;
    if (seen && linkState && seen !== linkState) void client.invalidateQueries({ queryKey: ["notificationPreferences"] });
  }, [client, linkState]);
  const save = async () => {
    if (!draft || !baseline || busy || !data) return false;
    setBusy(true);setError(null);setSuccess(false);
    try { const saved = await profileFeaturesApi.savePreferences(baseline.revision, draft);setBaseline(saved);setDraft(saved.preferences);setSuccess(true);await refresh();return true; }
    catch (failure) { setError(failure);return false; }
    finally { setBusy(false); }
  };
  useUnsavedChanges({ dirty, busy, label: "Настройки уведомлений", save, discard: () => { setDraft(baseline?.preferences ?? null); } });
  return <Card title="Уведомления вне сайта">
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data}>
      {data && draft && <><ChannelNotes state={data.channels} /><form className={w.form} onSubmit={event => { event.preventDefault();void save(); }}><div className={s.preferences}><table>
        <thead><tr><th scope="col">Событие</th>{channels.map(([key, title]) => <th scope="col" key={key}>{title}</th>)}</tr></thead>
        <tbody>{categories.map(([category, title]) => <tr key={category}><th scope="row">{title}</th>{channels.map(([channel, label]) => <td key={channel}><input type="checkbox" aria-label={`${title}: ${label}`} checked={draft[category][channel]} disabled={busy}
          onChange={event => { const checked = event.target.checked;setDraft(current => current && { ...current, [category]: { ...current[category], [channel]: checked } });setSuccess(false); }} /></td>)}</tr>)}</tbody>
      </table></div><button type="submit" className={`${w.button} ${w.primary}`} disabled={busy || !dirty}>{busy ? "Сохраняем…" : "Сохранить настройки уведомлений"}</button>{success && <p role="status">Настройки сохранены</p>}</form></>}
    </QueryState>
    {error != null && <QueryState loading={false} error={error}><button className={w.button} onClick={() => { void query.refetch().then(result => { if (result.data) { setBaseline(result.data);setDraft(result.data.preferences);setError(null); } }); }}>Перечитать настройки</button></QueryState>}
  </Card>;
}
