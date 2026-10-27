import { UserChip } from "../../components/Workspace/UserChip";
import type { UserRef } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { statusNames } from "./trackerStatus";
import s from "./TrackerTaskDetail.module.css";

type HistoryValue = string | string[] | null;
export interface ReadableTaskChange { field: string; label?: string; before: HistoryValue; after: HistoryValue; before_users?: UserRef[]; after_users?: UserRef[] }
const publicFields = new Set(["title", "description", "deadline_at", "status", "comment", "attachments", "parent_task_id", "assignees", "watchers", "season_id"]);
const fieldLabels: Record<string, string> = { season_id: "Сезон", watchers: "Наблюдатели", comment: "Комментарий", title: "Название", description: "Описание", status: "Статус", queue: "Очередь", queue_id: "Очередь", parent_task_id: "Родительская задача", parent_task: "Родительская задача", attachments: "Вложения", file_ids: "Вложения", assignees: "Исполнители", deadline_at: "Дедлайн" };
function readable(value: HistoryValue, field: string) {
  if (value === null) return "Не задано";
  if (Array.isArray(value)) return value.length ? value.join("\n") : "Не задано";
  if (field === "status" && value in statusNames) return statusNames[value as keyof typeof statusNames];
  if (field === "deadline_at" && Number.isFinite(Date.parse(value))) return displayDate(value);
  return value || "Пусто";
}
/** Keep line breaks and unchanged edge context; replaced text remains literal, never executable Markdown. */
function difference(before: string, after: string) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  let start = 0, end = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]) end++;
  const context = oldLines.slice(Math.max(0, start - 2), start).map(text => ({ kind: "context", text }));
  const removed = oldLines.slice(start, oldLines.length - end).map(text => ({ kind: "removed", text }));
  const added = newLines.slice(start, newLines.length - end).map(text => ({ kind: "added", text }));
  const tail = end ? oldLines.slice(oldLines.length - end, oldLines.length - end + 2).map(text => ({ kind: "context", text })) : [];
  return [...context, ...removed, ...added, ...tail];
}
export function TrackerTaskHistoryDiff({ changes }: { changes: ReadableTaskChange[] }) {
  const visible = changes.filter(change => publicFields.has(change.field));
  if (!visible.length) return null;
  return <div className={s.historyChanges}>{visible.map((change, index) => {
    const label = change.label || fieldLabels[change.field] || "Данные задачи";
    return <section className={s.historyChange} key={`${change.field}-${index}`} aria-label={`Изменено: ${label}`}><h3>{label}</h3>
      {["assignees", "watchers", "season_id"].includes(change.field) && Array.isArray(change.before_users) && Array.isArray(change.after_users) ? <div className={s.rosterDiff}>{([["Было", change.before_users], ["Стало", change.after_users]] as const).map(([title, users]) => <section key={title}><h4>{title}</h4>{users.length ? users.map((user, userIndex) => <UserChip key={`${user.user_id ?? "anonymous"}-${userIndex}`} user={user} />) : <span className={s.planned}>Нет участников</span>}</section>)}</div> : <>
        <div className={s.diffLegend}><span>− Удалено</span><span>+ Добавлено</span></div>
        <pre aria-label={`Изменения поля: ${label}`} className={s.diff}>{difference(readable(change.before, change.field), readable(change.after, change.field)).map((line, lineIndex) => <span key={lineIndex} data-change={line.kind} className={line.kind === "removed" ? s.diffRemoved : line.kind === "added" ? s.diffAdded : s.diffContext}><span aria-hidden="true" className={s.diffSign}>{line.kind === "removed" ? "−" : line.kind === "added" ? "+" : " "}</span>{line.text || " "}</span>)}</pre>
      </>}
    </section>;
  })}</div>;
}
