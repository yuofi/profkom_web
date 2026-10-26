import { useEffect, useId, useRef, type ReactNode } from "react";
import { useGuardedAction } from "./unsavedChangesHooks";
import s from "./ContactDialog.module.css";
import w from "./Workspace.module.css";

/** Open details outside the directory grid; the cards keep their dimensions. */
export function ContactDialog({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const requestLeave = useGuardedAction();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    return () => {
      if (typeof node.close === "function" && node.open) node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} className={s.dialog} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); requestLeave(onClose); }}>
      <header className={s.header}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className={w.button} onClick={() => requestLeave(onClose)} aria-label="Закрыть сведения об участнике">Закрыть</button>
      </header>
      <div className={s.content}>{children}</div>
    </dialog>
  );
}
