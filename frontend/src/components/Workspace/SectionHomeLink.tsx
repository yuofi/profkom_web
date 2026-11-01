import { useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import { SectionContext, sectionOf } from "./sections";
import s from "./SectionHomeLink.module.css";

/** A section stamp remains a normal router link, including modified clicks and draft guards.
 *  On the section's own page without filters (or with only the defaults the page set itself,
 *  marked by `sectionDefaults` in the history state) it is the current page, not a link to
 *  itself; with filters it stays a link that resets them (GL-36). */
export function SectionHomeLink({ to, label, className = "" }: { to?: string; label?: string; className?: string }) {
  const section = useContext(SectionContext), { pathname, search, state } = useLocation();
  const current = section ?? sectionOf(pathname);
  // /admin redirects to its first tab: on another tab the stamp keeps the open one.
  const target = (to ?? current.to) === "/admin" && pathname.startsWith("/admin/") ? pathname : to ?? current.to;
  const text = <>Профком ВМК · {label ?? current.label}</>;
  const home = !search || (state as { sectionDefaults?: boolean } | null)?.sectionDefaults === true;
  return target === pathname && home
    ? <span className={`${s.link} ${s.current} ${className}`} aria-current="page">{text}</span>
    : <Link className={`${s.link} ${className}`} to={target}>{text}</Link>;
}
