import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { UserRef } from "../../utils/api/contract";
import { directoryApi } from "../../utils/api/directory.api";
import { getContactRoute } from "../../utils/routes";
import s from "./UserChip.module.css";
const fallbackAvatar = "/avatars/default.svg";
function safeAvatar(source: string | null | undefined) {
  if (!source) return fallbackAvatar;
  try {
    const url = new URL(source, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) && (url.origin === window.location.origin || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ? source : fallbackAvatar;
  } catch { return fallbackAvatar; }
}
function Photo({ source, large = false }: { source?: string | null; large?: boolean }) {
  return <img className={large ? s.largePhoto : s.photo} src={safeAvatar(source)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { if (event.currentTarget.getAttribute("src") !== fallbackAvatar) event.currentTarget.src = fallbackAvatar; }} />;
}
/** A profile preview reads the same authorized directory projection as the contacts page. */
export function UserChip({ user, className = "" }: { user: UserRef; className?: string }) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), popup = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null), hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const openPreview = () => { setPortal(anchor.current?.closest("dialog") ?? document.body);setOpen(true); };
  const clearShow = () => { if (showTimer.current) clearTimeout(showTimer.current);showTimer.current = null; };
  const clearHide = () => { if (hideTimer.current) clearTimeout(hideTimer.current);hideTimer.current = null; };
  const show = () => { clearHide();clearShow();showTimer.current = setTimeout(openPreview, 350); };
  const hide = () => { clearShow();clearHide();hideTimer.current = setTimeout(() => setOpen(false), 120); };
  const close = () => { clearShow();clearHide();setOpen(false); };
  useEffect(() => () => { if (showTimer.current) clearTimeout(showTimer.current);if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts, enabled: open && user.user_id !== null });
  const person = contacts.data?.find(item => item.user_id === user.user_id);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!anchor.current || !popup.current) return;
      const rect = anchor.current.getBoundingClientRect(), box = popup.current.getBoundingClientRect();
      popup.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`;
      popup.current.style.top = `${Math.max(8, Math.min(rect.bottom + box.height + 16 > window.innerHeight ? rect.top - box.height - 8 : rect.bottom + 8, window.innerHeight - box.height - 8))}px`;
    };
    position();window.addEventListener("resize", position);window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position);window.removeEventListener("scroll", position, true); };
  }, [open, person, contacts.isLoading, contacts.error]);
  const content = <><Photo source={user.avatar_url} /><span>{user.display_name}</span></>;
  return <span ref={anchor} className={`${s.shell} ${className}`} data-row-action onMouseEnter={show} onMouseLeave={hide}
    onFocus={() => { clearHide();clearShow();openPreview(); }} onBlur={event => { if (!(event.relatedTarget instanceof Node) || !anchor.current?.contains(event.relatedTarget)) hide(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation();close(); } }}>
    {user.user_id === null ? <span className={s.chip} tabIndex={0} aria-describedby={open ? id : undefined}>{content}</span> : <Link className={s.chip} to={getContactRoute(user.user_id)} aria-describedby={open ? id : undefined} onClick={close}>{content}</Link>}
    {open && typeof document !== "undefined" && createPortal(<div ref={popup} id={id} role="tooltip" className={s.preview} data-row-action onMouseEnter={clearHide} onMouseLeave={hide} onClick={event => event.stopPropagation()}>
      <div className={s.identity}><Photo source={person?.photo_url ?? user.avatar_url} large /><div><strong>{person ? [person.surname, person.name, person.patronymic].filter(Boolean).join(" ") : user.display_name}</strong><small>Профиль участника</small></div></div>
      {person ? <dl>{person.group_number && person.group_number !== "0" && <div><dt>Группа</dt><dd>{person.group_number}</dd></div>}{person.blocks && <div><dt>Команды</dt><dd>{person.blocks}</dd></div>}{person.location && <div><dt>Локация</dt><dd>{person.location}</dd></div>}</dl> : <p className={s.hint}>{contacts.isLoading ? "Загружаем профиль…" : "Дополнительные сведения недоступны"}</p>}
    </div>, portal ?? document.body)}
  </span>;
}
