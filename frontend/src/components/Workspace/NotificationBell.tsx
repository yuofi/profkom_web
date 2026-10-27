import { useId, useRef, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Notification } from "../../utils/api/contract";
import { workspaceApi } from "../../utils/api/workspace.api";
import { canRetainData } from "../../utils/api/request";
import { userMessage } from "../../utils/api/messages";
import { targetRoute } from "../../utils/routes";
import { displayDate } from "../../utils/dates";
import { isActiveSession, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { useConfirmedNavigation } from "./unsavedChangesHooks";
import { AnchoredPopover } from "./AnchoredPopover";
import { Glyph, QueryState } from "./WorkspaceUI";
import s from "./NotificationBell.module.css";

export function NotificationBell() {
  const { session, loading, error: sessionError } = useSession(), active = isActiveSession(session) && !session?.password_change_required && !loading && (!sessionError || canRetainData(sessionError));
  const [open, setOpen] = useState(false), [readingAll, setReadingAll] = useState(false), [error, setError] = useState("");
  const anchor = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), pending = useRef(new Map<string, Promise<void>>()), allPending = useRef(false), panelId = `notifications-${useId()}`;
  const navigate = useConfirmedNavigation(), { perform, refresh } = useWorkspaceActions();
  const query = useQuery({ queryKey: ["notifications"], queryFn: () => workspaceApi.notifications(), enabled: active,
    refetchOnWindowFocus: true, refetchInterval: value => value.state.error && !canRetainData(value.state.error) ? false : 60_000 });
  const visible = active && (!query.error || canRetainData(query.error)), known = visible && !!query.data;
  const items = visible ? [...(query.data?.items ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) : [];
  const unread = items.filter(item => !item.read_at).length, label = known ? `Уведомления, непрочитанных: ${unread}` : "Уведомления";
  const read = (notification: Notification) => {
    if (notification.read_at) return Promise.resolve();
    const existing = pending.current.get(notification.id);if (existing) return existing;
    const action = perform(() => workspaceApi.read(notification.id)).then(() => undefined).catch(async () => { await refresh(); }).finally(() => pending.current.delete(notification.id));
    pending.current.set(notification.id, action);return action;
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>, route: string, notification?: Notification) => {
    if (event.altKey) return;
    const committed = async () => { setOpen(false);if (notification) await read(notification); };
    if (event.metaKey || event.ctrlKey || event.shiftKey) { void committed();return; }
    event.preventDefault();navigate(route, committed);
  };
  const readAll = async () => {
    if (allPending.current || !unread) return;allPending.current = true;setReadingAll(true);setError("");
    try { await perform(workspaceApi.readAll); }
    catch (failure) { setError(userMessage(failure));await refresh(); }
    finally { allPending.current = false;setReadingAll(false); }
  };
  if (!active) return null;
  return <>
    <button ref={anchor} type="button" className={s.bell} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-busy={query.isLoading}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault();setOpen(true); } }}>
      <Glyph name="notifications" className={s.icon} />{known && unread > 0 && <span className={s.badge} aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
    <AnchoredPopover open={open} anchorRef={anchor} label="Уведомления" onRequestClose={() => setOpen(false)} width={400} initialFocusRef={list} className={s.panel}>
      <div id={panelId} className={s.content}>
        <div className={s.toolbar}><span>{known ? unread ? `Непрочитанных: ${unread}` : "Все уведомления прочитаны" : "Ваши уведомления"}</span>{unread > 0 && <button type="button" className={s.readAll} aria-disabled={readingAll} aria-busy={readingAll} onClick={event => { if (document.activeElement === event.currentTarget) list.current?.focus();void readAll(); }}>{readingAll ? "Отмечаем…" : "Прочитать все"}</button>}</div>
        {error && <p role="alert" className={s.error}>{error}</p>}
        <div ref={list} className={s.list} role="region" aria-label="Список уведомлений" tabIndex={0} onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;event.preventDefault();
          const entries = [...(list.current?.querySelectorAll<HTMLElement>('[data-notification-entry]') ?? [])];if (!entries.length) return;
          const current = entries.indexOf(document.activeElement as HTMLElement), next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : current < 0 ? event.key === "ArrowUp" ? entries.length - 1 : 0 : (current + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
          entries[next].focus();
        }}>
          <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => { void query.refetch(); }}>
            {items.length ? <ul>{items.map(notification => {
              const route = targetRoute(notification.target), content = <><span className={s.text}>{notification.text}</span><time dateTime={notification.created_at}>{displayDate(notification.created_at)}</time></>;
              return <li key={notification.id} data-notification-id={notification.id} data-unread={!notification.read_at}>
                {route ? <Link to={route} className={s.notice} data-notification-entry onClick={event => follow(event, route, notification)} onAuxClick={event => { if (event.button === 1) { setOpen(false);void read(notification); } }}>{content}</Link> : <div className={s.notice}>{content}<small>Источник больше недоступен</small></div>}
                {!notification.read_at && <button type="button" className={s.markRead} data-notification-entry={route ? undefined : true} aria-label={`Отметить прочитанным: ${notification.text}`} title="Отметить прочитанным" onClick={event => { if (document.activeElement === event.currentTarget) list.current?.focus();void read(notification); }}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button>}
              </li>;
            })}</ul> : <p className={s.empty}>Уведомлений пока нет.</p>}
          </QueryState>
        </div>
        <Link className={s.all} to="/notifications" onClick={event => follow(event, "/notifications")}>Все уведомления <span aria-hidden="true">→</span></Link>
      </div>
    </AnchoredPopover>
  </>;
}
