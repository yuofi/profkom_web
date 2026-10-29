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
    SeasonORM, _user_to_ref_dc,
)
from errors import Forbidden, NotFound
from models import ScopeRef


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
    def status(self): return self.meta.status
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
        return self._scope_titles.get((item.row.scope_kind, item.row.scope_id),
                                     item.queue["name"] if item.queue else "Команда")

    def project(self, item):
        from database import _task_orm_to_dc
        if not db.can_read_task(self.uid, item.row, self.session):
            raise NotFound("Task not found")
        return _task_orm_to_dc(self.session, item.row, self.uid)
