import { TaskClassificationMenu } from "./TaskClassificationMenu";
import { TrackerFavoriteButton } from "./TrackerFavoriteButton";
import { TaskPlanningEditor } from "./TrackerTaskPlanning";
import { TrackerTaskChecklist } from "./TrackerTaskChecklist";
import { TrackerTaskRelations } from "./TrackerTaskRelations";
import { TeamChip } from "../../components/Workspace/TeamChip";
import { TrackerHomeLink } from "../../components/Workspace/TrackerHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { Attachments, AttachmentPicker } from "../../components/Workspace/Attachments";
import { UnifiedKkrEditor } from "../../components/Workspace/UnifiedKkrEditor";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { taskCollaborationApi } from "../../utils/api/taskCollaboration.api";
import { TaskMentionPicker, TaskMentionApprovals } from "./TrackerTaskMentions";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { Empty, Glyph, QueryState } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { text } from "../../components/Workspace/formValues";
import { tasksApi } from "../../utils/api/tasks.api";
import { TaskSeasonParameter } from "./TaskSeasonParameter";
import { userMessage } from "../../utils/api/messages";
import { recordOwnChange, useOwnRevisions } from "../../components/Workspace/ownRevisions";
import { richText, type Comment, type FileRef, type Task } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getSeasonRoute, getTaskRoute, getTaskQueueRoute, getTaskQueuesRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { taskStatus } from "./trackerStatus";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { TrackerParentSelector } from "./TrackerParentSelector";
import { UserChip as PersonChip } from "../../components/Workspace/UserChip";
import { useSession } from "../../utils/session";
import { HistoryPanel } from "../../components/Workspace/HistoryPanel";
import { SupportTaskPanel } from "../../components/Workspace/SupportTaskPanel";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerTaskDetail.module.css";

