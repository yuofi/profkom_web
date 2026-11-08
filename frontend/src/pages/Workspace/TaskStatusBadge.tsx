import type { AssignmentStatus, TaskPublicStatus } from "../../utils/api/contract";
import { toneStyle } from "../../components/Workspace/sections";
import { publicStatus, publicStatusNames, statusTones } from "./trackerStatus";
import s from "./TaskStatusBadge.module.css";

/** A task's public status in a list or a preview: the status chip's colours, nothing to press (owner 2026-11-08, В2). */
export function TaskStatusBadge({ status, className = "" }: { status?: TaskPublicStatus | AssignmentStatus | null; className?: string }) {
  const state = publicStatus(status ?? undefined);
  return <span className={`${s.badge} ${className}`} style={toneStyle(statusTones[state])} data-status={state}><span className={s.dot} aria-hidden="true" /><span className={s.label}>{publicStatusNames[state]}</span></span>;
}
