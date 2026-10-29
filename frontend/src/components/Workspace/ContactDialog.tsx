import { useEffect, useId, useRef, type ReactNode } from "react";
import { useGuardedAction } from "./unsavedChangesHooks";
import { Glyph } from "./WorkspaceUI";
import s from "./ContactDialog.module.css";

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
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestLeave(onClose);
      }}
      onCancel={(event) => { event.preventDefault(); requestLeave(onClose); }}>
      <header className={s.header}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className={s.close} onClick={() => requestLeave(onClose)} aria-label="Закрыть сведения об участнике"><Glyph name="close" /></button>
      </header>
      <div className={s.content}>{children}</div>
    </dialog>
  );
}
