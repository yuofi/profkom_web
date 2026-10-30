"""Public planning, checklist, relations and private favorites for the task tracker.

These objects never write Assignment inputs/outcomes or accounting snapshots. A relation
is editable from either readable endpoint by that endpoint's public editor; both public
revisions/history advance together. Personal favorites do not advance either counter.
"""
from datetime import datetime, timezone
import json
import uuid

from sqlalchemy import or_
from database import db, TaskORM, TaskTrackerORM, TaskChecklistORM, TaskLinkORM, TaskFavoriteORM
from errors import Forbidden, InvalidInput, NotFound, Conflict, revision_conflict
from read_context import orm_rows, prime_rows, cached

TYPES = ("task", "milestone", "epic")
PRIORITIES = ("low", "normal", "high", "urgent")
PRIORITY_ORDER = {name: index for index, name in enumerate(PRIORITIES)}
FIELDS = {"task_type", "priority", "starts_at", "checklist"}
LABELS = {"task_type": "Тип задачи", "priority": "Приоритет", "starts_at": "Плановое начало", "checklist": "Чеклист"}


def _time(value):
    from validation import timestamp
    return timestamp(value)


def _moment(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def checklist_rows(session, task_id):
    def load():
        rows = session.query(TaskChecklistORM).filter_by(task_id=task_id).all()
        rows += [row for row in session.new if isinstance(row, TaskChecklistORM) and row.task_id == task_id and row not in rows]
        return rows
    rows = orm_rows(session, "task.checklist", task_id, load)
    return sorted((row for row in rows if row not in session.deleted), key=lambda row: (row.position, row.item_id))


def _checklist_snapshot(rows):
    return [f"- [{'x' if row.checked else ' '}] {row.text}" for row in rows]


def _replace_checklist(session, task, values, initial=False):
    if not isinstance(values, list) or len(values) > 200:
        raise InvalidInput("At most 200 checklist items are allowed")
    existing = {row.item_id: row for row in checklist_rows(session, task.task_id)}
    seen, prepared = set(), []
    for value in values:
        text = value.get("text")
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > 1000:
            raise InvalidInput("Each checklist item must contain 1–1000 characters")
        item_id = value.get("item_id")
        if item_id:
            if initial or item_id not in existing:
                raise InvalidInput("Checklist item does not belong to this task")
            if item_id in seen:
                raise InvalidInput("Duplicate checklist item")
        else:
            item_id = "checkitem-" + str(uuid.uuid4())
        seen.add(item_id)
        checked = value.get("checked", False)
        if not isinstance(checked, bool):
            raise InvalidInput("Checklist state must be boolean")
        prepared.append((item_id, text.strip(), checked))
    for row in existing.values():
        if row.item_id not in seen:
            session.delete(row)
    for position, (item_id, text, checked) in enumerate(prepared):
        row = existing.get(item_id)
        if row is None:
            row = TaskChecklistORM(item_id=item_id, task_id=task.task_id, text=text, checked=checked, position=position)
            session.add(row)
        else:
            row.text, row.checked, row.position = text, checked, position


def apply_fields(session, task, values, uid=None, *, initial=False):
    """Validate and apply inside the caller's task unit of work; caller owns revision."""
    from tracker import metadata, activity
    meta = metadata(session, task)
    planned_type = values.get("task_type", meta.task_type or "task")
    if planned_type == "milestone" and values.get("starts_at", meta.starts_at) is not None:
        raise InvalidInput("A milestone is a deadline point and cannot have a planned start")
    if "task_type" in values and not initial:
        for link in session.query(TaskLinkORM).filter(or_(TaskLinkORM.source_task_id == task.task_id, TaskLinkORM.target_task_id == task.task_id)):
            if link.kind not in {"epic", "milestone"}:
                continue
            source_type = planned_type if link.source_task_id == task.task_id else metadata(session, session.get(TaskORM, link.source_task_id)).task_type
            target_type = planned_type if link.target_task_id == task.task_id else metadata(session, session.get(TaskORM, link.target_task_id)).task_type
            if source_type != "task" or target_type != link.kind:
                raise InvalidInput("Remove incompatible epic or milestone links before changing task type", "task_type_conflict")
    changes = []
    for name in ("task_type", "priority", "starts_at"):
        if name not in values:
            continue
        after = values[name]
        if name == "task_type":
            if after not in TYPES:
                raise InvalidInput("Unsupported task type")
            before = meta.task_type or "task"
        elif name == "priority":
            if after not in PRIORITIES:
                raise InvalidInput("Unsupported priority")
            before = meta.priority or "normal"
        else:
            after = _time(after) if after is not None else None
            if after and task.deadline_at and _moment(after) > _moment(task.deadline_at):
                raise InvalidInput("Planned start must not be later than the deadline")
            before = meta.starts_at
        setattr(meta, name, after)
        if before != after:
            changes.append(dict(field=name, label=LABELS[name], before=before, after=after))
    if "checklist" in values:
        before_rows = checklist_rows(session, task.task_id)
        before_identity = [(row.item_id, row.text, row.checked) for row in before_rows]
        before = _checklist_snapshot(before_rows)
        _replace_checklist(session, task, values["checklist"], initial=initial)
        after_rows = checklist_rows(session, task.task_id)
        after_identity = [(row.item_id, row.text, row.checked) for row in after_rows]
        after = _checklist_snapshot(after_rows)
        # Text can be identical while IDs/order changed (two equal labels, or an
        # explicit delete-and-recreate). Those writes still invalidate old commands.
        if before_identity != after_identity:
            changes.append(dict(field="checklist", label="Чеклист", before=before, after=after))
    if changes and not initial:
        activity(session, task, "task_updated", uid, "Изменены параметры задачи", changes=changes)
    return bool(changes)


def patch(task_id, uid, expected_revision, values):
    """One public revision for a mixed classic/planning/checklist edit, all-or-nothing."""
    from tracker import visible_task, can_edit_public, can_edit_description, patch_files
    values = dict(values)
    extras = {name: values[name] for name in FIELDS if name in values}
    classic = {name: values[name] for name in ("title", "description", "parent_task_id", "file_ids") if name in values}
    with db.atomic():
        with db._session() as session:
            task = visible_task(session, task_id, uid)
            if task.revision != expected_revision:
                raise revision_conflict()
            if any(name in extras for name in ("starts_at","task_type","priority")) and not can_edit_public(session, task, uid):
                raise Forbidden("Cannot edit task planning")
            if "checklist" in extras and not can_edit_description(session, task, uid):
                raise Forbidden("Cannot edit task checklist")
            # Classification and planning belong to task editors, not readers.
            # A milestone is a point: clearing its interval is an inseparable
            # effect of that type command, not a general planned-date permission.
            if extras.get("task_type") == "milestone" and "starts_at" not in extras:
                extras["starts_at"] = None
            if classic:
                db.patch_task(task_id, expected_revision, classic.get("title"), classic.get("description"), uid,
                    parent_task_id=classic.get("parent_task_id"), parent_supplied="parent_task_id" in classic)
                if classic.get("file_ids") is not None:
                    patch_files(task_id, uid, task.revision, classic["file_ids"], increment_revision=False)
            changed = apply_fields(session, task, extras, uid)
            if changed and not classic:
                task.revision += 1
            session.commit()
            return db.get_task(task_id, uid)


def task_ref(session, task_id, uid):
    from tracker import metadata
    from tracker_status import public_status
    from task_queues import task_read, task_queue
    task = session.get(TaskORM, task_id)
    if not task or uid is None or not task_read(session, task, uid):
        return None
    meta = metadata(session, task)
    queue = task_queue(session, task)
    key = queue.key + "-" + str(meta.queue_number) if queue else "TASK-" + str(meta.task_number)
    return dict(task_id=task.task_id, task_key=key, title=task.title, status=public_status(meta.status),
        deadline_at=task.deadline_at, starts_at=meta.starts_at, task_type=meta.task_type or "task")


def enrich(session, task, result, uid):
    from tracker import metadata, can_edit_public, can_edit_description, is_control_task
    meta = metadata(session, task)
    result.task_type = meta.task_type or "task"
    result.priority = meta.priority or "normal"
    result.starts_at = meta.starts_at
    result.is_favorite = bool(uid and cached(session,"task.favorite",(task.task_id,uid),lambda:bool(session.get(TaskFavoriteORM, (task.task_id, uid))),copy_result=False))
    result.checklist = [dict(item_id=row.item_id, text=row.text, checked=row.checked) for row in checklist_rows(session, task.task_id)]
    result.links = []
    for link in orm_rows(session,"task.links",task.task_id,lambda:session.query(TaskLinkORM).filter(or_(TaskLinkORM.source_task_id == task.task_id, TaskLinkORM.target_task_id == task.task_id)).order_by(TaskLinkORM.created_at, TaskLinkORM.link_id).all()):
        outgoing = link.source_task_id == task.task_id
        other = link.target_task_id if outgoing else link.source_task_id
        ref = task_ref(session, other, uid)
        if ref:
            kind = link.kind if outgoing or link.kind == "related" else {"blocks":"blocked_by", "epic":"epic_member", "milestone":"milestone_member"}[link.kind]
            result.links.append(dict(link_id=link.link_id, kind=kind, task=ref,managed=is_control_task(session,task.task_id) or is_control_task(session,other)))
    result.children = []
    for child in orm_rows(session,"task.children",task.task_id,lambda:session.query(TaskTrackerORM).filter_by(parent_task_id=task.task_id).order_by(TaskTrackerORM.queue_id, TaskTrackerORM.queue_number).all()):
        ref = task_ref(session, child.task_id, uid)
        if ref:
            result.children.append(ref)
    if uid:
        if can_edit_public(session, task, uid):
            result.capabilities += ["edit_task_metadata", "manage_task_links", "change_task_type", "change_task_priority"]
        if can_edit_description(session, task, uid):
            result.capabilities.append("edit_task_checklist")
        result.capabilities += ["toggle_task_favorite", "toggle_task_checklist"]
    return result


def prepare_relations(session, task_ids, uid):
    """Prime selected task planning relations without changing reference ACL."""
    from collections import defaultdict
    from read_context import _context
    context = _context(session)
    if not task_ids or context is None or not context.usable():
        return
    checks, links, children = defaultdict(list), defaultdict(list), defaultdict(list)
    favorites = set()
    for offset in range(0, len(task_ids), 500):
        batch = task_ids[offset:offset+500]
        for row in session.query(TaskChecklistORM).filter(TaskChecklistORM.task_id.in_(batch)):
            checks[row.task_id].append(row)
        for row in session.query(TaskLinkORM).filter(or_(TaskLinkORM.source_task_id.in_(batch), TaskLinkORM.target_task_id.in_(batch))).order_by(TaskLinkORM.created_at, TaskLinkORM.link_id):
            for task_id in {row.source_task_id, row.target_task_id} & set(batch):
                links[task_id].append(row)
        for row in session.query(TaskTrackerORM).filter(TaskTrackerORM.parent_task_id.in_(batch)).order_by(TaskTrackerORM.queue_id, TaskTrackerORM.queue_number):
            children[row.parent_task_id].append(row)
        if uid:
            favorites.update(row.task_id for row in session.query(TaskFavoriteORM).filter(TaskFavoriteORM.user_id == uid, TaskFavoriteORM.task_id.in_(batch)))
    for task_id in task_ids:
        prime_rows(session,"task.checklist",task_id,checks[task_id])
        prime_rows(session,"task.links",task_id,links[task_id])
        prime_rows(session,"task.children",task_id,children[task_id])
        # bool is immutable, and only this read UOW can observe the hint.
        cached(session,"task.favorite",(task_id,uid),lambda task_id=task_id:task_id in favorites,copy_result=False)


def toggle_checklist(task_id, item_id, uid, expected_revision, checked):
    """Readers may mark one stored item; text/order/full replacement keep old ACL."""
    from tracker import visible_task, activity
    if not isinstance(checked, bool):
        raise InvalidInput("Checklist state must be boolean")
    with db.atomic():
        with db._session() as session:
            task = visible_task(session, task_id, uid)
            if task.revision != expected_revision:
                raise revision_conflict()
            item = session.get(TaskChecklistORM, item_id)
            if not item or item.task_id != task_id:
                raise NotFound("Checklist item not found")
            if item.checked == checked:
                return db.get_task(task_id, uid)
            before = _checklist_snapshot(checklist_rows(session, task_id))
            item.checked = checked
            after = _checklist_snapshot(checklist_rows(session, task_id))
            task.revision += 1
            activity(session, task, "task_updated", uid, "Изменена отметка чеклиста",
                changes=[dict(field="checklist", label="Чеклист", before=before, after=after)])
            session.commit()
            return db.get_task(task_id, uid)


def set_favorite(task_id, uid, favorite):
    from tracker import visible_task
    with db.atomic():
        with db._session() as session:
            visible_task(session, task_id, uid)
            row = session.get(TaskFavoriteORM, (task_id, uid))
            if favorite and row is None:
                session.add(TaskFavoriteORM(task_id=task_id, user_id=uid))
            elif not favorite and row is not None:
                session.delete(row)
            session.commit()
            return db.get_task(task_id, uid)


def _canonical(source, target, kind):
    if source == target:
        raise InvalidInput("A task cannot link to itself")
    if kind not in {"related", "blocks", "blocked_by", "epic", "epic_member", "milestone", "milestone_member"}:
        raise InvalidInput("Unsupported task relation")
    if kind == "related":
        source, target = sorted((source, target))
    elif kind == "blocked_by":
        source, target, kind = target, source, "blocks"
    elif kind in {"epic_member", "milestone_member"}:
        source, target, kind = target, source, kind.removesuffix("_member")
    return source, target, kind


def _check_dependency_cycle(session, source, target):
    graph = {}
    for link in session.query(TaskLinkORM).filter_by(kind="blocks"):
        graph.setdefault(link.source_task_id, set()).add(link.target_task_id)
    stack, seen = [target], set()
    while stack:
        current = stack.pop()
        if current == source:
            raise InvalidInput("Dependency cycle is not allowed")
        if current not in seen:
            seen.add(current)
            stack.extend(graph.get(current, ()))


def _editable(session, task_id, uid, expected_revision):
    from tracker import visible_task, can_edit_public, is_control_task
    task = visible_task(session, task_id, uid)
    if is_control_task(session,task_id):raise Conflict("Control epic relations are managed automatically","control_epic_managed")
    if not can_edit_public(session, task, uid):
        raise Forbidden("Cannot edit task relations")
    if task.revision != expected_revision:
        raise revision_conflict()
    return task


def _relation_activity(session, link, actor, removed=False):
    from tracker import activity
    for task_id, other_id in ((link.source_task_id, link.target_task_id), (link.target_task_id, link.source_task_id)):
        task = session.get(TaskORM, task_id)
        kind = link.kind if task_id == link.source_task_id or link.kind == "related" else {"blocks":"blocked_by", "epic":"epic_member", "milestone":"milestone_member"}[link.kind]
        value = kind + ":" + other_id
        task.revision += 1
        activity(session, task, "task_link_removed" if removed else "task_link_added", actor,
            "Удалена связь задач" if removed else "Добавлена связь задач",
            changes=[dict(field="links", label="Связи задач", before=[value] if removed else [], after=[] if removed else [value])])


def add_link(task_id, uid, expected_revision, target_task_id, kind):
    from tracker import visible_task
    with db.atomic():
        with db._session() as session:
            task = _editable(session, task_id, uid, expected_revision)
            target = visible_task(session, target_task_id, uid)
            from tracker import is_control_task
            if is_control_task(session,task_id) or is_control_task(session,target_task_id):raise Conflict("Control epic relations are managed automatically","control_epic_managed")
            if task.season_id != target.season_id:
                raise InvalidInput("Linked tasks must belong to the same season")
            source_id, target_id, kind = _canonical(task_id, target_task_id, kind)
            existing = session.query(TaskLinkORM).filter_by(source_task_id=source_id, target_task_id=target_id, kind=kind).first()
            if existing:
                return db.get_task(task_id, uid)
            if kind in {"epic", "milestone"}:
                from tracker import metadata
                source_type=metadata(session,session.get(TaskORM,source_id)).task_type or "task"
                target_type=metadata(session,session.get(TaskORM,target_id)).task_type or "task"
                if source_type!="task" or target_type!=kind:
                    raise InvalidInput("Epic and milestone membership requires a task and the corresponding group type")
                if kind=="epic" and session.query(TaskLinkORM).filter_by(source_task_id=source_id,kind="epic").first():
                    raise Conflict("A task may belong to only one epic", "task_epic_conflict")
            if kind == "blocks":
                _check_dependency_cycle(session, source_id, target_id)
            link = TaskLinkORM(link_id="tasklink-" + str(uuid.uuid4()), source_task_id=source_id,
                target_task_id=target_id, kind=kind, created_by_user_id=uid,
                created_at=datetime.now(timezone.utc).isoformat())
            session.add(link)
            _relation_activity(session, link, uid)
            session.commit()
            return db.get_task(task_id, uid)


def remove_link(task_id, uid, expected_revision, link_id):
    from tracker import visible_task
    with db.atomic():
        with db._session() as session:
            _editable(session, task_id, uid, expected_revision)
            link = session.get(TaskLinkORM, link_id)
            if not link or task_id not in (link.source_task_id, link.target_task_id):
                raise NotFound("Task relation not found")
            other = link.target_task_id if link.source_task_id == task_id else link.source_task_id
            visible_task(session, other, uid)
            from tracker import is_control_task
            if is_control_task(session,task_id) or is_control_task(session,other):raise Conflict("Control epic relations are managed automatically","control_epic_managed")
            _relation_activity(session, link, uid, removed=True)
            session.delete(link)
            session.commit()
            return db.get_task(task_id, uid)


def public_link_change(session, values, uid):
    """Do not retain cached title/key or reveal a revoked target in activity diffs."""
    if not isinstance(values, list):
        return []
    names = {"related": "Связана с", "blocks": "Блокирует", "blocked_by": "Зависит от",
        "epic":"Эпик", "epic_member":"Задача эпика", "milestone":"Веха", "milestone_member":"Задача вехи"}
    result = []
    for value in values:
        kind, _, task_id = str(value).partition(":")
        ref = task_ref(session, task_id, uid)
        result.append(names.get(kind, "Связь") + ": " + (ref["task_key"] if ref else "Недоступная задача"))
    return result
