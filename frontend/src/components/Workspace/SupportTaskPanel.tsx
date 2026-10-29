import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supportApi } from "../../utils/api/support.api";
import { canRetainData } from "../../utils/api/request";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm } from "./ActionForm";
import { text } from "./formValues";
import { MarkdownContent } from "./MarkdownContent";
import { Card, QueryState } from "./WorkspaceUI";
import { displayDate } from "../../utils/dates";
import { moscowInput, toUtc } from "../../utils/dates";
import type { Task } from "../../utils/api/contract";
import s from "./Workspace.module.css";

function Screenshot({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false), picture = useRef<HTMLImageElement>(null);
  const query = useQuery({ queryKey: ["supportTask", taskId, "screenshot"], queryFn: () => supportApi.screenshot(taskId), enabled: open, gcTime: 0, refetchInterval: open ? 30000 : false });
  const blob = !query.error ? query.data : undefined;
  useEffect(() => {
    const element = picture.current;
    if (!blob || !open || !element) return;
    const address = URL.createObjectURL(blob);element.src = address;
    return () => { element.removeAttribute("src");URL.revokeObjectURL(address); };
  }, [blob, open]);
  return <div><button className={s.button} type="button" onClick={() => setOpen(value => !value)}>{open ? "Скрыть изображение" : "Открыть приложенное изображение"}</button>{open && <QueryState loading={query.isLoading} error={query.error}>{blob && <img ref={picture} alt="Приложенное изображение обращения" style={{ maxWidth: "100%", maxHeight: 600, objectFit: "contain" }} />}</QueryState>}</div>;
}

export function SupportTaskPanel({ task }: { task: Task }) {
  const taskId = task.task_id;
  const query = useQuery({ queryKey: ["supportTask", taskId], queryFn: () => supportApi.task(taskId) });
  const current = !query.error || canRetainData(query.error) ? query.data : undefined;
  const { perform, refresh } = useWorkspaceActions();
  if (!current?.can_triage) return null;
  return <Card title="Поддержка сайта"><QueryState loading={query.isLoading} error={query.error}>
    <p className={s.muted}>Внутренние заметки и диагностику видят только сотрудники поддержки. Ответ пользователю напишите обычным комментарием тикета.</p>
    <ActionForm fields={[{ name: "deadline", label: "Дедлайн поддержки, МСК — необязательно", type: "datetime-local", value: task.deadline_at ? moscowInput(task.deadline_at) : "" }]} revision={task.revision} record={`task:${taskId}`} onConflict={refresh} submitLabel="Сохранить срок" onSubmit={async (values, revision) => perform(() => supportApi.deadline(taskId, text(values, "deadline") ? toUtc(text(values, "deadline")) : null, revision!))} />
    <details><summary>Техническая диагностика</summary>{current.diagnostics_expired ? <p>Срок хранения диагностики истёк.</p> : <>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 300, overflow: "auto" }}>{JSON.stringify(current.diagnostics, null, 2)}</pre>
      {current.has_screenshot && <Screenshot taskId={taskId} />}
    </>}</details>
    <section><h3>Внутренние заметки</h3>{current.notes.map(note => <article key={note.note_id}><time dateTime={note.created_at}>{displayDate(note.created_at)}</time><MarkdownContent body={note.body} /></article>)}
      <ActionForm resetOnSuccess fields={[{ name: "body", label: "Внутренняя заметка", type: "textarea", required: true }]} submitLabel="Добавить внутреннюю заметку" onSubmit={async values => { await perform(() => supportApi.note(taskId, text(values, "body"))); }} />
    </section>
  </QueryState></Card>;
}
