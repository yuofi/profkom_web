import { TaskClassificationMenu } from "./TaskClassificationMenu";
import { TrackerFavoriteButton } from "./TrackerFavoriteButton";
import { TaskPlanningEditor } from "./TrackerTaskPlanning";
import { TrackerTaskChecklist } from "./TrackerTaskChecklist";
import { TrackerTaskRelations } from "./TrackerTaskRelations";
import { TeamChip } from "../../components/Workspace/TeamChip";
import { TrackerHomeLink } from "../../components/Workspace/TrackerHomeLink";
import { BrandedHeader } from "../../components/Workspace/BrandedHeader";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { Attachments, AttachmentPicker } from "../../components/Workspace/Attachments";
import { UnifiedKkrEditor } from "../../components/Workspace/UnifiedKkrEditor";
import { TaskAccountingSection } from "./TaskAccountingSection";
import { AnchoredPopover } from "../../components/Workspace/AnchoredPopover";
import { EntityPicker } from "../../components/Workspace/EntityPicker";
import { taskCollaborationApi } from "../../utils/api/taskCollaboration.api";
import { TaskMentionPicker, TaskMentionApprovals } from "./TrackerTaskMentions";
import { newCommentMentionDraft, changeCommentMentionBody, addCommentMention, keepCommentMentions, commentMentionUsers } from "./commentMentionDraft";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { Empty, Glyph, QueryState } from "../../components/Workspace/WorkspaceUI";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { text } from "../../components/Workspace/formValues";
import { tasksApi } from "../../utils/api/tasks.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { TaskSeasonParameter } from "./TaskSeasonParameter";
import { TaskDeadlineParameter, TaskDeadlineValue } from "./TaskDeadlineParameter";
import { userMessage } from "../../utils/api/messages";
import { richText, type Comment, type FileRef, type Page, type Revision, type Task } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { displayDate } from "../../utils/dates";
import { getSeasonRoute, getTaskRoute, getTaskQueueRoute, getTaskQueuesRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { requestKey, type RequestKey } from "../../utils/clientId";
import { markDescription, useDialogHold, useTaskCommand, useTaskFormCommand } from "./taskCommands";
import { TaskStatusMenu } from "./TaskStatusMenu";
import { TrackerCommentMenu, type CommentMenuAction } from "./TrackerCommentMenu";
import { taskStatus } from "./trackerStatus";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import { TrackerParentSelector } from "./TrackerParentSelector";
import { UserChip as PersonChip } from "../../components/Workspace/UserChip";
import { useSession } from "../../utils/session";
import { copyText } from "../../utils/clipboard";
import { HistoryPanel } from "../../components/Workspace/HistoryPanel";
import { SupportTaskPanel } from "../../components/Workspace/SupportTaskPanel";
import w from "../../components/Workspace/Workspace.module.css";
import s from "./TrackerTaskDetail.module.css";

/** A task opened from a season names the place it returns to; only known season sections are accepted. */
function seasonReturn(params: URLSearchParams) {
  const season = params.get("return_season"), source = params.get("return_to"), participant = params.get("participant");
  if (!season) return null;
  if (source === "checks") return { to: `${getSeasonRoute(season)}?panel=checks`, label: "← К проверкам сезона" };
  if (source === "participant" && participant) return { to: `${getSeasonRoute(season)}?participant=${encodeURIComponent(participant)}`, label: "← К участнику" };
  return { to: getSeasonRoute(season), label: "← К сезону" };
}
export function TrackerTaskPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const query = useQuery({ queryKey: ["tasks", id], queryFn: () => tasksApi.get(id) });
  // Comments and seasons need only the address: start them with the task, under the keys
  // the activity and season parameter read, instead of one round trip later.
  useQuery({ queryKey: ["tasks", id, "comments"], queryFn: () => tasksApi.comments(id), enabled: !!id });
  useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  return <section className={s.page}>
    {!query.data && <h1 className={s.loadingTitle}>Задача</h1>}
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!query.data} retry={() => { void query.refetch(); }}>
      {query.data && <TaskContent key={id} task={query.data} assignmentId={params.get("assignment_id")} accountingRequested={params.get("kkr")==="1"} back={seasonReturn(params)} />}
    </QueryState>
  </section>;
}
function TaskContent({ task, assignmentId, accountingRequested=false, back }: { task: Task; assignmentId: string | null; accountingRequested?:boolean; back: { to: string; label: string } | null }) {
  const [editor, setEditor] = useState<"description" | "files" | "parent" | "planning" | null>(null);
  // An editor whose save is queued stays open after an earlier answer drops its capability (TR-01 review).
  const editorHold = useDialogHold(), closeEditor = () => { setEditor(null);editorHold.release(); };
  const [copied, setCopied] = useState(""), [manualLink, setManualLink] = useState(""), [linking, setLinking] = useState(false), [saved, setSaved] = useState("");
  const [kkrOpen,setKkrOpen]=useState(!!assignmentId||accountingRequested);
  const [checklistPending, setChecklistPending] = useState<readonly number[]>([]), [checklistError, setChecklistError] = useState("");
  const checklistSaving = useRef(new Set<number>()), run = useTaskCommand(task);
  const { refresh } = useWorkspaceActions();
  const descriptionEditable = can(task, "edit_task_description") || can(task, "edit_task");
  const toggleDescription = async (offset: number, checked: boolean) => {
    if (checklistSaving.current.has(offset) || !can(task,"toggle_task_checklist") || editor === "description") return;
    checklistSaving.current.add(offset);setChecklistPending([...checklistSaving.current]);setChecklistError("");
    try { await run(expected => tasksApi.descriptionChecklist(task.task_id, { expected_revision: expected, offset, checked }), current => markDescription(current, offset, checked)); }
    catch (failure) { setChecklistError(userMessage(failure)); }
    finally { checklistSaving.current.delete(offset);setChecklistPending([...checklistSaving.current]); }
  };
  const [parametersOpen, setParametersOpen] = useState(() => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 901px)").matches);
  // «+N» of the phone summary opens the parameters and hands its focus to «Параметры»: the summary goes away.
  const parametersSummary = useRef<HTMLElement>(null), focusParameters = useRef(false);
  useEffect(() => { if (parametersOpen && focusParameters.current) { focusParameters.current = false;parametersSummary.current?.focus(); } }, [parametersOpen]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 60000);return () => window.clearInterval(interval); }, []);
  const reviewNotes = [...new Set(task.assignments.map(assignment => assignment.review_note?.trim()).filter((note): note is string => !!note))];
  const hasAccounting = taskStatus(task)==="closed" && can(task,"view_assessment_inputs");
  const savedEditor = () => { setCopied("");setSaved("Изменения сохранены"); };
  return <>
    <BrandedHeader className={s.header}>
      <TrackerHomeLink className={s.brandLabel} />
      <nav className={s.breadcrumbs} aria-label="Путь задачи">{task.queue?.readable === false ? task.queue.key === "WEBSUPPORT" ? <Link to="/support">Мои обращения</Link> : <span>{task.queue.name}</span> : <Link to={task.queue ? getTaskQueueRoute(task.queue.queue_id) : getTaskQueuesRoute()}>{task.queue?.name ?? "Очереди"}</Link>}<span aria-hidden="true">›</span>{task.parent_task && <><Link to={getTaskRoute(task.parent_task.task_id)}>{task.parent_task.title}</Link><span aria-hidden="true">›</span></>}<span aria-current="page">{task.task_key ?? "Задача"}</span></nav>
      <div className={s.titleRow}><h1 className={w.title}>{task.title}</h1><div className={s.headerTools}>
        <button type="button" className={s.iconButton} aria-label="Скопировать ссылку на задачу" title="Скопировать ссылку" onClick={async () => {
          const link = new URL(getTaskRoute(task.task_id), window.location.origin).href;
          setSaved("");if (await copyText(link)) { setManualLink("");setCopied("Ссылка скопирована"); } else { setCopied("");setManualLink(link); }
        }}><Glyph name="share" /></button>
        <TrackerFavoriteButton task={task} onBrand compact />
      </div></div>
      <div className={s.metadata}><span className={s.taskKey}>{task.task_key ?? "Задача"}</span><span>Создана: {task.created_at ? displayDate(task.created_at) : "дата не указана"}</span><span>Обновлена: {task.updated_at ? displayDate(task.updated_at) : "дата не зафиксирована"}</span></div>
      {(copied || saved) && <p className={`${w.muted} ${s.headerNotice}`} role="status">{copied || saved}</p>}
      {manualLink && <label className={s.manualLink}>Скопируйте ссылку вручную<input readOnly value={manualLink} autoFocus onFocus={event => event.currentTarget.select()} onKeyDown={event => { if (event.key === "Escape") setManualLink(""); }} /></label>}
      {back && <Link className={s.backLink} to={back.to}>{back.label}</Link>}
    </BrandedHeader>
    <div className={s.workspace}>
      <div className={s.main}>
        {reviewNotes.length > 0 && <section className={s.reviewNote} aria-label="Комментарий руководителя"><h2>Комментарий руководителя</h2>{reviewNotes.map(note => <MarkdownContent key={note} body={note} />)}</section>}
        {task.legacy_mixed_statuses && <p className={w.warning}>У этой задачи сохранены разные исторические результаты исполнителей. Они остаются в учёте; общий статус не заменяет прежние решения.</p>}
        <section className={s.description} aria-label="Описание задачи">
          <div className={s.sectionHeading}><div className={s.headingTitle}><h2>Описание</h2><span role="status" className={s.savingNote}>{checklistPending.length ? "Сохраняем отметку…" : ""}</span></div>{descriptionEditable && <button type="button" className={s.subtleButton} disabled={!!checklistPending.length} onClick={() => setEditor("description")}><Glyph name="edit" />Редактировать</button>}</div>
          {task.description.body ? <MarkdownContent body={task.description.body} onChecklistToggle={can(task,"toggle_task_checklist") ? (offset, checked) => { void toggleDescription(offset, checked); } : undefined} checklistDisabled={editor === "description"} checklistPending={checklistPending} /> : <p className={w.muted}>Описание пока не добавлено.</p>}
          {checklistError && <p role="alert" className={w.error}>{checklistError} <button type="button" className={s.subtleButton} onClick={() => { void refresh(); }}>Обновить описание</button></p>}
          <div className={s.inlineActions}>{can(task, "attach_task_file") && <button type="button" className={s.subtleButton} onClick={() => setEditor("files")}><Glyph name="attach_file" />Прикрепить файлы</button>}
            {(can(task, "manage_task_links") || can(task, "edit_task")) && <button type="button" className={s.subtleButton} onClick={() => setLinking(true)}><Glyph name="add" />Связь с задачей</button>}</div>
          {(task.attachments?.length ?? 0) > 0 && <div className={s.descriptionFiles}><Attachments files={task.attachments ?? []} /></div>}
        </section>
        <TrackerTaskChecklist task={task} />
        <TrackerTaskRelations task={task} onEditParent={() => setEditor("parent")} editing={linking} onEditingChange={setLinking} />
        {assignmentId && !task.assignments.some(item => item.assignment_id === assignmentId) && <Empty>Назначение больше недоступно.</Empty>}
        {assignmentId && !hasAccounting && task.assignments.some(item => item.assignment_id === assignmentId) && <p role="status" className={s.accountingNotice}>{taskStatus(task) === "closed" ? "Учёт работы по этой задаче вам недоступен." : "Оценка исполнителя станет доступна после закрытия задачи."}</p>}
        {hasAccounting && <TaskAccountingSection task={task} onOpen={()=>setKkrOpen(true)} />}
        <TaskMentionApprovals task={task} />
        <TaskActivity task={task} />
        {task.queue?.key === "WEBSUPPORT" && <SupportTaskPanel task={task} />}
      </div>
      <aside className={s.sidebar} aria-label="Параметры задачи">
        {!parametersOpen && <TaskSummary task={task} now={now} onClosed={()=>setKkrOpen(true)} onShowPeople={() => { focusParameters.current = true;setParametersOpen(true); }} />}
        <details className={s.parameters} open={parametersOpen} onToggle={event => setParametersOpen(event.currentTarget.open)}><summary ref={parametersSummary}>Параметры</summary>{can(task,"edit_task_metadata") && <button type="button" className={`${s.iconButton} ${s.parametersEdit}`} aria-label="Изменить параметры" title="Изменить параметры" onClick={() => setEditor("planning")}><Glyph name="edit" /></button>}<div className={s.groups}>
          <ParameterGroup title="Статус и сроки">
            <div className={s.chipRow} role="group" aria-label="Статус, тип и приоритет"><TaskStatusMenu task={task} onClosed={()=>setKkrOpen(true)} /><TaskClassificationMenu task={task} field="task_type" /><TaskClassificationMenu task={task} field="priority" /></div>
            <dl>
              {task.task_type !== "milestone" && <div><dt>Начало, МСК</dt><dd>{displayDate(task.starts_at)}</dd></div>}
              <TaskDeadlineParameter task={task} now={now} onSaved={savedEditor} />
            </dl>
          </ParameterGroup>
          <ParameterGroup title="Где"><dl>
            <div><dt>Очередь</dt><dd>{task.queue?.readable === false ? <span className={s.queueText}>{task.queue.name}{task.queue.key === "WEBSUPPORT" && <Link to="/support">Мои обращения</Link>}</span> : task.queue ? <Link to={getTaskQueueRoute(task.queue.queue_id)}>{task.queue.name}</Link> : <Link to={getTaskQueuesRoute()}>Открыть очереди</Link>}</dd></div>
            {task.scope.kind !== "queue" && <div className={s.chipPair}><dt>Команда</dt><dd><TeamChip scope={task.scope} title={task.scope_title} avatarUrl={task.scope_avatar_url} /></dd></div>}
            <TaskSeasonParameter task={task} />
          </dl></ParameterGroup>
          <ParameterGroup title="Люди"><TaskPeopleParameters task={task} /></ParameterGroup>
        </div></details>
      </aside>
    </div>
    {kkrOpen && hasAccounting && <UnsavedChangesScope><TrackerTaskDialog title="Учёт работы и ККР" onClose={()=>setKkrOpen(false)}><UnifiedKkrEditor task={task} onClose={()=>setKkrOpen(false)} /></TrackerTaskDialog></UnsavedChangesScope>}
    {editor && (editorHold.held || (editor === "description" ? descriptionEditable : editor === "parent" ? can(task, "edit_task") : editor === "planning" ? can(task,"edit_task_metadata") : can(task, "attach_task_file"))) && <UnsavedChangesScope>{editor === "description" ? <DescriptionEditor task={task} onClose={closeEditor} onSend={editorHold.hold} onSaved={savedEditor} /> : editor === "parent" ? <ParentTaskEditor task={task} onClose={closeEditor} onSend={editorHold.hold} onSaved={savedEditor} /> : editor === "planning" ? <TaskPlanningEditor task={task} onClose={closeEditor} onSend={editorHold.hold} onSaved={savedEditor} /> : <TaskFilesEditor task={task} onClose={closeEditor} onSend={editorHold.hold} onSaved={savedEditor} />}</UnsavedChangesScope>}
  </>;
}

