import type { ReactNode } from "react";
import clsx from "clsx";
import w from "./Workspace.module.css";
import s from "./BrandedHeader.module.css";

/** The shared ticket header, with decoration clipped independently of menus. */
export function BrandedHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <header className={clsx(w.header, s.root, className)}>
    <div className={clsx(w.header, s.backdrop)} aria-hidden="true" />
    {children}
  </header>;
}
