import { useEffect, useId, useRef, type ReactNode } from "react";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import s from "./TrackerTaskDetail.module.css";

export function TrackerTaskDialog({ title, onClose, children, busy = false }: {
  title: string; onClose: () => void; children: ReactNode; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const leave = useGuardedAction();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.activeElement;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    return () => {
      if (typeof element.close === "function" && element.open) element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const close = () => { if (!busy) leave(onClose); };
  return <dialog ref={ref} className={s.dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}>
    <header className={s.dialogHeader}><h2 id={titleId}>{title}</h2>
      <button type="button" className={s.iconButton} aria-label="Закрыть окно" disabled={busy} onClick={close}><Glyph name="close" /></button>
    </header>
    <div className={s.dialogBody}>{children}</div>
  </dialog>;
}
