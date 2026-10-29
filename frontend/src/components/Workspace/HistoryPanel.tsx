import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { historyApi, type HistoryChange, type HistoryTargetKind } from "../../utils/api/history.api";
import { canRetainData } from "../../utils/api/request";
import type { UserRef } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { UserChip } from "./UserChip";
import { Empty, QueryState } from "./WorkspaceUI";
import s from "./HistoryPanel.module.css";
import w from "./Workspace.module.css";
function person(value: unknown): value is UserRef { return !!value && typeof value === "object" && "display_name" in value && "user_id" in value; }
function Value({ value }: { value: unknown }) {
  if (person(value)) return <UserChip user={value} />;
  if (Array.isArray(value) && value.every(person)) return <div className={w.row}>{value.map((user, index) => <UserChip user={user} key={`${user.user_id}/${index}`} />)}</div>;
  if (value === null || value === undefined) return <>Не задано</>;
  if (typeof value === "boolean") return <>{value ? "Да" : "Нет"}</>;
  return <pre>{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value) || "Пусто"}</pre>;
}
function TextDifference({ before, after }: { before: string; after: string }) {
  const old = before.split(/(\s+)/), next = after.split(/(\s+)/);let start = 0, tail = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (tail < old.length - start && tail < next.length - start && old[old.length - tail - 1] === next[next.length - tail - 1]) tail++;
  const prefix = old.slice(0, start).join(""), suffix = tail ? old.slice(-tail).join("") : "";
  const removed = old.slice(start, old.length - tail).join(""), added = next.slice(start, next.length - tail).join("");
  return <div className={s.text} aria-label="Изменения текста">{prefix}{removed && <del data-change="removed" aria-label="Удалено">{removed}</del>}{removed && added && " "}{added && <ins data-change="added" aria-label="Добавлено">{added}</ins>}{suffix}</div>;
}
export function HistoryDisclosure(props: Omit<Parameters<typeof HistoryPanel>[0], "order">) {
  const [open, setOpen] = useState(false);
  return <details className={w.details} onToggle={event => setOpen(event.currentTarget.open)}><summary>{props.title ?? "История изменений"}</summary>{open && <HistoryPanel {...props} />}</details>;
}
function Change({ change }: { change: HistoryChange }) {
  const textual = ["title", "description", "comment", "result", "review_note", "announcement", "name"].includes(change.field);
  return <section className={s.change}><h4>{change.label}</h4>{textual && (typeof change.before === "string" || change.before === null) && (typeof change.after === "string" || change.after === null)
    ? <TextDifference before={change.before ?? ""} after={change.after ?? ""} />
    : <dl className={s.values}><div><dt>Было</dt><dd><Value value={change.before_users ?? change.before} /></dd></div><div><dt>Стало</dt><dd><Value value={change.after_users ?? change.after} /></dd></div></dl>}
  </section>;
}
export function HistoryPanel({ kind, id, order: controlledOrder, title = "История изменений" }: { kind: HistoryTargetKind; id: string; order?: "newest" | "oldest"; title?: string }) {
  const query = useQuery({ queryKey: ["history", kind, id], queryFn: () => historyApi.list(kind, id) });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const [ownOrder, setOrder] = useState<"newest" | "oldest">("newest"), [armed, setArmed] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const client = useQueryClient(), order = controlledOrder ?? ownOrder;
  const items = [...(data?.items ?? [])].sort((a, b) => (order === "newest" ? -1 : 1) * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
  return <section className={s.panel} aria-label={title}><div className={s.heading}><h3>{title}</h3>{!controlledOrder && <select aria-label="Порядок истории" value={ownOrder} onChange={event => setOrder(event.target.value as typeof ownOrder)}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option></select>}</div>
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data} retry={() => void query.refetch()}>
      <ol className={s.list}>{items.map(entry => <li className={s.entry} key={entry.id}>
        <header><UserChip user={entry.changed_by} /><time dateTime={entry.created_at}>{displayDate(entry.created_at)}</time></header>
        {entry.hidden ? <div className={s.hidden}><p>Версия скрыта</p>{entry.hidden_by && <p>Скрыл(а) <UserChip user={entry.hidden_by} /> · {displayDate(entry.hidden_at)}</p>}</div> : <><p>{entry.description}</p>{entry.reason && <p>Причина: {entry.reason}</p>}{entry.changes.map((change, index) => <Change key={`${change.field}/${index}`} change={change} />)}</>}
        {entry.can_hide && <>{armed !== entry.id ? <button type="button" className={w.button} disabled={busy} onClick={() => setArmed(entry.id)}>Скрыть версию</button> : <div className={s.confirm}><p>Текст этой версии исчезнет из истории. Текущие данные и ККР сохранятся.</p><div className={w.row}><button type="button" className={`${w.button} ${w.danger}`} disabled={busy} onClick={() => { if (busy) return;setBusy(true);setError(null);void historyApi.hide(entry).then(async () => { setArmed(null);await Promise.all([client.invalidateQueries({ queryKey: ["history"] }), client.invalidateQueries({ queryKey: ["tasks", id, "history"] })]); }).catch(setError).finally(() => setBusy(false)); }}>Подтвердить скрытие</button><button type="button" className={w.button} disabled={busy} onClick={() => setArmed(null)}>Отмена</button></div></div>}</>}
      </li>)}</ol>{data && !items.length && <Empty>Записанных изменений пока нет.</Empty>}
    </QueryState>{error != null && <QueryState loading={false} error={error}>{null}</QueryState>}
  </section>;
}
