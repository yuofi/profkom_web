import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { taskChatApi, type ChatLinkCode, type ChatScope } from "../../utils/api/taskChat.api";
import { can } from "../../utils/session";
import { copyText } from "../../utils/clipboard";
import { displayDate } from "../../utils/dates";
import { userMessage } from "../../utils/api/messages";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import { Glyph, QueryState } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "./TaskChat.module.css";
import w from "../../components/Workspace/Workspace.module.css";

/** Mount only when the scope's authoritative manage_chat capability is present. */
export function TaskChatSettingsAction({ scope }: { scope: ChatScope }) {
  const [params, setParams] = useSearchParams(), [busy, setBusy] = useState(false);
  const open = params.get("chat") === "settings";
  const show = (value: boolean) => { const next = new URLSearchParams(params);if (value) next.set("chat", "settings");else next.delete("chat");setParams(next, { replace: true }); };
  return <>
    <button type="button" className={w.button} onClick={() => show(true)}><Glyph name="groups" />Настройки чата</button>
    {open && <UnsavedChangesScope><TrackerTaskDialog title="Чат команды в VK" onClose={() => show(false)} busy={busy}><TaskChatSettings key={`${scope.kind}:${scope.id}`} scope={scope} onBusyChange={setBusy} /></TrackerTaskDialog></UnsavedChangesScope>}
  </>;
}

export function TaskChatSettings({ scope, onBusyChange }: { scope: ChatScope; onBusyChange?: (value: boolean) => void }) {
  const client = useQueryClient(), key = ["tasks", "chat-settings", scope.kind, scope.id];
  const [code, setCode] = useState<ChatLinkCode | null>(null), [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false), [confirmUnlink, setConfirmUnlink] = useState(false);
  const activeCode = !!code && Date.parse(code.expires_at) > now;
  const query = useQuery({ queryKey: key, queryFn: () => taskChatApi.settings(scope), refetchInterval: query => activeCode && query.state.data?.revision === code?.revision && can(query.state.data, "link_chat") && !query.state.error ? 3000 : false });
  const settings = !query.error || canRetainData(query.error) ? query.data : undefined;
  // A confirmed/replaced/revoked binding invalidates the displayed challenge, too.
  const visibleCode = code && settings && settings.revision === code.revision && can(settings, "link_chat") && !query.error ? code : null;
  const waitingForConfirmation = activeCode && !!visibleCode;
  useEffect(() => { if (!waitingForConfirmation) return;const timer = window.setInterval(() => setNow(Date.now()), 1000);return () => window.clearInterval(timer); }, [waitingForConfirmation]);
  useEffect(() => { if (code && settings && settings.revision !== code.revision) void client.invalidateQueries({ queryKey: ["tasks", "chat-context"] }); }, [code, settings, client]);
  const command = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);onBusyChange?.(true);setError("");
    try { await action(); }
    catch (failure) { setError(normalizeApiError(failure).code === "missing_vk" ? "Сначала привяжите свой аккаунт VK к сайту, затем получите код подключения чата." : userMessage(failure));setCode(null);void query.refetch(); }
    finally { setPending(false);onBusyChange?.(false); }
  };
  return <div className={s.settings}>
    <QueryState loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>
      {settings && <>
        <section className={s.card} aria-label="Подключение чата"><h3>{settings.binding?.title ?? "Чат не подключён"}</h3><p>{settings.binding ? settings.binding.state === "linked" ? "Чат подключён. При создании задачи можно включить сообщение от бота." : "Боту недоступен чат. Верните его в беседу и проверьте права, затем подключите чат заново." : "Привяжите беседу команды, чтобы отправлять туда новые задачи."}</p>{settings.binding && <p className={s.note}>Подключён {displayDate(settings.binding.confirmed_at)}</p>}</section>
        {visibleCode ? <section className={s.code} aria-label="Код подключения чата">
          {activeCode ? <><p>Отправьте эту команду в нужную беседу от своего аккаунта VK:</p><input aria-label="Команда подключения чата" value={visibleCode.command} readOnly onFocus={event => event.currentTarget.select()} /><div className={s.actions}><button type="button" className={w.button} onClick={async () => setCopied(await copyText(visibleCode.command))}>Скопировать команду</button></div><p role="status">{copied ? "Команда скопирована. " : ""}Код действует ещё {Math.max(1, Math.ceil((Date.parse(visibleCode.expires_at) - now) / 60000))} мин.</p><p className={s.note}>Код одноразовый и привязан к вашему VK. Не пересылайте его другим людям. После подтверждения ботом подключение появится здесь автоматически.</p></> : <p role="status">Срок кода истёк. Получите новый код.</p>}
        </section> : code && settings.binding && settings.revision !== code.revision ? <p role="status">Привязка чата обновлена.</p> : null}
        {can(settings, "link_chat") && <>
          <ol><li>Добавьте HereBot в беседу VK и дайте ему права администратора для доступа к участникам.</li><li>Убедитесь, что ваш аккаунт VK привязан к сайту и вы администратор этой беседы.</li><li>Получите команду и отправьте её в беседу. Здесь появится название чата.</li></ol>
          <button type="button" className={w.button} disabled={pending || query.isFetching} onClick={() => void command(async () => {
            const next = await taskChatApi.linkCode(scope, { expected_revision: settings.revision });setCode(next);setNow(Date.now());setCopied(false);setConfirmUnlink(false);
          })}>{pending ? "Подождите…" : visibleCode ? "Получить новый код" : settings.binding ? "Подключить другой чат" : "Получить код подключения"}</button>
          {settings.binding && <p className={s.note}>Текущий чат останется подключён до подтверждения нового. Новый код заменяет предыдущий.</p>}
        </>}
        {can(settings, "unlink_chat") && (confirmUnlink ? <section className={s.code} aria-label="Подтверждение отключения"><p>Отключить этот чат? Новые сообщения о задачах больше не будут уходить в него.</p><div className={s.actions}><button type="button" className={w.button} disabled={pending} onClick={() => void command(async () => {
          const saved = await taskChatApi.unlink(scope, { expected_revision: settings.revision });client.setQueryData(key, saved);setCode(null);setConfirmUnlink(false);void client.invalidateQueries({ queryKey: ["tasks", "chat-context"] });
        })}>Отключить чат</button><button type="button" className={w.button} disabled={pending} onClick={() => setConfirmUnlink(false)}>Отмена</button></div></section> : <button type="button" className={s.link} disabled={pending} onClick={() => setConfirmUnlink(true)}>Отключить чат…</button>)}
      </>}
    </QueryState>
    {error && <p role="alert" className={w.error}>{error}</p>}
  </div>;
}
