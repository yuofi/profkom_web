import { useEffect, useRef, type MouseEvent } from "react";

/** Shows a native <dialog> as modal while `open` (it renders only then): the browser gives
 * Escape (the cancel event), keeps focus inside and makes the page inert; on close the
 * focus returns to the opener. */
export function useModalDialog(open = true) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const previous = document.activeElement;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    return () => {
      if (typeof node.close === "function" && node.open) node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  return ref;
}

/** A click on ::backdrop targets the dialog itself outside its box; one on its padding does not count. */
export function isBackdropClick(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}