function DescriptionEditor({ task, onClose, onSend, onSaved }: { task: Task; onClose: () => void; onSend?: () => void; onSaved?: () => void }) {
  const [body, setBody] = useState(task.description.body);const [busy, setBusy] = useState(false);const { refresh } = useWorkspaceActions();const save = useTaskFormCommand(task.task_id, onSend);
  // The save waits in the card's command queue (TR-01): right after a checkmark it sends the
  // next own revision; a foreign change still answers 409 here and keeps the draft. A title
  // once sent stays in the form even if an earlier answer then took edit_task away.
  const [titleSent, setTitleSent] = useState(false), titled = can(task, "edit_task") || titleSent;
  return <TrackerTaskDialog title="Редактировать задачу" onClose={onClose} busy={busy}><ActionForm fields={titled ? [{ name: "title", label: "Название задачи", value: task.title, required: true }] : []} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh}
    externalState={body} savedExternalState={task.description.body} onReplaceWithSaved={() => setBody(task.description.body)}
    savedDetails={<div><p>Сохранённое название: {task.title}</p><MarkdownContent body={task.description.body} /></div>} submitLabel="Сохранить описание"
    onSubmit={async (values, expectedRevision) => { setBusy(true);setTitleSent(titled);try { const saved = await save(expectedRevision!, expected => tasksApi.update(task.task_id, { expected_revision: expected, ...(titled ? { title: text(values, "title") } : {}), description: richText(body) }));onSaved?.();onClose();return saved; } finally { setBusy(false); } }}>
      <MarkdownEditor value={body} onChange={setBody} label="Описание задачи в Markdown" name="body" rows={12} context="task" disabled={busy} />
    </ActionForm></TrackerTaskDialog>;
}
function ParentTaskEditor({ task, onClose, onSend, onSaved }: { task: Task; onClose: () => void; onSend?: () => void; onSaved?: () => void }) {
  const [parentId, setParentId] = useState(task.parent_task?.task_id ?? ""), [busy, setBusy] = useState(false);
  const { refresh } = useWorkspaceActions(), save = useTaskFormCommand(task.task_id, onSend);
  return <TrackerTaskDialog title="Родительская задача" onClose={onClose} busy={busy}>
    <p className={w.muted}>Можно выбрать доступную задачу из любой очереди этого сезона.</p>
    <ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh} externalState={parentId} savedExternalState={task.parent_task?.task_id ?? ""}
      onReplaceWithSaved={() => setParentId(task.parent_task?.task_id ?? "")} savedDetails={<p>Сохранённая родительская задача: {task.parent_task ? `${task.parent_task.task_key} · ${task.parent_task.title}` : task.parent_task_unavailable ? "Недоступна" : "Не выбрана"}</p>} submitLabel="Сохранить родительскую задачу"
      onSubmit={async (_values, expectedRevision) => { setBusy(true);try { const saved = await save(expectedRevision!, expected => tasksApi.update(task.task_id, { expected_revision: expected, parent_task_id: parentId || null }));onSaved?.();onClose();return saved; } finally { setBusy(false); } }}>
      <TrackerParentSelector value={parentId} onChange={setParentId} seasonId={task.season_id} taskId={task.task_id} initialParent={task.parent_task} disabled={busy} />
    </ActionForm>
  </TrackerTaskDialog>;
}
/** One titled group of the parameters panel: status and dates, place, people (D-03). */
function ParameterGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section className={s.group} aria-labelledby={id}><h3 id={id} className={s.groupTitle}>{title}</h3>{children}</section>;
}
const taskAssignees = (task: Task) => task.assignees ?? task.assignments.map(assignment => assignment.assignee);
const SUMMARY_PEOPLE = 3;
/** A phone keeps the status, the deadline and the assignees above the folded parameters (D-03). */
function TaskSummary({ task, now, onClosed, onShowPeople }: { task: Task; now: number; onClosed: () => void; onShowPeople: () => void }) {
  const assignees = taskAssignees(task), hidden = assignees.length - SUMMARY_PEOPLE;
  return <div className={s.summary} role="group" aria-label="Кратко о задаче">
    <TaskStatusMenu task={task} onClosed={onClosed} />
    <span className={s.summaryDeadline}><span>Дедлайн</span><TaskDeadlineValue task={task} now={now} /></span>
    <div className={s.summaryPeople}>{assignees.length ? assignees.slice(0, SUMMARY_PEOPLE).map((person, index) => <PersonChip key={person.user_id ?? `anonymous-${index}`} user={person} />) : <span className={w.muted}>Исполнители не назначены</span>}
      {hidden > 0 && <button type="button" className={`${s.subtleButton} ${s.summaryMore}`} aria-label={`+${hidden}: все исполнители в параметрах`} onClick={onShowPeople}>+{hidden}</button>}</div>
  </div>;
}
function TaskPeopleParameters({ task }: { task: Task }) {
  const { session } = useSession(), run = useTaskCommand(task);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const assignees = taskAssignees(task), watchers = task.watchers ?? [];
  const selfAssigned = assignees.some(user => user.user_id === session?.user_id), selfWatching = watchers.some(user => user.user_id === session?.user_id);
  const act = async (command: (revision: Revision) => Promise<Task>) => {
    if (busy) return;setBusy(true);setError("");
    try { await run(expected => command({ expected_revision: expected })); }
    catch (failure) { setError(userMessage(failure)); } finally { setBusy(false); }
  };
  const [assignOpen,setAssignOpen]=useState(false),assignHint=useId();
  const candidates=useQuery({queryKey:["taskMentionCandidates",task.task_id],queryFn:()=>taskCollaborationApi.candidates(task.task_id),enabled:assignOpen&&can(task,"assign_task_participants")});
  // People who do not read the task yet are shown, but only their access approver may assign them.
  const assignOptions=(candidates.data?.items??[]).flatMap(user=>user.user_id===null||assignees.some(person=>person.user_id===user.user_id)?[]:[{value:String(user.user_id),label:user.display_name,user,disabled:user.can_assign===false}]).sort((a,b)=>Number(a.disabled)-Number(b.disabled));
  const assignLocked=assignOptions.some(option=>option.disabled);
  const joinable = !selfAssigned && can(task, "join_task"), assignable = can(task, "assign_task_participants");
  const unwatchable = selfWatching && can(task, "unwatch_task"), watchable = !unwatchable && !selfAssigned && can(task, "watch_task");
  // A row beginning with a chip puts its label on the chip's centre line.
  return <>
    <dl>
      <div className={task.created_by ? s.chipPair : undefined}><dt>Автор</dt><dd>{task.created_by ? <PersonChip user={task.created_by} /> : <span className={w.muted}>Не указан</span>}</dd></div>
      <div className={assignees.length ? s.chipPair : undefined}><dt>Исполнители</dt><dd className={s.people}>{assignees.length ? assignees.map((person, index) => {
        const assignment = task.assignments.find(item => item.assignee.user_id === person.user_id);
        return <div key={person.user_id ?? `anonymous-${index}`} className={s.rosterPerson}><PersonChip user={person} />{person.user_id !== null && can(task, "remove_task_assignee") && <button type="button" className={s.removePerson} disabled={busy} title="Перевести в наблюдатели" aria-label={`Убрать исполнителя: ${person.display_name}`} onClick={() => { void act(revision => tasksApi.removeAssignee(task.task_id, person.user_id!, revision)); }}>×</button>}{assignment?.assignee_unavailable_reason && <small className={s.unavailable}>{assignment.assignee_unavailable_reason === "archived" ? "В архиве" : "Вышел из команды"}</small>}</div>;
      }) : <span className={w.muted}>Не назначены</span>}</dd></div>
      <div className={watchers.length ? s.chipPair : undefined}><dt>Наблюдатели</dt><dd className={s.people}>{watchers.length ? watchers.map((person, index) => <div className={s.rosterPerson} key={person.user_id ?? `anonymous-${index}`}><PersonChip user={person}/>{person.user_id!==null&&can(task,"remove_task_watcher")&&<button type="button" className={s.removePerson} disabled={busy} aria-label={`Убрать наблюдателя: ${person.display_name}`} onClick={()=>void act(revision=>tasksApi.removeWatcher(task.task_id,person.user_id!,revision))}>×</button>}</div>) : <span className={w.muted}>Нет наблюдателей</span>}</dd></div>
    </dl>
    {(joinable || assignable || unwatchable || watchable) && <div className={s.peopleActions} role="group" aria-label="Действия с людьми задачи">
      {joinable && <button type="button" className={s.subtleButton} disabled={busy} onClick={() => { void act(revision => tasksApi.join(task.task_id, revision)); }}>Стать исполнителем</button>}
      {assignable && <button type="button" className={s.subtleButton} disabled={busy} aria-expanded={assignOpen} onClick={()=>setAssignOpen(!assignOpen)}>Добавить исполнителя</button>}
      {unwatchable ? <button type="button" className={s.subtleButton} disabled={busy} onClick={() => { void act(revision => tasksApi.unwatch(task.task_id, revision)); }}>Перестать наблюдать</button> : watchable && <button type="button" className={s.subtleButton} disabled={busy} onClick={() => { void act(revision => tasksApi.watch(task.task_id, revision)); }}>Наблюдать</button>}
    </div>}
    {assignable&&assignOpen&&<EntityPicker label="Новый исполнитель" entity="person" value="" options={assignOptions} loading={candidates.isLoading} disabled={busy} describedBy={assignLocked?assignHint:undefined} onChange={id=>{if(id)void act(revision=>tasksApi.assign(task.task_id,Number(id),revision));}}/>}
    {assignable&&assignOpen&&assignLocked&&<small id={assignHint} className={s.pickerHint}>Неактивные пока не видят задачу. Призовите их в комментарии: доступ согласует автор задачи или владелец очереди.</small>}
    {error && <p role="alert" className={w.error}>{error}</p>}
  </>;
}
function TaskFilesEditor({ task, onClose, onSend, onSaved }: { task: Task; onClose: () => void; onSend?: () => void; onSaved?: () => void }) {
  const [files, setFiles] = useState<FileRef[]>(task.attachments ?? []), [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false);const { refresh } = useWorkspaceActions(), save = useTaskFormCommand(task.task_id, onSend);
  return <TrackerTaskDialog title="Файлы к постановке задачи" onClose={onClose} busy={busy || uploading}><p className={w.muted}>Эти файлы доступны читателям задачи после сохранения. Результат работы прикладывайте к комментарию.</p>
    <ActionForm fields={[]} revision={task.revision} record={`task:${task.task_id}`} onConflict={refresh} externalState={files} savedExternalState={task.attachments ?? []} externalBusy={uploading}
      onReplaceWithSaved={() => setFiles(task.attachments ?? [])} savedDetails={<div><p>Сохранённые вложения задачи:</p><Attachments files={task.attachments ?? []} /></div>} submitLabel="Сохранить вложения"
      onSubmit={async (_values, expectedRevision) => { setBusy(true);try { const saved = await save(expectedRevision!, expected => tasksApi.update(task.task_id, { expected_revision: expected, file_ids: files.map(file => file.file_id) }));onSaved?.();onClose();return saved; } finally { setBusy(false); } }}>
      <AttachmentPicker owner_kind="task" owner_id={task.task_id} purpose="attachment" files={files} onChange={setFiles} onBusyChange={setUploading} />
    </ActionForm>
  </TrackerTaskDialog>;
}
type ActivityTab = "comments" | "attachments" | "history";
// The task page starts this read with the task and keeps it fresh (PF-14): the activity joins
// the page's entry instead of asking again when it mounts; changes still invalidate it.
function useTaskComments(task:Task) {return useQuery({queryKey:["tasks",task.task_id,"comments"],queryFn:()=>tasksApi.comments(task.task_id),refetchOnMount:false});}
function TaskActivity({ task }: { task: Task }) { return <UnsavedChangesScope><TaskActivityContent task={task} /></UnsavedChangesScope>; }
function TaskActivityContent({ task }: { task: Task }) {
  const commentsQuery=useTaskComments(task);
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
    <div className={s.tabPanel} role="tabpanel" id="task-panel-comments" aria-labelledby="task-tab-comments" hidden={tab !== "comments"}><TaskComments task={task} order={order} query={commentsQuery} /></div>
    {tab === "attachments" && <div className={s.tabPanel} role="tabpanel" id="task-panel-attachments" aria-labelledby="task-tab-attachments"><TaskAttachments task={task} order={order} commentsQuery={commentsQuery} onShowComment={id=>{setTab("comments");window.requestAnimationFrame?.(()=>document.getElementById(`task-comment-${id}`)?.scrollIntoView?.({block:"start",behavior:"smooth"}));}} /></div>}
    {tab === "history" && <div className={s.tabPanel} role="tabpanel" id="task-panel-history" aria-labelledby="task-tab-history"><TaskHistory task={task} order={order} /></div>}
  </section>;
}
function TaskComments({ task, order, query }: { task: Task; order: "newest" | "oldest"; query:ReturnType<typeof useTaskComments> }) {
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
  const [draft,setDraft]=useState(()=>newCommentMentionDraft(comment?.content.body??""));const {body}=draft;const mentions=draft.pending.flatMap(item=>item.user.user_id===null?[]:[item.user.user_id]);const mentionedUsers=commentMentionUsers(draft,comment?.mentioned_users);const { perform } = useWorkspaceActions();
  const [files,setFiles]=useState<FileRef[]>(comment?.attachments??[]),[uploading,setUploading]=useState(false),[saving,setSaving]=useState(false),[filesOpen,setFilesOpen]=useState(false);
  const attachmentButton=useRef<HTMLButtonElement>(null),sent=useRef<RequestKey["current"]>(null);
  return <ActionForm fields={[]} externalState={{body,mentions,files}} savedExternalState={{body:comment?.content.body??"",mentions:[],files:comment?.attachments??[]}} externalBusy={uploading} allowExitSave={false} resetOnSuccess={!comment} submitLabel={comment ? "Сохранить комментарий" : "Добавить комментарий"} successMessage={comment?"Комментарий сохранён":"Комментарий добавлен"}
    onSubmit={async () => {
      if(uploading)throw Error("Дождитесь загрузки файлов");if(!body.trim()&&!files.length)throw Error("Напишите комментарий или прикрепите файл");
      setSaving(true);setFilesOpen(false);
      // A new comment repeated after a lost answer is not added twice (GL-07).
      const fileIds=files.map(file=>file.file_id);
      try{await perform(()=>comment?tasksApi.editComment(comment.comment_id,richText(body),mentions,fileIds):tasksApi.comment(task.task_id,richText(body),mentions,fileIds,requestKey(sent,{body,mentions,fileIds})));sent.current=null;if(!comment){setDraft(newCommentMentionDraft());setFiles([]);}onSaved?.();}
      finally{setSaving(false);}
    }}>
    <MarkdownEditor value={body} onChange={value=>setDraft(draft=>changeCommentMentionBody(draft,value))} label={comment ? "Редактирование комментария" : "Новый комментарий"} name="body" rows={7} context="comment" variant="comment" draft={false} placeholder="Добавьте комментарий…" mentionUsers={mentionedUsers} disabled={saving}
      footer={<><button ref={attachmentButton} type="button" className={s.commentAttachment} disabled={uploading||saving} onClick={()=>setFilesOpen(!filesOpen)} aria-label="Прикрепить файлы к комментарию" aria-haspopup="dialog" aria-expanded={filesOpen}><Glyph name="attach_file"/><span>Прикрепить файлы{files.length?` · ${files.length}`:""}</span></button><TaskMentionPicker taskId={task.task_id} value={mentions} readersOnly={task.queue?.key==="WEBSUPPORT"||task.queue?.key==="KKR"} onChange={ids=>setDraft(draft=>keepCommentMentions(draft,ids))} onMentionUser={user=>setDraft(draft=>addCommentMention(draft,user))} /></>}/>
    {files.length>0&&<section className={s.commentDraftFiles} aria-label="Файлы в черновике комментария"><Attachments files={files}/><div className={w.row}>{files.map(file=><button type="button" key={file.file_id} className={s.subtleButton} disabled={uploading||saving} aria-label={`Убрать файл из комментария: ${file.name}`} onClick={()=>setFiles(files=>files.filter(item=>item.file_id!==file.file_id))}>× {file.name}</button>)}</div></section>}
    <AnchoredPopover open={filesOpen} anchorRef={attachmentButton} label="Файлы комментария" onRequestClose={()=>setFilesOpen(false)} busy={uploading||saving} width={440}>
      <p className={w.muted}>Файлы добавятся вместе с комментарием. После загрузки можно закрыть это окно и продолжить писать.</p>
      <AttachmentPicker owner_kind="task" owner_id={task.task_id} purpose="comment" files={files} onChange={setFiles} onBusyChange={setUploading}/>
    </AnchoredPopover>
  </ActionForm>;
}
function CommentItem({ task, comment }: { task: Task; comment: Comment }) {
  return <UnsavedChangesScope><CommentItemContent task={task} comment={comment}/></UnsavedChangesScope>;
}
const commentsKey=(task:Task)=>["tasks",task.task_id,"comments"];
/** Any reader ticks a comment's checklist (V4): one mark at a time per comment, against the
 *  body the reader saw; the answer replaces the comment in the list, a refusal rereads it. */
