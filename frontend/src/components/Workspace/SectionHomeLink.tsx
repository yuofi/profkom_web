import { useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import { SectionContext, sectionOf } from "./sections";
import s from "./SectionHomeLink.module.css";

/** A section stamp remains a normal router link, including modified clicks and draft guards.
 *  On the section's own page without filters it is the current page, not a link to itself;
 *  with filters it stays a link that resets them (GL-36). */
export function SectionHomeLink({ to, label, className = "" }: { to?: string; label?: string; className?: string }) {
  const section = useContext(SectionContext), { pathname, search } = useLocation();
  const current = section ?? sectionOf(pathname);
  // /admin redirects to its first tab: on another tab the stamp keeps the open one.
  const target = (to ?? current.to) === "/admin" && pathname.startsWith("/admin/") ? pathname : to ?? current.to;
  const text = <>Профком ВМК · {label ?? current.label}</>;
  return target === pathname && !search
    ? <span className={`${s.link} ${s.current} ${className}`} aria-current="page">{text}</span>
    : <Link className={`${s.link} ${className}`} to={target}>{text}</Link>;
}
