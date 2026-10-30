"""Lightweight, request-local task selection before expensive public DTO hydration.

The index contains public workflow/roster facts only. Queue and support visibility
is still decided by task_queues, and selected task DTOs use the existing converter.
No assessment inputs, submissions, comments or link trees are needed for selection.
"""
from collections import defaultdict
from dataclasses import dataclass
import json

from sqlalchemy.orm import Load, selectinload

from database import (
    db, TaskORM, TaskTrackerORM, TaskQueueORM, TaskRosterORM, AssignmentORM,
    AuditLogORM, TaskFavoriteORM, UserORM, ContactInfoORM, BlockORM, SubeventORM,
    SeasonORM, EventORM, SubmissionORM, TaskSubmissionORM, FileRecordORM, _user_to_ref_dc,
)
from errors import Forbidden, NotFound
from models import ScopeRef
from read_context import prime_rows


@dataclass
class TaskEntry:
    row: TaskORM
    meta: TaskTrackerORM
    queue: dict | None
    assignee_ids: tuple[int, ...]
    watcher_ids: tuple[int, ...]
    is_favorite: bool

    @property
    def task_id(self): return self.row.task_id
    @property
    def season_id(self): return self.row.season_id
    @property
    def scope(self): return ScopeRef(kind=self.row.scope_kind, id=self.row.scope_id)
    @property
    def title(self): return self.row.title
    @property
    def deadline_at(self): return self.row.deadline_at
    @property
    def status(self):
        from tracker_status import public_status
        return public_status(self.meta.status)
    @property
    def task_type(self): return self.meta.task_type or "task"
    @property
    def priority(self): return self.meta.priority or "normal"
    @property
    def starts_at(self): return self.meta.starts_at
    @property
    def created_at(self): return self.row.created_at
    @property
    def updated_at(self): return self.meta.public_updated_at
    @property
    def task_key(self):
        return (self.queue["key"] + "-" + str(self.meta.queue_number)
                if self.queue and self.meta.queue_number else "TASK-" + str(self.meta.task_number))
    @property
    def legacy_task_key(self): return self.meta.legacy_task_key