function useCommentChecklist(task:Task,comment:Comment,onError:(text:string)=>void) {
  const client=useQueryClient(),{perform}=useWorkspaceActions(),saving=useRef<number|null>(null),[pending,setPending]=useState<readonly number[]>([]);
  const toggle=async(offset:number,checked:boolean)=>{
    if(saving.current!==null)return;
    saving.current=offset;setPending([offset]);onError("");
    try{await perform(async()=>{
      const saved=await tasksApi.commentChecklist(comment.comment_id,{expected_body:comment.content.body,offset,checked});
      client.setQueryData<Page<Comment>>(commentsKey(task),data=>data&&{...data,items:data.items.map(item=>item.comment_id===saved.comment_id?saved:item)});
      return saved;
    });}
    catch(failure){onError(userMessage(failure,{checklist_only:"Этот пункт нельзя отметить: обновите комментарии и попробуйте снова."}));void client.invalidateQueries({queryKey:commentsKey(task)});}
    finally{saving.current=null;setPending([]);}
  };
  return {pending,toggle};
}
function CommentItemContent({ task, comment }: { task: Task; comment: Comment }) {
  const [editing,setEditing]=useState(false),[confirming,setConfirming]=useState(false),[deleting,setDeleting]=useState(false),[error,setError]=useState("");
  const leave=useGuardedAction(),client=useQueryClient(),{perform}=useWorkspaceActions(),marks=useCommentChecklist(task,comment,setError);
  const article=useRef<HTMLElement>(null),header=useRef<HTMLElement>(null),confirmButton=useRef<HTMLButtonElement>(null),backToMenu=useRef(false),questionId=useId();
  // The question takes the place of «⋯» (owner 2026-11-08, В5, variant Б): the focus moves into it and,
  // when it is withdrawn, back to «⋯».
  useEffect(()=>{
    if(confirming){confirmButton.current?.focus();return;}
    if(backToMenu.current){backToMenu.current=false;header.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();}
  },[confirming]);
  const cancelDelete=()=>{if(deleting)return;backToMenu.current=true;setConfirming(false);};
  // No placeholder stays (V5): the comment leaves the list, the history names who deleted it.
  const remove=async()=>{
    if(deleting)return;setDeleting(true);setError("");
    try{await perform(async()=>{await tasksApi.deleteComment(comment.comment_id);focusNeighbour(article.current);client.setQueryData<Page<Comment>>(commentsKey(task),data=>data&&{...data,items:data.items.filter(item=>item.comment_id!==comment.comment_id)});});}
    catch(failure){setError(userMessage(failure));setDeleting(false);void client.invalidateQueries({queryKey:commentsKey(task)});}
  };
  const editable=can(comment,"edit_comment"),asking=confirming&&!editing;
  const actions:CommentMenuAction[]=[...(editable?[{label:"Редактировать",icon:"edit" as const,onSelect:()=>{setConfirming(false);setError("");setEditing(true);}}]:[]),...(can(comment,"delete_comment")?[{label:"Удалить",icon:"delete" as const,danger:true,onSelect:()=>{setError("");setConfirming(true);}}]:[])];
  // While a deletion is sent its buttons stay focusable (aria-disabled): a refusal leaves the focus where it was.
  return <article ref={article} tabIndex={-1} className={s.comment} id={`task-comment-${comment.comment_id}`} data-confirming={asking||undefined}>
    <header ref={header}><div className={s.commentMeta}><PersonChip user={comment.author}/><time dateTime={comment.created_at}>{displayDate(comment.created_at)}{comment.updated_at?" · изменён":""}</time>{marks.pending.length>0&&<span role="status" className={s.savingNote}>Сохраняем отметку…</span>}</div>{editing&&editable?<button type="button" className={s.subtleButton} onClick={()=>leave(()=>setEditing(false))}>Отменить редактирование</button>
      :asking?<div role="group" aria-labelledby={questionId} className={s.commentConfirm} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();cancelDelete();}}}><span id={questionId}>Удалить комментарий?</span><button ref={confirmButton} type="button" className={`${s.subtleButton} ${s.confirmDelete}`} aria-disabled={deleting||undefined} aria-busy={deleting||undefined} onClick={()=>{void remove();}}>{deleting?"Удаляем…":"Удалить"}</button><button type="button" className={`${s.subtleButton} ${s.confirmCancel}`} aria-disabled={deleting||undefined} onClick={cancelDelete}>Отмена</button></div>
      :<TrackerCommentMenu actions={actions} disabled={deleting||marks.pending.length>0}/>}</header>
    {editing&&editable?<CommentComposer task={task} comment={comment} onSaved={()=>setEditing(false)}/>:<><MarkdownContent body={comment.content.body} mentionUsers={comment.mentioned_users??[]} onChecklistToggle={can(comment,"toggle_comment_checklist")?(offset,checked)=>{void marks.toggle(offset,checked);}:undefined} checklistDisabled={deleting||asking||marks.pending.length>0} checklistPending={marks.pending}/>{comment.attachments?.length>0&&<section aria-label="Вложения комментария"><Attachments files={comment.attachments}/></section>}</>}
    {error&&<p role="alert" className={w.error}>{error}</p>}
  </article>;
}
/** A deleted comment that held the focus hands it on: to the next comment's «⋯» (or that comment itself),
 *  else to the comment above, else to the «Комментарии» tab. */
