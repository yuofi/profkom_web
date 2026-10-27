import { useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import { SectionContext, sectionOf } from "./sections";
import s from "./SectionHomeLink.module.css";

/** A section stamp remains a normal router link, including modified clicks and draft guards. */
export function SectionHomeLink({ to, label, className = "" }: { to?: string; label?: string; className?: string }) {
  const section = useContext(SectionContext), { pathname } = useLocation();
  const current = section ?? sectionOf(pathname);
  return <Link className={`${s.link} ${className}`} to={to ?? current.to}>Профком ВМК · {label ?? current.label}</Link>;
}
