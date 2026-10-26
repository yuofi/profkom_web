import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { Attachments, AttachmentPicker } from "../../components/Workspace/Attachments";
import { AssessmentPanel, TaskInputsPanel, BulkHoursPanel } from "../../components/Workspace/AssessmentPanel";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { Empty, Glyph, QueryState } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { text } from "../../components/Workspace/formValues";
import { tasksApi } from "../../utils/api/tasks.api";
import { richText, type Assignment, type Comment, type FileRef, type Task } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getBlockRoute, getSubeventRoute, getSeasonRoute, getTaskRoute, getContactRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { statusNames, taskStatus } from "./trackerStatus";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerTaskDetail.module.css";

export function TrackerTaskPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const query = useQuery({ queryKey: ["tasks", id], queryFn: () => tasksApi.get(id) });
  return <section className={s.page}>
    {!query.data && <h1 className={s.loadingTitle}>Задача</h1>}
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => { void query.refetch(); }}>
      {query.data && <TaskContent key={id} task={query.data} assignmentId={params.get("assignment_id")} returnSeason={params.get("return_season")} />}
    </QueryState>
  </section>;
}
function TaskContent({ task, assignmentId, returnSeason }: { task: Task; assignmentId: string | null; returnSeason: string | null }) {
  const [editor, setEditor] = useState<"description" | "files" | null>(null);
  const [copied, setCopied] = useState("");
  const [accounting, setAccounting] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(() => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 901px)").matches);
  const accountingRef = useRef<HTMLDetailsElement>(null);
  const taskInputs = useQuery({ queryKey: ["assessments", "task", task.task_id], queryFn: () => tasksApi.inputs(task.task_id), enabled: can(task, "view_assessment_inputs") });
  const datesEditable = can(task, "view_assessment_inputs") && can(taskInputs.data, "edit_assessment_inputs") && can(taskInputs.data, "edit_assessment_dates");
  const editDeadline = () => {
    setAccounting(true);
    window.setTimeout(() => {
      const input = accountingRef.current?.querySelector<HTMLInputElement>('input[name="deadline"]');
      if (!input) return;
      let parent = input.parentElement;
      while (parent && parent !== accountingRef.current?.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      input.focus();input.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }, 0);
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 60000);return () => window.clearInterval(interval); }, []);
  const assignees = task.assignees ?? task.assignments.map(assignment => assignment.assignee);
  const reviewNotes = [...new Set(task.assignments.map(assignment => assignment.review_note?.trim()).filter((note): note is string => !!note))];
  const scopeRoute = task.scope.kind === "block" ? getBlockRoute(task.scope.id) : getSubeventRoute(task.scope.id);
  const hasAccounting = task.assignments.some(item => can(item, "view_assessment_inputs")) || can(task, "view_assessment_inputs");
  return <>
    <header className={s.header}>
      <div className={s.breadcrumbs} aria-label="Путь задачи"><Link to="/tasks">Задачи</Link><span>›</span><Link to={scopeRoute}>{task.scope_title ?? "Команда задачи"}</Link><span>›</span><span>{task.task_key ?? "Задача"}</span></div>
      <div className={s.titleRow}><h1>{task.title}</h1><div className={s.headerTools}>
        <button type="button" className={s.iconButton} aria-label="Скопировать ссылку на задачу" title="Скопировать ссылку" onClick={async () => {
          try { await navigator.clipboard.writeText(new URL(getTaskRoute(task.task_id), window.location.origin).href);setCopied("Ссылка скопирована"); }
          catch { setCopied("Не удалось скопировать ссылку"); }
        }}><Glyph name="share" /></button>
        <DeferredButton icon="workspace_premium" label="Добавить в избранное" />
      </div></div>
      <div className={s.metadata}><span className={s.taskKey}>{task.task_key ?? "Задача"}</span><span>Создана: {task.created_at ? displayDate(task.created_at) : "дата не указана"}</span><span>Обновлена: {task.updated_at ? displayDate(task.updated_at) : "дата не зафиксирована"}</span></div>
      {copied && <p className={w.muted} role="status">{copied}</p>}
      {returnSeason && <Link className={s.backLink} to={getSeasonRoute(returnSeason)}>← К закрытию сезона</Link>}
      <TaskStatusMenu task={task} variant="actions" />
    </header>
    <div className={s.workspace}>
      <div className={s.main}>
        {reviewNotes.length > 0 && <section className={s.reviewNote} aria-label="Комментарий руководителя"><h2>Комментарий руководителя</h2>{reviewNotes.map(note => <MarkdownContent key={note} body={note} />)}</section>}
        {task.legacy_mixed_statuses && <p className={w.warning}>У этой задачи сохранены разные исторические результаты исполнителей. Они остаются в учёте; общий статус не заменяет прежние решения.</p>}
        <section className={s.description} aria-label="Описание задачи">
          <div className={s.sectionHeading}><h2>Описание</h2>{can(task, "edit_task") && <button type="button" className={s.subtleButton} onClick={() => setEditor("description")}><Glyph name="edit" />Редактировать</button>}</div>
          {task.description.body ? <MarkdownContent body={task.description.body} /> : <p className={w.muted}>Описание пока не добавлено.</p>}
          <div className={s.inlineActions}>{can(task, "attach_task_file") && <button type="button" className={s.subtleButton} onClick={() => setEditor("files")}><Glyph name="attach_file" />Прикрепить файлы</button>}
            <DeferredButton icon="add" label="Связь с задачей" /><DeferredButton icon="fact_check" label="Чеклист" /></div>
          {(task.attachments?.length ?? 0) > 0 && <div className={s.descriptionFiles}><Attachments files={task.attachments ?? []} /></div>}
        </section>
        <section className={s.related} aria-label="Связанные задачи"><div className={s.sectionHeading}><h2>Связанные задачи</h2><DeferredButton icon="add" label="Добавить связь" /></div><div className={s.relatedRow}><span>Родительская задача</span><span className={s.planned}>Запланировано</span></div><div className={s.relatedRow}><span>Связи с другими задачами</span><span className={s.planned}>Запланировано</span></div></section>
        <TaskActivity task={task} />
        {assignmentId && !task.assignments.some(item => item.assignment_id === assignmentId) && <Empty>Назначение больше недоступно.</Empty>}
        {(hasAccounting || assignmentId) && <details ref={accountingRef} className={s.accounting} open={accounting || !!assignmentId} onToggle={event => setAccounting(event.currentTarget.open)}>
          <summary>Учёт работы и ККР</summary><div className={s.accountingBody}>
            <TaskInputsPanel task={task} /><BulkHoursPanel task={task} />
            {task.assignments.map(assignment => <AssignmentAccounting key={assignment.assignment_id} assignment={assignment} focused={assignment.assignment_id === assignmentId} />)}
          </div>
        </details>}
      </div>
      <aside className={s.sidebar} aria-label="Параметры задачи"><details className={s.parameters} open={parametersOpen} onToggle={event => setParametersOpen(event.currentTarget.open)}><summary>Параметры</summary><dl>
        <div><dt>Статус</dt><dd><TaskStatusMenu task={task} /></dd></div>
        <div><dt>Тип</dt><dd><DeferredValue label="Тип задачи" /></dd></div>
        <div><dt>Приоритет</dt><dd><DeferredValue label="Приоритет задачи" /></dd></div>
        <div><dt>Дедлайн, МСК</dt><dd><time dateTime={task.deadline_at} className={new Date(task.deadline_at).getTime() < now && !["accepted", "not_completed", "cancelled"].includes(taskStatus(task)) ? s.overdue : undefined}>{displayDate(task.deadline_at)}</time>{datesEditable && <button type="button" className={s.deadlineEdit} onClick={editDeadline}>Изменить дедлайн</button>}</dd></div>
        <div><dt>Команда</dt><dd><Link to={scopeRoute}>{task.scope_title ?? "Открыть команду"}</Link></dd></div>
        <div><dt>Сезон</dt><dd><Link to={getSeasonRoute(task.season_id)}>Открыть сезон</Link></dd></div>
        <div><dt>Цели</dt><dd><DeferredValue label="Цели задачи" /></dd></div>
        <div><dt>Автор</dt><dd>{task.created_by ? <PersonChip user={task.created_by} /> : <span className={w.muted}>Не указан</span>}</dd></div>
        <div><dt>Исполнители</dt><dd className={s.people}>{assignees.length ? assignees.map((person, index) => {
          const assignment = task.assignments.find(item => item.assignee.user_id === person.user_id);
          return <div key={person.user_id ?? `anonymous-${index}`}><PersonChip user={person} />{assignment?.assignee_unavailable_reason && <small className={s.unavailable}>{assignment.assignee_unavailable_reason === "archived" ? "В архиве" : "Вышел из команды"}</small>}</div>;
        }) : <span className={w.muted}>Не назначены</span>}</dd></div>
        <div><dt>Наблюдатели</dt><dd><DeferredValue label="Наблюдатели задачи" /></dd></div>
      </dl></details></aside>
    </div>
    {editor && (editor === "description" ? can(task, "edit_task") : can(task, "attach_task_file")) && <UnsavedChangesScope>{editor === "description" ? <DescriptionEditor task={task} onClose={() => setEditor(null)} /> : <TaskFilesEditor task={task} onClose={() => setEditor(null)} />}</UnsavedChangesScope>}
  </>;
}
function PersonChip({ user }: { user: { user_id: number | null; display_name: string } }) {
  return user.user_id === null ? <span className={s.personChip}><Glyph name="person" />{user.display_name}</span> : <Link className={s.personChip} to={getContactRoute(user.user_id)}><Glyph name="person" />{user.display_name}</Link>;
}
function DeferredButton({ label, icon }: { label: string; icon: "add" | "fact_check" | "workspace_premium" }) {
  return <span className={s.deferred} title={`${label}: запланировано для следующего этапа`}><button type="button" className={s.subtleButton} disabled aria-label={`${label} — запланировано`}><Glyph name={icon} />{label}</button></span>;
}
function DeferredValue({ label }: { label: string }) { return <span className={s.planned} title={`${label}: запланировано для следующего этапа`}>Запланировано</span>; }

function DescriptionEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const [body, setBody] = useState(task.description.body);const [busy, setBusy] = useState(false);const { perform, refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Редактировать задачу" onClose={onClose} busy={busy}><ActionForm fields={[{ name: "title", label: "Название задачи", value: task.title, required: true }]} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh}
    externalState={body} savedExternalState={task.description.body} onReplaceWithSaved={() => setBody(task.description.body)}
    savedDetails={<div><p>Сохранённое название: {task.title}</p><MarkdownContent body={task.description.body} /></div>} submitLabel="Сохранить описание"
    onSubmit={async (values, expectedRevision) => { setBusy(true);try { const saved = await perform(() => tasksApi.update(task.task_id, { expected_revision: expectedRevision!, title: text(values, "title"), description: richText(body) }));return saved; } finally { setBusy(false); } }}>
      <MarkdownEditor value={body} onChange={setBody} label="Описание задачи в Markdown" name="body" rows={12} context="task" />
    </ActionForm></TrackerTaskDialog>;
}
function TaskFilesEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const [files, setFiles] = useState<FileRef[]>(task.attachments ?? []), [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false);const { perform, refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Файлы к постановке задачи" onClose={onClose} busy={busy || uploading}><p className={w.muted}>Эти файлы доступны читателям задачи после сохранения. Результат работы сдаётся отдельно.</p>
    <ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh} externalState={files} savedExternalState={task.attachments ?? []} externalBusy={uploading}
      onReplaceWithSaved={() => setFiles(task.attachments ?? [])} savedDetails={<div><p>Сохранённые вложения задачи:</p><Attachments files={task.attachments ?? []} /></div>} submitLabel="Сохранить вложения"
      onSubmit={async (_values, expectedRevision) => { setBusy(true);try { const saved = await perform(() => tasksApi.update(task.task_id, { expected_revision: expectedRevision!, file_ids: files.map(file => file.file_id) }));return saved; } finally { setBusy(false); } }}>
      <AttachmentPicker owner_kind="task" owner_id={task.task_id} purpose="attachment" files={files} onChange={setFiles} onBusyChange={setUploading} />
    </ActionForm>
  </TrackerTaskDialog>;
}
type ActivityTab = "comments" | "attachments" | "history";
function TaskActivity({ task }: { task: Task }) { return <UnsavedChangesScope><TaskActivityContent task={task} /></UnsavedChangesScope>; }
function TaskActivityContent({ task }: { task: Task }) {
  const [tab, setTab] = useState<ActivityTab>("comments"), [order, setOrder] = useState<"newest" | "oldest">("newest");
  return <section className={s.activity} aria-label="Обсуждение и история задачи">
    <div className={s.activityHeader}><div className={s.tabs} role="tablist" aria-label="Сведения о задаче" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].click();buttons[index].focus();
    }}>{([["comments", "Комментарии"], ["attachments", "Вложения"], ["history", "История"]] as const).map(([key, label]) => <button type="button" key={key} role="tab" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} id={`task-tab-${key}`} aria-controls={`task-panel-${key}`} onClick={() => setTab(key)}>{label}</button>)}</div>
      <label className={s.sort}><Glyph name="filter_list" /><span className={s.srOnly}>Порядок записей</span><select aria-label="Порядок записей" value={order} onChange={event => setOrder(event.target.value as "newest" | "oldest")}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option></select></label>
    </div>
    <div className={s.tabPanel} role="tabpanel" id="task-panel-comments" aria-labelledby="task-tab-comments" hidden={tab !== "comments"}><TaskComments task={task} order={order} /></div>
    {tab === "attachments" && <div className={s.tabPanel} role="tabpanel" id="task-panel-attachments" aria-labelledby="task-tab-attachments"><TaskAttachments task={task} order={order} /></div>}
    {tab === "history" && <div className={s.tabPanel} role="tabpanel" id="task-panel-history" aria-labelledby="task-tab-history"><TaskHistory task={task} order={order} /></div>}
  </section>;
}
function TaskComments({ task, order }: { task: Task; order: "newest" | "oldest" }) {
  const query = useQuery({ queryKey: ["tasks", task.task_id, "comments"], queryFn: () => tasksApi.comments(task.task_id) });
  const comments = [...(query.data?.items ?? [])].sort((a, b) => (order === "newest" ? -1 : 1) * (a.created_at.localeCompare(b.created_at) || a.comment_id.localeCompare(b.comment_id)));
  return <div className={s.commentStack}>
    {can(task, "comment_task") && <CommentComposer task={task} />}
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data}>
      {comments.map(comment => <CommentItem key={comment.comment_id} task={task} comment={comment} />)}
      {!comments.length && <Empty>Пока нет комментариев. Здесь можно обсудить задачу.</Empty>}
    </QueryState>
  </div>;
}
function CommentComposer({ task, comment, onSaved }: { task: Task; comment?: Comment; onSaved?: () => void }) {
  const [body, setBody] = useState(comment?.content.body ?? "");const { perform } = useWorkspaceActions();
  return <ActionForm fields={[]} externalState={body} savedExternalState={comment?.content.body ?? ""} allowExitSave={false} resetOnSuccess={!comment} submitLabel={comment ? "Сохранить комментарий" : "Добавить комментарий"}
    onSubmit={async () => { if (!body.trim()) throw Error("Напишите текст комментария");await perform(() => comment ? tasksApi.editComment(comment.comment_id, richText(body)) : tasksApi.comment(task.task_id, richText(body)));if (!comment) setBody("");onSaved?.(); }}>
    <MarkdownEditor value={body} onChange={setBody} label={comment ? "Редактирование комментария" : "Новый комментарий"} name="body" rows={7} context="comment" draft={false} />
  </ActionForm>;
}
function CommentItem({ task, comment }: { task: Task; comment: Comment }) {
  return <UnsavedChangesScope><CommentItemContent task={task} comment={comment} /></UnsavedChangesScope>;
}
function CommentItemContent({ task, comment }: { task: Task; comment: Comment }) {
  const [editing, setEditing] = useState(false);const leave = useGuardedAction();
  return <article className={s.comment}>
    <header><PersonChip user={comment.author} /><time dateTime={comment.created_at}>{displayDate(comment.created_at)}{comment.updated_at ? " · изменён" : ""}</time>{can(comment, "edit_comment") && <button type="button" className={s.subtleButton} onClick={() => { if (editing) leave(() => setEditing(false));else setEditing(true); }}>{editing ? "Отменить редактирование" : "Редактировать"}</button>}</header>
    {editing && can(comment, "edit_comment") ? <CommentComposer task={task} comment={comment} onSaved={() => setEditing(false)} /> : <MarkdownContent body={comment.content.body} />}
  </article>;
}
function sharedSubmissions(task: Task) {
  if (task.submissions) return task.submissions;
  return task.assignments.flatMap(assignment => assignment.submissions.map(submission => ({ ...submission, submitted_by: assignment.assignee }))).filter((value, index, values) => values.findIndex(other => other.submission_id === value.submission_id) === index);
}
function TaskAttachments({ task, order }: { task: Task; order: "newest" | "oldest" }) {
  const instructionFiles = order === "newest" ? [...(task.attachments ?? [])].reverse() : task.attachments ?? [];
  const submissions = [...sharedSubmissions(task)].sort((a, b) => (order === "newest" ? -1 : 1) * a.submitted_at.localeCompare(b.submitted_at));
  return <div className={s.attachmentSections}><section><h3>Файлы к постановке задачи</h3>{instructionFiles.length ? <Attachments files={instructionFiles} /> : <Empty>К задаче пока не прикреплены файлы.</Empty>}</section>
    <section><h3>Результаты работы</h3>{!submissions.length && <Empty>Результат пока не отправлен.</Empty>}{submissions.map((submission, index) => <article className={s.submission} key={submission.submission_id}><header><strong>Сдача {order === "newest" ? submissions.length - index : index + 1}</strong><time dateTime={submission.submitted_at}>{displayDate(submission.submitted_at)}</time>{submission.submitted_by ? <PersonChip user={submission.submitted_by} /> : <span className={w.muted}>Автор не указан</span>}</header><MarkdownContent body={submission.text.body} />{submission.links.length > 0 && <ul>{submission.links.map(link => <li key={link}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>)}</ul>}<Attachments files={submission.files} /></article>)}</section>
  </div>;
}
function TaskHistory({ task, order }: { task: Task; order: "newest" | "oldest" }) {
  const query = useQuery({ queryKey: ["tasks", task.task_id, "history"], queryFn: () => tasksApi.history(task.task_id) });
  const items = [...(query.data?.items ?? [])].sort((a, b) => (order === "newest" ? -1 : 1) * (a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id)));
  return <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data}><ol className={s.history}>{items.map(item => <li key={item.event_id}><div className={s.historyMarker}><Glyph name="sync" /></div><div><p>{item.actor && <PersonChip user={item.actor} />}<time dateTime={item.created_at}>{displayDate(item.created_at)}</time></p><p>{item.description}</p>{item.to_status && <span className={w.muted}>{item.from_status ? `${statusNames[item.from_status]} → ` : ""}{statusNames[item.to_status]}</span>}</div></li>)}</ol>{!items.length && <Empty>История появится по мере работы над задачей.</Empty>}</QueryState>;
}
function AssignmentAccounting({ assignment, focused }: { assignment: Assignment; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused) { ref.current?.focus();ref.current?.scrollIntoView?.({ block: "center" }); } }, [focused]);
  if (!can(assignment, "view_assessment_inputs") && !focused) return null;
  return <div ref={ref} tabIndex={-1} className={focused ? w.focusedAssignment : s.accountingPerson} aria-label={`Назначение: ${assignment.assignee.display_name}`}>
    <h3>{assignment.assignee.display_name}</h3>{focused && <p role="status">Назначение из препятствий закрытию сезона</p>}<AssessmentPanel assignment={assignment} open={focused} />
  </div>;
}