function focusNeighbour(article:HTMLElement|null) {
  if(!article?.contains(document.activeElement))return;
  const comments=[...(article.parentElement?.children??[])].filter((item):item is HTMLElement=>item instanceof HTMLElement&&item.tagName==="ARTICLE");
  const index=comments.indexOf(article),next=comments[index+1]??comments[index-1];
  (next?next.querySelector<HTMLElement>(':scope > header [aria-haspopup="menu"]:not(:disabled)')??next:document.getElementById("task-tab-comments"))?.focus();
}
function sharedSubmissions(task: Task) {
  if (task.submissions) return task.submissions;
  return task.assignments.flatMap(assignment => assignment.submissions.map(submission => ({ ...submission, submitted_by: assignment.assignee }))).filter((value, index, values) => values.findIndex(other => other.submission_id === value.submission_id) === index);
}
function TaskAttachments({ task, order, commentsQuery, onShowComment }: { task: Task; order: "newest" | "oldest"; commentsQuery:ReturnType<typeof useTaskComments>; onShowComment:(id:string)=>void }) {
  const instructionFiles = order === "newest" ? [...(task.attachments ?? [])].reverse() : task.attachments ?? [];
  const submissions = [...sharedSubmissions(task)].sort((a, b) => (order === "newest" ? -1 : 1) * a.submitted_at.localeCompare(b.submitted_at));
  const comments=[...(commentsQuery.data?.items??[])].filter(comment=>comment.attachments?.length).sort((a,b)=>(order==="newest"?-1:1)*a.created_at.localeCompare(b.created_at));
  return <div className={s.attachmentSections}><section><h3>Файлы к постановке задачи</h3>{instructionFiles.length ? <Attachments files={instructionFiles} /> : <Empty>К задаче пока не прикреплены файлы.</Empty>}</section>
    {/* Results are written in comments now (owner 2026-11-08, В6): only results sent earlier keep this section. */}
    {submissions.length > 0 && <section><h3>Результаты работы</h3>{submissions.map((submission, index) => <article className={s.submission} key={submission.submission_id}><header><strong>Сдача {order === "newest" ? submissions.length - index : index + 1}</strong><time dateTime={submission.submitted_at}>{displayDate(submission.submitted_at)}</time>{submission.submitted_by ? <PersonChip user={submission.submitted_by} /> : <span className={w.muted}>Автор не указан</span>}</header><MarkdownContent body={submission.text.body} />{submission.links.length > 0 && <ul>{submission.links.map(link => <li key={link}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>)}</ul>}<Attachments files={submission.files} /></article>)}</section>}
    <section aria-label="Файлы из комментариев"><h3>Файлы из комментариев</h3><QueryState loading={commentsQuery.isLoading} error={commentsQuery.error} keepDataOnError={!!commentsQuery.data}>{comments.length?comments.map(comment=><article className={s.submission} key={comment.comment_id}><header><PersonChip user={comment.author}/><time dateTime={comment.created_at}>{displayDate(comment.created_at)}</time><button type="button" className={s.subtleButton} onClick={()=>onShowComment(comment.comment_id)}>К комментарию</button></header><Attachments files={comment.attachments}/></article>):<Empty>В комментариях пока нет файлов.</Empty>}</QueryState></section>
  </div>;
}
function TaskHistory({ task, order }: { task: Task; order: "newest" | "oldest" }) {
  return <HistoryPanel kind="task" id={task.task_id} order={order} />;
}
