import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ownedLayerTarget, useAnchoredLayer } from "./useAnchoredLayer";
import s from "./AnchoredLayer.module.css";
export function AnchoredPopover({ open, anchorRef, label, onRequestClose, children, busy = false, className = "", width = 400, initialFocusRef, focusRoot = false }: {
  open: boolean; anchorRef: RefObject<HTMLElement | null>; label: string; onRequestClose: () => void; children: ReactNode; busy?: boolean; className?: string; width?: number; initialFocusRef?: RefObject<HTMLElement | null>; focusRoot?: boolean;
}) {
  const titleId = useId(), layer = useRef<HTMLDivElement>(null), restore = useRef<HTMLElement | null>(null);
  const portal = useAnchoredLayer(open, anchorRef, layer, width);
  useLayoutEffect(() => {
    if (!open || !portal || !layer.current) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : anchorRef.current;
    const body = layer.current.querySelector<HTMLElement>("[data-popover-body]") ?? layer.current;
    const target = focusRoot ? layer.current : initialFocusRef?.current ?? body.querySelector<HTMLElement>("[autofocus]") ?? body.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled)") ?? body.querySelector<HTMLElement>("button:not(:disabled),[tabindex='0']") ?? layer.current;
    target.focus({ preventScroll: true });
    return () => { const previous = restore.current;if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open, portal, anchorRef, initialFocusRef, focusRoot]);
  useEffect(() => {
    if (!open) return;
    const foreignDialog = (target: EventTarget | null) => target instanceof Element && !!target.closest("dialog") && target.closest("dialog") !== layer.current?.closest("dialog");
    const outside = (event: PointerEvent) => { if (!busy && !foreignDialog(event.target) && !ownedLayerTarget(event.target, layer.current) && !anchorRef.current?.contains(event.target as Node)) onRequestClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || foreignDialog(document.activeElement)) return;
      const activeLayer = document.activeElement?.closest("[data-anchored-popover]");
      if (activeLayer && activeLayer !== layer.current) return;
      if (!activeLayer && !anchorRef.current?.contains(document.activeElement)) {
        const siblings = [...document.querySelectorAll<HTMLElement>("[data-anchored-popover]")].filter(node => node.closest("dialog") === (document.activeElement?.closest("dialog") ?? null));
        if (siblings.at(-1) !== layer.current) return;
      }
      event.preventDefault();event.stopPropagation();if (!busy) onRequestClose();
    };
    document.addEventListener("pointerdown", outside);document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside);document.removeEventListener("keydown", escape); };
  }, [open, busy, anchorRef, onRequestClose]);
  if (!open || !portal) return null;
  return createPortal(<div ref={layer} className={`${s.layer} ${s.popover} ${className}`} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1} data-row-action data-anchored-popover
    onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault();event.stopPropagation();if (!busy) onRequestClose(); } }}>
    <header className={s.header}><h2 id={titleId}>{label}</h2><button type="button" className={s.close} aria-label="Закрыть окно" disabled={busy} onClick={() => { if (!busy) onRequestClose(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
    <div className={s.body} data-popover-body>{children}</div>
  </div>, portal);
}