class TaskIndex:
    """One short-lived index bound to the caller's current database session."""

    def __init__(self, session, uid, *, season_id=None, scope_kind=None, scope_id=None):
        self.session, self.uid = session, uid
        if scope_kind and scope_id and scope_kind != "queue":
            from access import all_queue_reader
            if not db.can_view_scope(uid, scope_kind, scope_id) and not all_queue_reader(uid):
                from task_queues import readable_tasks
                candidates=session.query(TaskORM).filter_by(scope_kind=scope_kind,scope_id=scope_id).all()
                if not readable_tasks(session,candidates,uid):
                    raise Forbidden("Forbidden: cannot view tasks for this scope")
        query = session.query(TaskORM, TaskTrackerORM).outerjoin(
            TaskTrackerORM, TaskTrackerORM.task_id == TaskORM.task_id
        ).options(Load(TaskORM).load_only(
            TaskORM.task_id, TaskORM.season_id, TaskORM.scope_kind, TaskORM.scope_id,
            TaskORM.title, TaskORM.deadline_at, TaskORM.created_at, TaskORM.created_by_user_id,
            TaskORM.revision,
        ))
        for field, value in ((TaskORM.season_id, season_id), (TaskORM.scope_kind, scope_kind),
                             (TaskORM.scope_id, scope_id)):
            if value:
                query = query.filter(field == value)
        pairs = query.order_by(TaskORM.created_at.desc()).all()
        from tracker import metadata
        visible_legacy = []
        for task, meta in pairs:
            if meta is None:
                # Missing legacy metadata must never create/rebind a public queue
                # before the existing task ACL has admitted this reader.
                if not db.can_read_task(uid, task, session):
                    continue
                meta = metadata(session, task)
            visible_legacy.append((task, meta))
        pairs = visible_legacy
        # Compatibility for deliberately incomplete legacy imports. Normal startup
        # initializes these records; preserve the old read-repair/numbering path.
        if any(meta.task_number is None for _, meta in pairs):
            session.flush()
        self.rows = {task.task_id: task for task, _ in pairs}
        self.metas = {task.task_id: meta for task, meta in pairs}
        ids = list(self.rows)
        self.queues = {queue.queue_id: queue for queue in session.query(TaskQueueORM).filter(
            TaskQueueORM.queue_id.in_({meta.queue_id for _, meta in pairs if meta.queue_id})
        )} if pairs else {}
        roster = defaultdict(list)
        if ids:
            for row in session.query(TaskRosterORM).filter(TaskRosterORM.task_id.in_(ids)):
                if row not in session.deleted:
                    roster[row.task_id].append(row)
            for row in session.new:
                if isinstance(row, TaskRosterORM) and row.task_id in self.rows and row not in roster[row.task_id]:
                    roster[row.task_id].append(row)
        assignments = defaultdict(list)
        if ids:
            for row in session.query(AssignmentORM.assignment_id, AssignmentORM.task_id,
                                     AssignmentORM.assignee_user_id).filter(AssignmentORM.task_id.in_(ids)):
                assignments[row.task_id].append(row)
            for row in session.new:
                if isinstance(row, AssignmentORM) and row.task_id in self.rows:
                    value = (row.assignment_id, row.task_id, row.assignee_user_id)
                    if value not in assignments[row.task_id]:
                        assignments[row.task_id].append(value)
        legacy_ids = {a[0] for task, meta in pairs if not meta.roster_initialized for a in assignments[task.task_id]}
        assignment_tasks = {a[0]: task_id for task_id, rows in assignments.items() for a in rows}
        superseded = set()
        if legacy_ids:
            logs = list(session.query(AuditLogORM).filter(AuditLogORM.target_kind == "assignment",
                                                        AuditLogORM.target_id.in_(legacy_ids)))
            logs += [row for row in session.new if isinstance(row, AuditLogORM)
                     and row.target_kind == "assignment" and row.target_id in legacy_ids]
            for row in logs:
                replacement = json.loads(row.new_values_json or "{}").get("new_assignment_id")
                if replacement in legacy_ids and assignment_tasks[replacement] == assignment_tasks[row.target_id]:
                    superseded.add(row.target_id)
        people = {a[2] for rows in assignments.values() for a in rows}
        people.update(member.user_id for rows in roster.values() for member in rows)
        self.users = {user.user_id: user for user in session.query(UserORM).options(
            selectinload(UserORM.contact).load_only(ContactInfoORM.surname, ContactInfoORM.name,
                                                  ContactInfoORM.patronymic, ContactInfoORM.kkr_name)
        ).filter(UserORM.user_id.in_(people))} if people else {}
        def public_ids(values):
            return tuple(value for value in values if value in self.users
                         and self.users[value].account_state != "purged")
        favorites = {row.task_id for row in session.query(TaskFavoriteORM).filter(
            TaskFavoriteORM.user_id == uid, TaskFavoriteORM.task_id.in_(ids))} if ids and uid else set()
        self.entries = []
        from task_queues import queue_ref
        for task, meta in pairs:
            current = {member.assignment_id for member in roster[task.task_id]
                       if member.role == "assignee" and member.assignment_id}
            assignees = [a[2] for a in assignments[task.task_id]
                         if a[0] in current] if meta.roster_initialized else [
                             a[2] for a in assignments[task.task_id] if a[0] not in superseded]
            queue = self.queues.get(meta.queue_id)
            self.entries.append(TaskEntry(task, meta, queue_ref(queue) if queue else None,
                public_ids(assignees), public_ids(member.user_id for member in roster[task.task_id]
                                                if member.role == "watcher"), task.task_id in favorites))
        self.seasons = {row.season_id: row.state for row in session.query(SeasonORM).filter(
            SeasonORM.season_id.in_({task.season_id for task, _ in pairs if task.season_id}))} if pairs else {}
        self._scope_titles = None
        self._refs = {}
        self._roster = roster

    def readable(self, entries=None):
        from task_queues import readable_tasks
        candidates = self.entries if entries is None else entries
        readable = {task.task_id for task in readable_tasks(self.session, [item.row for item in candidates], self.uid)}
        return [item for item in candidates if item.task_id in readable]

    def live(self, item):
        return item.season_id is None or (item.season_id in self.seasons and self.seasons[item.season_id] != "closed")

    def user_ref(self, uid):
        if uid not in self._refs:
            self._refs[uid] = _user_to_ref_dc(self.users.get(uid))
        return self._refs[uid]

    def scope_title(self, item):
        if self._scope_titles is None:
            names = {entry.row.scope_id for entry in self.entries if entry.row.scope_kind == "block"}
            subs = {entry.row.scope_id for entry in self.entries if entry.row.scope_kind == "subevent"}
            self._scope_titles = {("block", row.name): row.name for row in self.session.query(BlockORM).filter(BlockORM.name.in_(names))}
            self._scope_titles.update({("subevent", row.subevent_id): row.title for row in
                                      self.session.query(SubeventORM).filter(SubeventORM.subevent_id.in_(subs))})
            events={entry.row.scope_id for entry in self.entries if entry.row.scope_kind=="event"}
            self._scope_titles.update({("event",row.event_id):row.title for row in self.session.query(EventORM).filter(EventORM.event_id.in_(events))})
            self._scope_titles[("chair","chair")]="Работа председателя"
        return self._scope_titles.get((item.row.scope_kind, item.row.scope_id),
                                     item.queue["name"] if item.queue else "Команда")

    def project(self, item):
        from database import _task_orm_to_dc
        if not db.can_read_task(self.uid, item.row, self.session):
            raise NotFound("Task not found")
        return _task_orm_to_dc(self.session, item.row, self.uid)

    def prepare(self, entries):
        """Prepare full DTO relations only for the selected page, in bounded reads.

        Priming is a no-op outside a clean readonly UOW. The ordinary converters
        remain authoritative; a command/repair permanently discards these hints.
        No linked task is made visible by preloading its metadata.
        """
        from read_context import _context
        context = _context(self.session)
        values = list(entries)
        if not values or context is None or not context.usable():
            return
        session = self.session
        ids = list(dict.fromkeys(item.task_id for item in values))
        def by_ids(model, column, identifiers, *order):
            rows = []
            for offset in range(0, len(identifiers), 500):
                query = session.query(model).filter(column.in_(identifiers[offset:offset+500]))
                rows.extend(query.order_by(*order).all() if order else query.all())
            return rows
        def prime_tracker(model, task_id, rows):
            prime_rows(session, "tracker.rows", (model, (("task_id", task_id),)), rows)
        # The index deliberately deferred descriptions during selection. Fetch
        # all selected fields once rather than one deferred SELECT per row.
        by_ids(TaskORM, TaskORM.task_id, ids)
        for task_id, meta in self.metas.items():
            prime_tracker(TaskTrackerORM, task_id, [meta])
        assignments = defaultdict(list)
        for row in by_ids(AssignmentORM, AssignmentORM.task_id, ids):
            assignments[row.task_id].append(row)
        for task_id in ids:
            prime_tracker(AssignmentORM, task_id, assignments[task_id])
            # A global IN can scan physical row order, while the original
            # single-task query may use its composite (task,user) PK index.
            # Preserve the original public roster order for multi-row tasks.
            if len(self._roster[task_id]) <= 1:
                prime_tracker(TaskRosterORM, task_id, self._roster[task_id])
        # AssignmentPublic exposes whether each assignee still has task access.
        # Apply the same batch policy to their actual selected assignments, rather
        # than repeating ownership/queue/scope queries for every personal row.
        from task_queues import readable_tasks
        assigned_tasks = defaultdict(dict)
        for task_id, rows in assignments.items():
            for row in rows:
                assigned_tasks[row.assignee_user_id][task_id] = self.rows[task_id]
        for user_id, tasks in assigned_tasks.items():
            readable_tasks(session, list(tasks.values()), user_id)
        assignment_ids = [row.assignment_id for rows in assignments.values() for row in rows]
        legacy = by_ids(SubmissionORM, SubmissionORM.assignment_id, assignment_ids, SubmissionORM.submitted_at)
        by_assignment = defaultdict(list)
        for row in legacy:
            by_assignment[row.assignment_id].append(row)
        for aid in assignment_ids:
            prime_rows(session, "assignment.submissions", aid, by_assignment[aid])
        shared = defaultdict(list)
        for row in by_ids(TaskSubmissionORM, TaskSubmissionORM.task_id, ids, TaskSubmissionORM.submitted_at):
            shared[row.task_id].append(row)
        from tracker import participants
        for task_id in ids:
            prime_rows(session, "task.submissions", task_id, shared[task_id])
            current = [row.assignment_id for row in participants(session, task_id)]
            current_set = set(current)
            fallback = [row for row in legacy if row.assignment_id in current_set]
            # The old combined fallback orders across all current assignments.
            # Concatenating multiple IN chunks would not preserve timestamp ties
            # across chunks, so retain the exact original query for large sets.
            # SQLite's unspecified tie order may differ between a page-wide IN
            # and the original task-local IN. Keep that exact query for ties.
            if (len(current) <= 1 and len(assignment_ids) <= 500
                    and len({row.submitted_at for row in fallback}) == len(fallback)):
                prime_rows(session, "task.legacy_submissions", tuple(current),
                           fallback)
        def prefetch_file_ids(raw):
            # This is only a fetch hint. The legacy assignment converter tolerates
            # malformed JSON; authoritative projections retain their own exact
            # validation/fallback rules and must not fail earlier in preparation.
            try:
                values = json.loads(raw or "[]")
            except (ValueError, TypeError):
                return ()
            return tuple(value for value in values if isinstance(value, str)) if isinstance(values, (list, dict, str)) else ()
        file_ids = {fid for row in legacy for fid in prefetch_file_ids(row.files_json)}
        file_ids.update(fid for rows in shared.values() for row in rows for fid in prefetch_file_ids(row.files_json))
        file_ids.update(fid for task_id in ids for fid in prefetch_file_ids(self.metas[task_id].files_json))
        by_ids(FileRecordORM, FileRecordORM.file_id, list(file_ids))
        from tracker_stage2 import prepare_relations
        prepare_relations(session, ids, self.uid)
