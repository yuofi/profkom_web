import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ownedLayerTarget, useAnchoredLayer } from "../../components/Workspace/useAnchoredLayer";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import type { IconName } from "../../components/icons";
import m from "./TaskClassificationMenu.module.css";
import s from "./TrackerTaskDetail.module.css";

/** `icon` stands before the words; `danger` paints both in the site's danger colour (owner 2026-11-08, В5, variant Б). */
export interface CommentMenuAction { label: string; onSelect: () => void; icon?: IconName; danger?: boolean }
/** «⋯» of a comment header: the comment's commands in one menu, built like the task's
 *  classification menu (portal, arrows, Escape, focus back to the trigger). */
export function TrackerCommentMenu({ actions, label = "Действия с комментарием", disabled = false }: { actions: CommentMenuAction[]; label?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), entry = useRef<"first" | "last">("first");
  const menuId = `comment-menu-${useId()}`, shown = open && !disabled, portal = useAnchoredLayer(shown, trigger, menu, 220);
  const close = useCallback(() => setOpen(false), []);
  useLayoutEffect(() => {
    if (!shown || !portal || !menu.current) return;
    const items = [...menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    (entry.current === "last" ? items.at(-1) : items[0])?.focus();
    const button = trigger.current;return () => { if (button?.isConnected) button.focus(); };
  }, [shown, portal]);
  useEffect(() => {
    if (!shown) return;
    const outside = (event: PointerEvent) => { if (!ownedLayerTarget(event.target, menu.current) && !trigger.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);return () => document.removeEventListener("pointerdown", outside);
  }, [shown, close]);
  if (!actions.length) return null;
  return <>
    <button ref={trigger} type="button" className={s.iconButton} disabled={disabled} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={shown} aria-controls={shown ? menuId : undefined}
      onClick={() => { entry.current = "first";setOpen(value => !value); }} onKeyDown={event => {
        if (event.key === "Escape" && shown) { event.preventDefault();close();return; }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();entry.current = event.key === "ArrowUp" ? "last" : "first";setOpen(true);
      }}><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.8" fill="currentColor" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /><circle cx="19" cy="12" r="1.8" fill="currentColor" /></svg></button>
    {shown && portal && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={label} tabIndex={-1} className={m.menu} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault();close();return; }
      if (event.key === "Tab") { close();return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;event.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];if (!items.length) return;
      const active = items.indexOf(document.activeElement as HTMLButtonElement), index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    }}>{actions.map(action => <button type="button" role="menuitem" key={action.label} tabIndex={-1} className={`${m.option} ${s.commentMenuItem} ${action.danger ? s.commentMenuDanger : ""}`} onClick={() => { close();action.onSelect(); }}>{action.icon && <Glyph name={action.icon} className={s.commentMenuIcon} />}<span>{action.label}</span></button>)}</div>, portal)}
  </>;
}
