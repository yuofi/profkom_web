import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredLayer } from "./useAnchoredLayer";
import s from "./AnchoredLayer.module.css";
export interface HoverCardControls { describedBy?: string; close: () => void }
export function HoverCard({ children, content, className = "", disabled = false, delay = 350, closeDelay = 120 }: {
  children: ReactNode | ((controls: HoverCardControls) => ReactNode); content: () => ReactNode; className?: string; disabled?: boolean; delay?: number; closeDelay?: number;
}) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), layer = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [closed, setClosed] = useState(0);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null), hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = open && !disabled;
  const portal = useAnchoredLayer(shown, anchor, layer, 320);
  const cancelShow = () => { if (showTimer.current) clearTimeout(showTimer.current);showTimer.current = null; };
  const cancelHide = () => { if (hideTimer.current) clearTimeout(hideTimer.current);hideTimer.current = null; };
  const close = () => { setOpen(false);setClosed(value => value + 1); };
  const show = () => { if (disabled) return;cancelHide();cancelShow();showTimer.current = setTimeout(() => setOpen(true), delay); };
  const hide = () => { cancelShow();cancelHide();hideTimer.current = setTimeout(() => setOpen(false), closeDelay); };
  useEffect(() => { if (showTimer.current) clearTimeout(showTimer.current);if (hideTimer.current) clearTimeout(hideTimer.current); }, [closed]);
  useEffect(() => () => { if (showTimer.current) clearTimeout(showTimer.current);if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  useEffect(() => {
    if (!shown) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !(document.activeElement?.closest("dialog") && document.activeElement.closest("dialog") !== layer.current?.closest("dialog"))) { event.preventDefault();event.stopPropagation();setOpen(false); } };
    document.addEventListener("keydown", escape);return () => document.removeEventListener("keydown", escape);
  }, [shown]);
  return <span ref={anchor} className={`${s.anchor} ${className}`} data-row-action onMouseEnter={show} onMouseLeave={hide}
    onFocus={() => { if (!disabled) { cancelShow();cancelHide();setOpen(true); } }}
    onBlur={event => { const target = event.relatedTarget;if (!(target instanceof Node) || (!anchor.current?.contains(target) && !layer.current?.contains(target))) hide(); }}
    onKeyDown={event => { if (event.key === "Escape" && shown) { event.preventDefault();event.stopPropagation();close(); } }}>
    {typeof children === "function" ? children({ describedBy: shown ? id : undefined, close }) : children}
    {shown && portal && createPortal(<div id={id} ref={layer} role="tooltip" className={`${s.layer} ${s.hover}`} data-row-action data-hover-card onMouseEnter={cancelHide} onMouseLeave={hide} onClick={event => event.stopPropagation()}>{content()}</div>, portal)}
  </span>;
}
