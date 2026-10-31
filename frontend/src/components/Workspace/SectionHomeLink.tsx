import { useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import { SectionContext, sectionOf } from "./sections";
import s from "./SectionHomeLink.module.css";

/** A section stamp remains a normal router link, including modified clicks and draft guards;
 * on the section's own page without filters it is plain text, since a link would lead to the same page. */
export function SectionHomeLink({ to, label, className = "" }: { to?: string; label?: string; className?: string }) {
  const section = useContext(SectionContext), { pathname, search } = useLocation();
  const current = section ?? sectionOf(pathname), target = to ?? current.to;
  if (pathname === target && !search) return <span className={`${s.link} ${s.here} ${className}`}>Профком ВМК · {label ?? current.label}</span>;
  return <Link className={`${s.link} ${className}`} to={target}>Профком ВМК · {label ?? current.label}</Link>;
}
