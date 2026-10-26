import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import editor from "./MarkdownEditor.module.css";

export function FormattingTool({ label, hint = label, className = "", children, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & { label: string; hint?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState(false);
  const tooltip = useRef<HTMLSpanElement>(null);
  const hide = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setTip(false); };
  const showLater = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setTip(true), 650); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useLayoutEffect(() => {
    if (!tip || !button.current || !tooltip.current) return;
    const anchor = button.current.getBoundingClientRect(), node = tooltip.current;
    const width = node.getBoundingClientRect().width;
    node.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
    const height = node.getBoundingClientRect().height;
    node.style.top = `${Math.max(8, anchor.bottom + height + 16 > window.innerHeight ? anchor.top - height - 8 : anchor.bottom + 8)}px`;
  }, [tip]);
  return <span className={editor.toolShell} onMouseEnter={showLater} onMouseLeave={hide}>
    <button {...props} ref={button} type="button" className={`${editor.tool} ${className}`} aria-label={label} aria-describedby={tip ? id : undefined}
      onFocus={event => { setTip(true); props.onFocus?.(event); }} onBlur={event => { hide(); props.onBlur?.(event); }}
      onClick={event => { hide(); props.onClick?.(event); }} onKeyDown={event => { if (event.key === "Escape") hide(); props.onKeyDown?.(event); }}>{children}</button>
    {tip && <span ref={tooltip} id={id} role="tooltip" className={editor.tooltip}>{hint}</span>}
  </span>;
}

export interface FormattingMenuItem { label: string; icon: ReactNode; shortcut?: string; action: () => void }
export function FormattingMenu({ label, disabled, children, items }: { label: string; disabled?: boolean; children: ReactNode; items: FormattingMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const shell = useRef<HTMLSpanElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const pendingIndex = useRef(0);
  const close = (focus = false) => { setOpen(false); if (focus) shell.current?.querySelector<HTMLButtonElement>("button")?.focus(); };
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    menu.current.querySelectorAll<HTMLButtonElement>("button")[pendingIndex.current]?.focus();
    const position = () => {
      if (!menu.current || !shell.current) return;
      const anchor = shell.current.getBoundingClientRect();
      const width = menu.current.getBoundingClientRect().width;
      menu.current.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
      const below = Math.max(0, window.innerHeight - anchor.bottom - 14), above = Math.max(0, anchor.top - 14);
      const openAbove = below < 200 && above > below;
      menu.current.style.maxHeight = `${Math.max(80, openAbove ? above : below)}px`;
      const height = menu.current.getBoundingClientRect().height;
      menu.current.style.top = `${Math.max(8, openAbove ? anchor.top - height - 6 : anchor.bottom + 6)}px`;
    };
    position();window.addEventListener("resize", position);window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position);window.removeEventListener("scroll", position, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => { if (event.target instanceof Node && !shell.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside);document.removeEventListener("focusin", outside); };
  }, [open]);
  return <span ref={shell} className={editor.menuShell}>
    <FormattingTool label={label} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { pendingIndex.current = 0;setOpen(!open); }} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault();pendingIndex.current = event.key === "ArrowUp" ? items.length - 1 : 0;setOpen(true); }
        if (event.key === "Escape") { event.preventDefault();close(true); }
      }}>{children}<EditorIcon name="chevron" /></FormattingTool>
    {open && !disabled && <div ref={menu} id={id} role="menu" aria-label={label} className={editor.menu} onKeyDown={event => {
      const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;buttons[next]?.focus();
      } else if (event.key === "Escape") { event.preventDefault();event.stopPropagation();close(true); }
    }}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" tabIndex={-1} aria-label={item.label} className={editor.menuItem} onClick={() => { close();item.action(); }}><span className={editor.menuIcon}>{item.icon}</span><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
    </div>}
  </span>;
}

export function EditorIcon({ name }: { name: "link" | "undo" | "redo" | "chevron" | "bullets" | "numbered" | "indent" | "outdent" }) {
  const paths = {
    link: <><path d="m10 13 4-4" /><path d="m8 15-1.4 1.4a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0" /><path d="m14 9 1.4-1.4a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" /></>,
    undo: <><path d="M8 5 3 10l5 5" /><path d="M3 10h11a6 6 0 0 1 6 6v3" /></>,
    redo: <><path d="m16 5 5 5-5 5" /><path d="M21 10H10a6 6 0 0 0-6 6v3" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    bullets: <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3" cy="6" r=".75" /><circle cx="3" cy="12" r=".75" /><circle cx="3" cy="18" r=".75" /></>,
    numbered: <><path d="M9 6h12M9 12h12M9 18h12M3 3v6M2 4l1-1M2 14c0-3 4-3 4 0 0 1-4 4-4 4h4" /></>,
    indent: <><path d="M10 5h11M10 10h11M10 15h11M3 20h18M2 6l4 4-4 4" /></>,
    outdent: <><path d="M10 5h11M10 10h11M10 15h11M3 20h18M6 6l-4 4 4 4" /></>,
  };
  return <svg className={editor.icon} data-editor-icon={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