export function TrackerTaskPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const query = useQuery({ queryKey: ["tasks", id], queryFn: () => tasksApi.get(id) });
  return <section className={s.page}>
    {!query.data && <h1 className={s.loadingTitle}>Задача</h1>}
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => { void query.refetch(); }}>
      {query.data && <TaskContent key={id} task={query.data} assignmentId={params.get("assignment_id")} accountingRequested={params.get("kkr")==="1"} returnSeason={params.get("return_season")} />}
    </QueryState>
  </section>;
}
function TaskContent({ task, assignmentId, accountingRequested=false, returnSeason }: { task: Task; assignmentId: string | null; accountingRequested?:boolean; returnSeason: string | null }) {
  const [editor, setEditor] = useState<"description" | "files" | "parent" | "planning" | null>(null);
  const [copied, setCopied] = useState("");
  const [kkrOpen,setKkrOpen]=useState(!!assignmentId||accountingRequested);
  const [checklistBusy, setChecklistBusy] = useState(false), [checklistError, setChecklistError] = useState("");
  const checklistSaving = useRef(false);
  const { perform, refresh } = useWorkspaceActions();const own = useOwnRevisions();
  const descriptionEditable = can(task, "edit_task_description") || can(task, "edit_task");
  const updateChecklist = async (body: string) => {
    if (checklistSaving.current || !can(task,"toggle_task_checklist") || editor === "description") return;
    checklistSaving.current = true;setChecklistBusy(true);setChecklistError("");
    try {
      await perform(async () => {
        const saved = await tasksApi.descriptionChecklist(task.task_id, { expected_revision: task.revision, body });
        recordOwnChange(own, `task:${task.task_id}`, task.revision, saved.revision);
        own.setQueryData(["tasks", task.task_id], saved);return saved;
      });
    } catch (failure) { setChecklistError(userMessage(failure));await refresh(); }
    finally { checklistSaving.current = false;setChecklistBusy(false); }
  };
  const [parametersOpen, setParametersOpen] = useState(() => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 901px)").matches);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 60000);return () => window.clearInterval(interval); }, []);
  const reviewNotes = [...new Set(task.assignments.map(assignment => assignment.review_note?.trim()).filter((note): note is string => !!note))];
  const hasAccounting = taskStatus(task)==="closed" && can(task,"view_assessment_inputs");
  return <>
    <BrandedHeader className={s.header}>
      <TrackerHomeLink className={s.brandLabel} />
      <nav className={s.breadcrumbs} aria-label="Путь задачи"><Link to={task.queue ? getTaskQueueRoute(task.queue.queue_id) : getTaskQueuesRoute()}>{task.queue?.name ?? "Очереди"}</Link><span aria-hidden="true">›</span>{task.parent_task && <><Link to={getTaskRoute(task.parent_task.task_id)}>{task.parent_task.title}</Link><span aria-hidden="true">›</span></>}<span aria-current="page">{task.task_key ?? "Задача"}</span></nav>
      <div className={s.titleRow}><h1 className={w.title}>{task.title}</h1><div className={s.headerTools}>
        <button type="button" className={s.iconButton} aria-label="Скопировать ссылку на задачу" title="Скопировать ссылку" onClick={async () => {
          try { await navigator.clipboard.writeText(new URL(getTaskRoute(task.task_id), window.location.origin).href);setCopied("Ссылка скопирована"); }
          catch { setCopied("Не удалось скопировать ссылку"); }
        }}><Glyph name="share" /></button>
        <TrackerFavoriteButton task={task} onBrand compact />
      </div></div>
      <div className={s.metadata}><span className={s.taskKey}>{task.task_key ?? "Задача"}</span><span>Создана: {task.created_at ? displayDate(task.created_at) : "дата не указана"}</span><span>Обновлена: {task.updated_at ? displayDate(task.updated_at) : "дата не зафиксирована"}</span></div>
      {copied && <p className={`${w.muted} ${s.headerNotice}`} role="status">{copied}</p>}
      {returnSeason && <Link className={s.backLink} to={getSeasonRoute(returnSeason)}>← К закрытию сезона</Link>}
      <TaskStatusMenu task={task} variant="actions" onClosed={()=>setKkrOpen(true)} />
    </BrandedHeader>
    <div className={s.workspace}>
      <div className={s.main}>
        {reviewNotes.length > 0 && <section className={s.reviewNote} aria-label="Комментарий руководителя"><h2>Комментарий руководителя</h2>{reviewNotes.map(note => <MarkdownContent key={note} body={note} />)}</section>}
        {task.legacy_mixed_statuses && <p className={w.warning}>У этой задачи сохранены разные исторические результаты исполнителей. Они остаются в учёте; общий статус не заменяет прежние решения.</p>}
        <section className={s.description} aria-label="Описание задачи">
          <div className={s.sectionHeading}><h2>Описание</h2>{descriptionEditable && <button type="button" className={s.subtleButton} onClick={() => setEditor("description")}><Glyph name="edit" />Редактировать</button>}</div>
          {task.description.body ? <MarkdownContent body={task.description.body} onChecklistChange={can(task,"toggle_task_checklist") ? body => { void updateChecklist(body); } : undefined} checklistDisabled={checklistBusy || editor === "description"} /> : <p className={w.muted}>Описание пока не добавлено.</p>}
          {checklistBusy && <p role="status" className={w.muted}>Сохраняем отметку…</p>}{checklistError && <p role="alert" className={w.error}>{checklistError} <button type="button" className={s.subtleButton} onClick={() => { void refresh(); }}>Обновить описание</button></p>}
          <div className={s.inlineActions}>{can(task, "attach_task_file") && <button type="button" className={s.subtleButton} onClick={() => setEditor("files")}><Glyph name="attach_file" />Прикрепить файлы</button>}
            <button type="button" className={s.subtleButton} onClick={() => document.getElementById("task-relations")?.scrollIntoView?.({block:"start",behavior:"smooth"})}><Glyph name="add" />Связь с задачей</button></div>
          {(task.attachments?.length ?? 0) > 0 && <div className={s.descriptionFiles}><Attachments files={task.attachments ?? []} /></div>}
        </section>
        <TrackerTaskChecklist task={task} />
        <TrackerTaskRelations task={task} onEditParent={() => setEditor("parent")} />
        {assignmentId && !task.assignments.some(item => item.assignment_id === assignmentId) && <Empty>Назначение больше недоступно.</Empty>}
        {hasAccounting && <section className={s.accounting} aria-label="Учёт работы и ККР"><div className={s.sectionHeading}><h2>Учёт работы и ККР</h2><button type="button" onClick={()=>setKkrOpen(true)}>Оценить работу</button></div></section>}
        <TaskMentionApprovals task={task} />
        <TaskActivity task={task} />
        {task.queue?.key === "WEBSUPPORT" && <SupportTaskPanel task={task} />}
      </div>
      <aside className={s.sidebar} aria-label="Параметры задачи"><details className={s.parameters} open={parametersOpen} onToggle={event => setParametersOpen(event.currentTarget.open)}><summary>Параметры</summary><dl>
        <div><dt>Статус</dt><dd><TaskStatusMenu task={task} onClosed={()=>setKkrOpen(true)} /></dd></div>
        <div><dt>Тип</dt><dd><TaskClassificationMenu task={task} field="task_type" />{can(task,"edit_task_metadata") && <button type="button" className={s.deadlineEdit} onClick={() => setEditor("planning")}>Изменить параметры</button>}</dd></div>
        <div><dt>Приоритет</dt><dd><TaskClassificationMenu task={task} field="priority" /></dd></div>
        {task.task_type !== "milestone" && <div><dt>Плановое начало, МСК</dt><dd>{displayDate(task.starts_at)}</dd></div>}
        <div><dt>Дедлайн, МСК</dt><dd>{task.deadline_at ? <time dateTime={task.deadline_at} className={Date.parse(task.deadline_at) < now && taskStatus(task)!=="closed" ? s.overdue : undefined}>{displayDate(task.deadline_at)}</time> : <span>Не задан</span>}</dd></div>
        <div><dt>Очередь</dt><dd>{task.queue ? <Link to={getTaskQueueRoute(task.queue.queue_id)}>{task.queue.name}</Link> : <Link to={getTaskQueuesRoute()}>Открыть очереди</Link>}</dd></div>
        {task.scope.kind !== "queue" && <div><dt>Команда</dt><dd><TeamChip scope={task.scope} title={task.scope_title} avatarUrl={task.scope_avatar_url} /></dd></div>}
        <TaskSeasonParameter task={task} />
        <div><dt>Автор</dt><dd>{task.created_by ? <PersonChip user={task.created_by} /> : <span className={w.muted}>Не указан</span>}</dd></div>
        <TaskPeopleParameters task={task} />
      </dl></details></aside>
    </div>
    {kkrOpen && hasAccounting && <UnsavedChangesScope><TrackerTaskDialog title="Учёт работы и ККР" onClose={()=>setKkrOpen(false)}><UnifiedKkrEditor task={task} onClose={()=>setKkrOpen(false)} /></TrackerTaskDialog></UnsavedChangesScope>}
    {editor && (editor === "description" ? descriptionEditable : editor === "parent" ? can(task, "edit_task") : editor === "planning" ? can(task,"edit_task_metadata") : can(task, "attach_task_file")) && <UnsavedChangesScope>{editor === "description" ? <DescriptionEditor task={task} onClose={() => setEditor(null)} /> : editor === "parent" ? <ParentTaskEditor task={task} onClose={() => setEditor(null)} /> : editor === "planning" ? <TaskPlanningEditor task={task} onClose={() => setEditor(null)} /> : <TaskFilesEditor task={task} onClose={() => setEditor(null)} />}</UnsavedChangesScope>}
  </>;
}

function DescriptionEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const [body, setBody] = useState(task.description.body);const [busy, setBusy] = useState(false);const { perform, refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Редактировать задачу" onClose={onClose} busy={busy}><ActionForm fields={can(task, "edit_task") ? [{ name: "title", label: "Название задачи", value: task.title, required: true }] : []} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh}
    externalState={body} savedExternalState={task.description.body} onReplaceWithSaved={() => setBody(task.description.body)}
    savedDetails={<div><p>Сохранённое название: {task.title}</p><MarkdownContent body={task.description.body} /></div>} submitLabel="Сохранить описание"
    onSubmit={async (values, expectedRevision) => { setBusy(true);try { const saved = await perform(() => tasksApi.update(task.task_id, { expected_revision: expectedRevision!, ...(can(task, "edit_task") ? { title: text(values, "title") } : {}), description: richText(body) }));return saved; } finally { setBusy(false); } }}>
      <MarkdownEditor value={body} onChange={setBody} label="Описание задачи в Markdown" name="body" rows={12} context="task" disabled={busy} />
    </ActionForm></TrackerTaskDialog>;
}
function ParentTaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const [parentId, setParentId] = useState(task.parent_task?.task_id ?? ""), [busy, setBusy] = useState(false);
  const { perform, refresh } = useWorkspaceActions();
  return <TrackerTaskDialog title="Родительская задача" onClose={onClose} busy={busy}>
    <p className={w.muted}>Можно выбрать доступную задачу из любой очереди этого сезона.</p>
    <ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh} externalState={parentId} savedExternalState={task.parent_task?.task_id ?? ""}
      onReplaceWithSaved={() => setParentId(task.parent_task?.task_id ?? "")} savedDetails={<p>Сохранённая родительская задача: {task.parent_task ? `${task.parent_task.task_key} · ${task.parent_task.title}` : task.parent_task_unavailable ? "Недоступна" : "Не выбрана"}</p>} submitLabel="Сохранить родительскую задачу"
      onSubmit={async (_values, expectedRevision) => { setBusy(true);try { return await perform(() => tasksApi.update(task.task_id, { expected_revision: expectedRevision!, parent_task_id: parentId || null })); } finally { setBusy(false); } }}>
      <TrackerParentSelector value={parentId} onChange={setParentId} seasonId={task.season_id} taskId={task.task_id} initialParent={task.parent_task} disabled={busy} />
    </ActionForm>
  </TrackerTaskDialog>;
}
function TaskPeopleParameters({ task }: { task: Task }) {
  const { session } = useSession(), { perform, refresh } = useWorkspaceActions(), own = useOwnRevisions();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const assignees = task.assignees ?? task.assignments.map(assignment => assignment.assignee), watchers = task.watchers ?? [];
  const selfAssigned = assignees.some(user => user.user_id === session?.user_id), selfWatching = watchers.some(user => user.user_id === session?.user_id);
  const act = async (command: () => Promise<Task>) => {
    if (busy) return;setBusy(true);setError("");
    try { await perform(async () => { const saved = await command();recordOwnChange(own, `task:${task.task_id}`, task.revision, saved.revision);own.setQueryData(["tasks", task.task_id], saved);return saved; }); }
    catch (failure) { setError(userMessage(failure));await refresh(); } finally { setBusy(false); }
  };
  const [assignOpen,setAssignOpen]=useState(false);
  const candidates=useQuery({queryKey:["taskMentionCandidates",task.task_id],queryFn:()=>taskCollaborationApi.candidates(task.task_id),enabled:assignOpen&&can(task,"assign_task_participants")});
  const revision = { expected_revision: task.revision };
  return <>
    <div><dt>Исполнители</dt><dd className={s.people}>{assignees.length ? assignees.map((person, index) => {
      const assignment = task.assignments.find(item => item.assignee.user_id === person.user_id);
      return <div key={person.user_id ?? `anonymous-${index}`} className={s.rosterPerson}><PersonChip user={person} />{person.user_id !== null && can(task, "remove_task_assignee") && <button type="button" className={s.removePerson} disabled={busy} title="Перевести в наблюдатели" aria-label={`Убрать исполнителя: ${person.display_name}`} onClick={() => { void act(() => tasksApi.removeAssignee(task.task_id, person.user_id!, revision)); }}>×</button>}{assignment?.assignee_unavailable_reason && <small className={s.unavailable}>{assignment.assignee_unavailable_reason === "archived" ? "В архиве" : "Вышел из команды"}</small>}</div>;
    }) : <span className={w.muted}>Не назначены</span>}{!selfAssigned && can(task, "join_task") && <button type="button" className={s.subtleButton} disabled={busy} onClick={() => { void act(() => tasksApi.join(task.task_id, revision)); }}>Стать исполнителем</button>}{can(task,"assign_task_participants")&&<><button type="button" className={s.subtleButton} disabled={busy} onClick={()=>setAssignOpen(!assignOpen)}>Добавить исполнителя</button>{assignOpen&&<EntityPicker label="Новый исполнитель" entity="person" value="" options={(candidates.data?.items??[]).flatMap(user=>user.user_id===null||assignees.some(person=>person.user_id===user.user_id)?[]:[{value:String(user.user_id),label:user.display_name,user}])} loading={candidates.isLoading} disabled={busy} onChange={id=>{if(id)void act(()=>tasksApi.assign(task.task_id,Number(id),revision));}}/>}</>}</dd></div>
    <div><dt>Наблюдатели</dt><dd className={s.people}>{watchers.length ? watchers.map((person, index) => <div className={s.rosterPerson} key={person.user_id ?? `anonymous-${index}`}><PersonChip user={person}/>{person.user_id!==null&&can(task,"remove_task_watcher")&&<button type="button" className={s.removePerson} disabled={busy} aria-label={`Убрать наблюдателя: ${person.display_name}`} onClick={()=>void act(()=>tasksApi.removeWatcher(task.task_id,person.user_id!,revision))}>×</button>}</div>) : <span className={w.muted}>Нет наблюдателей</span>}{selfWatching && can(task, "unwatch_task") ? <button type="button" className={s.subtleButton} disabled={busy} onClick={() => { void act(() => tasksApi.unwatch(task.task_id, revision)); }}>Перестать наблюдать</button> : !selfAssigned && can(task, "watch_task") && <button type="button" className={s.subtleButton} disabled={busy} onClick={() => { void act(() => tasksApi.watch(task.task_id, revision)); }}>Наблюдать</button>}{error && <p role="alert" className={w.error}>{error}</p>}</dd></div>
  </>;
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
  const [body, setBody] = useState(comment?.content.body ?? "");const [mentions,setMentions]=useState<number[]>([]);const { perform } = useWorkspaceActions();
  return <ActionForm fields={[]} externalState={{body,mentions}} savedExternalState={{body:comment?.content.body ?? "",mentions:[]}} allowExitSave={false} resetOnSuccess={!comment} submitLabel={comment ? "Сохранить комментарий" : "Добавить комментарий"}
    onSubmit={async () => { if (!body.trim()) throw Error("Напишите текст комментария");await perform(() => comment ? tasksApi.editComment(comment.comment_id, richText(body), mentions) : tasksApi.comment(task.task_id, richText(body), mentions));if (!comment) {setBody("");setMentions([]);}onSaved?.(); }}>
    <TaskMentionPicker taskId={task.task_id} value={mentions} onChange={setMentions} onMentionText={value=>setBody(body=>body+(body&&!body.endsWith(" ")?" ":"")+value+" ")} />
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
  return <HistoryPanel kind="task" id={task.task_id} order={order} />;
}
