import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Task } from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { canRetainData } from "../../utils/api/request";
import { userMessage } from "../../utils/api/messages";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import s from "./TrackerFavoriteButton.module.css";

export function TrackerFavoriteButton({ task, compact = false, onBrand = false }: { task: Task; compact?: boolean; onBrand?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");const { perform, refresh } = useWorkspaceActions();const client = useQueryClient();
  // The server's answer is shown at once; the row rereads in the background (PF-02). Once the
  // row has changed, it is the source again.
  const listed = !!task.is_favorite, [answered, setAnswered] = useState<{ was: boolean; now: boolean } | null>(null);
  if (answered && listed !== answered.was) setAnswered(null);
  const favorite = answered && listed === answered.was ? answered.now : listed, label = favorite ? "Убрать из избранного" : "Добавить в избранное";
  return <span className={`${s.wrap} ${onBrand ? s.onBrand : ""}`} data-row-action><button type="button" className={`${s.button} ${favorite ? s.selected : ""} ${compact ? s.compact : ""}`} disabled={busy} aria-label={`${label}: ${task.task_key ?? task.title}`} aria-pressed={favorite} title={label}
    onClick={event => { event.stopPropagation();if (busy) return;setBusy(true);setError("");void perform(async () => { const saved = await tasksApi.setFavorite(task.task_id, !favorite);client.setQueryData(["tasks", task.task_id], saved);return saved; }).then(saved => setAnswered({ was: listed, now: !!saved.is_favorite })).catch(async failure => { setError(userMessage(failure));if (!canRetainData(failure)) await refresh(); }).finally(() => setBusy(false)); }}>
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.55 4.4 1.08 6.3L12 17.3l-5.63 3 1.08-6.3L2.9 9.6l6.3-.9L12 3Z" /></svg>{!compact && <span>{favorite ? "В избранном" : "В избранное"}</span>}
  </button>{error && <span role="alert" className={s.error}>{error}</span>}</span>;
}
