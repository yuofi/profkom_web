import { Link } from "react-router-dom";
import w from "./Workspace.module.css";
import s from "./TrackerHomeLink.module.css";

/** A normal router link keeps modified clicks and the shared unsaved-change guard. */
export function TrackerHomeLink({ className = "" }: { className?: string }) {
  return <Link className={`${w.eyebrow} ${s.link} ${className}`} to="/tasks">Профком ВМК · Трекер</Link>;
}
