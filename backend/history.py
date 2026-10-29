"""Authorized projections of public activity and private audit, plus text redaction.

The API never returns raw audit dictionaries. Historical supervision needs persisted
intervals; current display names or current membership never prove past authority.
"""
import json
from typing import Literal

from fastapi import Depends
from sqlalchemy import event, text as sql_text
from sqlalchemy.inspection import inspect
from sqlalchemy.orm import Session

import access
from auth import get_current_user
from api_contract import cursor_page
from database import (db, AuditLogORM, TaskActivityORM, TaskORM, AssignmentORM, MeritORM,
                      SeasonORM, BlockORM, EventORM, SubeventORM, LeadershipORM,
                      RoleAssignmentORM, CommentORM)
from domain_models import BlockMetaORM, MembershipORM, ScopeTenureORM
from history_models import HistoryRedactionORM
from event_workspace_models import EventWorkspaceMetaORM
from models import User
from registration import Revision, audit, fail, now
from participation import dt
from profile_features import user_ref

TargetKind = Literal["task", "assignment", "merit", "season", "block", "event", "subevent", "leadership"]
PUBLIC_TASK = {"title", "description", "deadline_at", "status", "comment", "result", "attachments", "parent_task_id", "assignees", "watchers", "season_id", "task_type", "priority", "starts_at", "checklist", "links"}
METADATA = {"title", "description", "starts_at", "ends_at", "all_day", "announcement", "state", "is_current", "season_id", "event_id", "name", "community_url", "master_user_id", "chair_user_id", "deputy_user_ids", "organizer_user_ids", "user_id", "role", "active", "hr_user_id", "principal_assignment_id"}
PRIVATE_INPUTS = {"hours", "evaluation", "effective_completed_at", "assigned_at", "deadline_at", "criteria", "recipients", "status", "review_note", "assignee_user_id", "new_assignment_id", "new_assignee_user_id", "title", "description"}
TEXT_FIELDS = {"title", "description", "description_json", "content_json", "comment", "result", "body", "text", "review_note", "note", "reason", "announcement", "community_url", "links", "attachments", "checklist"}
LABELS = {"title": "Название", "description": "Описание", "comment": "Комментарий", "result": "Результат", "hours": "Часы", "evaluation": "Оценка", "effective_completed_at": "Расчётная дата выполнения", "assigned_at": "Дата выдачи", "deadline_at": "Дедлайн", "criteria": "Критерии", "recipients": "Получатели и исходные поля", "status": "Состояние", "review_note": "Замечание", "starts_at": "Начало", "ends_at": "Конец", "state": "Состояние сезона", "master_user_id": "Мастер", "chair_user_id": "Председатель", "deputy_user_ids": "Заместители", "organizer_user_ids": "Организаторы", "user_id": "Участник", "role": "Роль", "active": "Назначение действует", "hr_user_id": "HR", "name": "Название блока", "announcement": "Анонс", "season_id": "Сезон", "all_day": "Весь день"}
HIDDEN = "[Текст версии скрыт]"


def _loads(value, fallback):
    try:
        return json.loads(value or "")
    except (ValueError, TypeError):
        return fallback


def _block_id(identifier):
    with db._session() as session:
        meta = session.get(BlockMetaORM, identifier) or session.query(BlockMetaORM).filter_by(legacy_name=identifier).first()
        return meta.block_id if meta else identifier


def _block_history_id(session, identifier):
    """Resolve a live mutation's identity, including an in-flight label rename.

    This is not used to repair old audit labels: only the transaction making
    the change can prove which stable block owns its former/current name.
    """
    for row in list(session.identity_map.values()) + list(session.new):
        if not isinstance(row, BlockMetaORM):
            continue
        names = {row.legacy_name, *inspect(row).attrs.legacy_name.history.deleted}
        if identifier == row.block_id or identifier in names:
            return row.block_id
    meta = session.get(BlockMetaORM, identifier) or session.query(BlockMetaORM).filter_by(legacy_name=identifier).first()
    return meta.block_id if meta else identifier


def require_target(session, kind, identifier, actor):
    if kind == "task":
        from tracker import visible_task
        return visible_task(session, identifier, actor)
    if kind == "assignment":
        # This getter repeats task queue access and the private-input permission.
        db.get_assignment_assessment_inputs(identifier, actor)
        return session.get(AssignmentORM, identifier)
    if kind == "merit":
        db.get_merit(identifier, actor)
        return session.get(MeritORM, identifier)
    if kind == "block":
        from membership import legacy_name
        identifier = legacy_name(identifier)
        row = session.get(BlockORM, identifier)
    elif kind == "season":
        row = session.get(SeasonORM, identifier)
    elif kind == "event":
        row = session.get(EventORM, identifier)
    elif kind == "subevent":
        row = session.get(SubeventORM, identifier)
        if row and not access.allowed(actor, "subevent.view", "subevent", identifier):
            fail(404, "History is unavailable")
    elif kind == "leadership":
        row = session.get(LeadershipORM, 1) if identifier == "current" else None
    else:
        row = None
    if not row:
        fail(404, "History is unavailable")
    return row


def _scope(session, kind, row):
    if kind == "task":
        return row.scope_kind, row.scope_id
    if kind == "assignment":
        task = session.get(TaskORM, row.task_id)
        return task.scope_kind, task.scope_id
    if kind == "merit":
        return (row.scope_kind, row.scope_id) if row.scope_kind else ("event", row.event_id) if row.event_id else (None, None)
    if kind == "block":
        return "block", row.name
    if kind in {"event", "subevent"}:
        return kind, getattr(row, kind + "_id")
    return None, None


def _private_task(session, task, actor):
    return task.scope_kind != "queue" and access.allowed(actor, "task.inputs.view", task.scope_kind, task.scope_id)


def _canonical_audit(session, row):
    if row.target_kind in {"task", "assignment", "merit", "season", "block", "event", "subevent", "leadership"}:
        return row.target_kind, row.target_id
    alias = {"event_leaders": "event", "subevent_leaders": "subevent", "block_master": "block", "block_hr": "block", "subevent_hr": "subevent"}
    if row.target_kind in alias:
        return alias[row.target_kind], row.target_id
    if row.target_kind == "role_assignment_deputies":
        assignment = session.get(RoleAssignmentORM, row.target_id)
        if assignment:
            return assignment.scope_kind, assignment.scope_id
    return None, None


def _same_object(session, kind, identifier, raw_kind, raw_id):
    if kind != raw_kind:
        return False
    if kind == "block":
        # Old audit labels have no provenance across rename/reuse. Only the
        # stable identity captured by the mutation can bind a historical row.
        meta = session.get(BlockMetaORM, raw_id)
        return bool(meta and _block_id(identifier) == meta.block_id)
    if kind == "leadership":
        return str(raw_id) in {"1", "current"}
    return str(identifier) == str(raw_id)


def _audit_rows(session, kind, identifier, target, actor):
    assignments = {row.assignment_id for row in session.query(AssignmentORM).filter_by(task_id=identifier)} if kind == "task" else set()
    private = kind in {"assignment", "merit"} or kind == "task" and _private_task(session, target, actor)
    for row in session.query(AuditLogORM).order_by(AuditLogORM.created_at, AuditLogORM.id):
        raw_kind, raw_id = _canonical_audit(session, row)
        if _same_object(session, kind, identifier, raw_kind, raw_id):
            if kind == "task" and not private:
                continue  # Task audit contains assessment dates/criteria/reasons, not public activity.
            yield row, private
        elif kind == "task" and private and raw_kind == "assignment" and raw_id in assignments:
            yield row, True


def _clean(session, value, field):
    if field == "description" and isinstance(value, str):
        parsed = _loads(value, None)
        if isinstance(parsed, dict) and "body" in parsed:
            return parsed["body"]
    if isinstance(value, dict) and "user_id" in value:
        ref = user_ref(session, value.get("user_id"))
        return {"user": ref, **{key: _clean(session, item, key) for key, item in value.items() if key in {"hours", "evaluation", "completed_at", "effective_completed_at", "participant_id"}}}
    if field in {"user_id", "master_user_id", "chair_user_id", "assignee_user_id", "new_assignee_user_id", "hr_user_id"}:
        return user_ref(session, value) if value is not None else None
    if field in {"deputy_user_ids", "organizer_user_ids", "user_ids"}:
        return [user_ref(session, person) for person in value] if isinstance(value, list) else None
    if isinstance(value, dict):
        if "body" in value:
            return value.get("body", "")
        return {key: _clean(session, item, key) for key, item in value.items() if key not in {"display_name", "avatar_url", "email", "phone", "score", "kkr_score", "calculation_version"}}
    if isinstance(value, list):
        return [_clean(session, item, field) for item in value]
    return value


def _audit_changes(session, row, private):
    old, new = _loads(row.old_values_json, {}), _loads(row.new_values_json, {})
    allowed = PRIVATE_INPUTS if private else METADATA
    result = []
    for name in sorted(set(old) | set(new)):
        field = {"deputies_json": "deputy_user_ids", "organizer_user_ids_json": "organizer_user_ids", "description_json": "description"}.get(name, name)
        if field not in allowed or old.get(name) == new.get(name):
            continue
        result.append(dict(field=field, label=LABELS.get(field, field), before=_clean(session, old.get(name), field), after=_clean(session, new.get(name), field)))
    return result


def _within(row, at, start="started_at", end="ended_at"):
    begin, finish = getattr(row, start), getattr(row, end)
    return bool(begin and dt(begin) <= at and (not finish or at < dt(finish)))


def _scope_aliases(kind, identifier):
    if kind == "block":
        from membership import legacy_name
        return {identifier, legacy_name(identifier), _block_id(identifier)}
    return {identifier}


def _historically_in_scope(session, person, kind, identifier, at):
    aliases = _scope_aliases(kind, identifier)
    for row in session.query(ScopeTenureORM).filter_by(user_id=person, scope_kind=kind):
        same = getattr(row, "scope_block_id", None) == _block_id(identifier) if kind == "block" else row.scope_id in aliases
        if same and _within(row, at):
            return True
    if kind == "block":
        for row in session.query(MembershipORM).filter_by(user_id=person):
            start = row.joined_at or row.observed_since
            if row.block_id == _block_id(identifier) and start and dt(start) <= at and (not row.left_at or at < dt(row.left_at)):
                return True
    if kind == "event":
        return any(_historically_in_scope(session, person, "subevent", child.subevent_id, at) for child in session.query(SubeventORM).filter_by(event_id=identifier))
    return False


def _historical_supervisor(session, supervisor, subject, kind, identifier, stamp):
    if subject is None:
        return False
    at = dt(stamp)
    global_leader = any(row.role in {"chair", "deputy_chair"} and _within(row, at)
                        for row in session.query(ScopeTenureORM).filter_by(user_id=supervisor, scope_kind="global"))
    if global_leader:
        return True
    if not kind or kind == "queue":
        return False
    # No current role/membership fallback: imported unknown dates prove nothing here.
    roles = {"block": {"master", "deputy_master"}, "event": {"event_leader", "deputy_event_leader"}, "subevent": {"subevent_leader", "deputy_subevent_leader"}}
    aliases = _scope_aliases(kind, identifier)
    direct = any(row.role in roles.get(kind, set()) and (getattr(row, "scope_block_id", None) == _block_id(identifier) if kind == "block" else row.scope_id in aliases) and _within(row, at)
                 for row in session.query(ScopeTenureORM).filter_by(user_id=supervisor, scope_kind=kind))
    if direct and _historically_in_scope(session, subject, kind, identifier, at):
        return True
    if kind == "subevent":
        sub = session.get(SubeventORM, identifier)
        if sub:
            return _historical_supervisor(session, supervisor, subject, "event", sub.event_id, stamp)
    return False


def may_hide(session, actor, author, kind, target, stamp):
    if author == actor:
        return True  # Current object access was checked, including after season closure.
    scope_kind, scope_id = _scope(session, kind, target)
    return _historical_supervisor(session, actor, author, scope_kind, scope_id, stamp)


def _entry(session, source_kind, source_id, kind, identifier, target, actor, author, stamp, description, changes, reason=None):
    marker = session.get(HistoryRedactionORM, (source_kind, str(source_id)))
    return dict(id=f"{source_kind}:{source_id}", source_kind=source_kind, source_id=str(source_id),
        target=dict(kind=kind, id=identifier), changed_by=user_ref(session, author), created_at=stamp,
        description="Версия скрыта" if marker else description,
        changes=[] if marker else changes, reason=None if marker else reason,
        hidden=bool(marker), hidden_by=user_ref(session, marker.redacted_by_user_id) if marker else None,
        hidden_at=marker.redacted_at if marker else None, revision=2 if marker else 1,
        can_hide=not marker and may_hide(session, actor, author, kind, target, stamp))


def history_items(session, kind, identifier, actor):
    target = require_target(session, kind, identifier, actor)
    result = []
    if kind == "task":
        from tracker import public_changes
        for row in session.query(TaskActivityORM).filter_by(task_id=identifier):
            result.append(_entry(session, "activity", row.event_id, kind, identifier, target, actor,
                row.actor_user_id, row.created_at, row.description, public_changes(session, row, actor)))
    for row, private in _audit_rows(session, kind, identifier, target, actor):
        changes = _audit_changes(session, row, private)
        marker = session.get(HistoryRedactionORM, ("audit", str(row.id)))
        if changes or marker:
            result.append(_entry(session, "audit", row.id, kind, identifier, target, actor,
                row.changed_by_user_id, row.created_at,
                "Изменены исходные поля ККР" if private else "Изменены параметры и состав",
                changes, row.reason if private else None))
    return result


def _comment_subject(session, row):
    changes = _loads(row.changes_json, [])
    named = next((change.get("comment_id") for change in changes if change.get("field") == "comment" and change.get("comment_id")), None)
    if named:
        return named
    candidates = []
    for comment in session.query(CommentORM).filter_by(task_id=row.task_id):
        if row.kind == "comment_added" and comment.created_at == row.created_at:
            candidates.append(comment.comment_id)
        elif any(item.get("edited_at") == row.created_at for item in _loads(comment.history_json, [])):
            candidates.append(comment.comment_id)
    return candidates[0] if len(candidates) == 1 else None


def _erase_text(value, field=None):
    if field in TEXT_FIELDS:
        return HIDDEN
    if isinstance(value, dict):
        return {key: _erase_text(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [_erase_text(item, field) for item in value]
    return value


def _redact_activity(session, row):
    changes = _loads(row.changes_json, [])
    chronological = session.query(TaskActivityORM).filter_by(task_id=row.task_id).order_by(TaskActivityORM.created_at, sql_text("task_activity.rowid")).all()
    index = chronological.index(row)
    subject = _comment_subject(session, row)
    for change in changes:
        field = change.get("field")
        if field not in TEXT_FIELDS:
            continue
        # Only the next version of this exact object/field may contain its predecessor.
        for following in chronological[index + 1:]:
            if field == "comment" and (not subject or _comment_subject(session, following) != subject):
                continue
            updates = _loads(following.changes_json, [])
            matching = next((item for item in updates if item.get("field") == field), None)
            if matching:
                if matching.get("before") == change.get("after"):
                    matching["before"] = HIDDEN
                    following.changes_json = json.dumps(updates, ensure_ascii=False)
                break
    if subject:
        comment = session.get(CommentORM, subject)
        if comment:
            snapshots = _loads(comment.history_json, [])
            # These snapshots are predecessor versions recorded by the following edit.
            for item in snapshots:
                if item.get("edited_at", "") > row.created_at and any(item.get("content", {}).get("body") == change.get("after") for change in changes if change.get("field") == "comment"):
                    item["content"] = {"format": "markdown", "body": HIDDEN}
                    break
            comment.history_json = json.dumps(snapshots, ensure_ascii=False)
    row.changes_json = "[]"
    row.description = "Версия скрыта"
    row.from_status = row.to_status = None


def _redact_audit(session, row):
    old, new = _loads(row.old_values_json, {}), _loads(row.new_values_json, {})
    following = session.query(AuditLogORM).filter_by(target_kind=row.target_kind, target_id=row.target_id).filter(AuditLogORM.id > row.id).order_by(AuditLogORM.id).all()
    for field in TEXT_FIELDS & set(new):
        for successor in following:
            before, after = _loads(successor.old_values_json, {}), _loads(successor.new_values_json, {})
            if field in before or field in after:
                if before.get(field) == new[field]:
                    before[field] = HIDDEN
                    successor.old_values_json = json.dumps(before, ensure_ascii=False)
                break
    row.old_values_json, row.new_values_json = json.dumps(_erase_text(old), ensure_ascii=False), json.dumps(_erase_text(new), ensure_ascii=False)
    row.reason = None


def anonymize(session, person, old_participant_id=None, new_participant_id=None):
    for field in ("original_actor_user_id", "redacted_by_user_id"):
        session.query(HistoryRedactionORM).filter(getattr(HistoryRedactionORM, field) == person).update({field: None}, synchronize_session=False)


def install_history_hooks():
    """Fill missing metadata/leadership audit only; never snapshot user contacts."""
    if getattr(install_history_hooks, "installed", False):
        return
    install_history_hooks.installed = True

    @event.listens_for(Session, "before_flush")
    def changed(session, _context, _instances):
        actor = access.actor_id.get() or session.info.get("tracker_actor")
        if actor is None:
            return
        models = {
            SeasonORM: ("season", "season_id", {"title": "title", "starts_at": "starts_at", "ends_at": "ends_at", "state": "state", "is_current": "is_current"}),
            EventORM: ("event", "event_id", {key: key for key in ("title", "description", "starts_at", "ends_at", "season_id")}),
            SubeventORM: ("subevent", "subevent_id", {"title": "title", "description": "description", "event_id": "event_id", "organizer_user_ids_json": "organizer_user_ids"}),
            BlockORM: ("block", "name", {"name": "name", "master_user_id": "master_user_id"}),
            BlockMetaORM: ("block", "block_id", {"description": "description", "community_url": "community_url"}),
            LeadershipORM: ("leadership", "id", {"chair_user_id": "chair_user_id", "deputies_json": "deputy_user_ids"}),
        }
        for obj in list(session.new) + list(session.dirty):
            if obj in session.new and isinstance(obj, (AssignmentORM, MeritORM)):
                if isinstance(obj, AssignmentORM):
                    values = {field: getattr(obj, field) for field in ("hours", "evaluation", "effective_completed_at", "status")}
                    audit(session, "assignment", obj.assignment_id, actor, "Создание исходных полей назначения", {}, values)
                else:
                    values = {field: getattr(obj, field) for field in ("title", "assigned_at", "deadline_at")}
                    values.update(description=_loads(obj.description_json, {}), criteria=_loads(obj.criteria_json, {}), recipients=_loads(obj.recipients_json, []))
                    audit(session, "merit", obj.merit_id, actor, "Создание записи выполненной работы", {}, values)
                continue
            if isinstance(obj, EventWorkspaceMetaORM):
                before, after = {}, {}
                for field in ("starts_at", "ends_at", "all_day", "announcement"):
                    history = inspect(obj).attrs[field].history
                    if history.has_changes():
                        before[field] = history.deleted[0] if history.deleted else None
                        after[field] = getattr(obj, field)
                if before or after:
                    audit(session, obj.owner_kind, obj.owner_id, actor, "Изменение сроков и анонса", before, after)
                continue
            spec = models.get(type(obj))
            if not spec:
                continue
            kind, id_field, fields = spec
            before, after = {}, {}
            for attr, label in fields.items():
                history = inspect(obj).attrs[attr].history
                if not history.has_changes():
                    continue
                old = history.deleted[0] if history.deleted else None
                new = history.added[0] if history.added else getattr(obj, attr)
                if attr.endswith("_json"):
                    old, new = _loads(old, []), _loads(new, [])
                before[label], after[label] = old, new
            if before or after:
                identifier = "current" if kind == "leadership" else getattr(obj, id_field)
                if kind == "block":
                    identifier = _block_history_id(session, identifier)
                audit(session, kind, identifier, actor,
                      session.info.get("history_reason") or "Изменение параметров" if kind == "season" else "Изменение параметров", before, after)
        for obj in list(session.new) + list(session.deleted):
            if not isinstance(obj, RoleAssignmentORM) or obj.scope_kind not in {"global", "block", "event", "subevent"}:
                continue
            kind = "leadership" if obj.scope_kind == "global" else obj.scope_kind
            identifier = "current" if kind == "leadership" else obj.scope_id
            if kind == "block":
                identifier = _block_history_id(session, identifier)
            values = dict(user_id=obj.user_id, role=obj.role, active=True)
            audit(session, kind, identifier, actor, "Изменение назначения", {} if obj in session.new else values,
                  values if obj in session.new else dict(user_id=None, role=None, active=False))
        for tenure in list(session.dirty):
            if not isinstance(tenure, ScopeTenureORM) or not inspect(tenure).attrs.ended_at.history.has_changes() or not tenure.ended_at:
                continue
            # Bulk removal of a principal's deputies may bypass ORM delete events.
            if any(isinstance(obj, RoleAssignmentORM) and obj.user_id == tenure.user_id and obj.scope_kind == tenure.scope_kind and obj.scope_id == tenure.scope_id and obj.role == tenure.role for obj in session.deleted):
                continue
            kind = "leadership" if tenure.scope_kind == "global" else tenure.scope_kind
            identifier = "current" if kind == "leadership" else tenure.scope_id
            if kind == "block":
                # An ended legacy interval has no historical identity proof;
                # record the live operation's block, never retrofit its dates.
                identifier = tenure.scope_block_id or _block_history_id(session, identifier)
            audit(session, kind, identifier, actor,
                "Завершение назначения", dict(user_id=tenure.user_id, role=tenure.role, active=True), dict(user_id=None, role=None, active=False))


def register_routes(router):
    install_history_hooks()

    @router.get("/history")
    def read(target_kind: TargetKind, target_id: str, cursor: str | None = None, cur: User = Depends(get_current_user)):
        with db._session() as session:
            items = history_items(session, target_kind, target_id, cur.user_id)
            return cursor_page(items, lambda item: (item["created_at"], item["id"]), cursor, descending=True)

    @router.post("/history/{source_kind}/{source_id}/hide")
    def hide(source_kind: Literal["activity", "audit"], source_id: str, payload: Revision, cur: User = Depends(get_current_user)):
        with db._session() as session:
            if source_kind == "activity":
                row = session.get(TaskActivityORM, source_id)
                kind, identifier = ("task", row.task_id) if row else (None, None)
            else:
                row = session.get(AuditLogORM, int(source_id)) if source_id.isdigit() else None
                kind, identifier = _canonical_audit(session, row) if row else (None, None)
            if not row or not kind:
                fail(404, "Version is unavailable")
            if source_kind == "audit" and kind == "block" and not session.get(BlockMetaORM, identifier):
                fail(404, "Version has no proven historical block identity")
            source_id = str(row.id) if source_kind == "audit" else row.event_id
            target = require_target(session, kind, identifier, cur.user_id)
            author = row.actor_user_id if source_kind == "activity" else row.changed_by_user_id
            if kind == "task" and source_kind == "audit" and not _private_task(session, target, cur.user_id):
                fail(404, "Version is unavailable")
            if not may_hide(session, cur.user_id, author, kind, target, row.created_at):
                fail(403, "No proven authority over this historical version")
            if payload.expected_revision != 1 or session.get(HistoryRedactionORM, (source_kind, source_id)):
                fail(409, "Version has already been hidden", "revision_conflict")
            session.add(HistoryRedactionORM(source_kind=source_kind, source_id=source_id,
                original_actor_user_id=author, redacted_by_user_id=cur.user_id, redacted_at=now()))
            if source_kind == "activity":
                _redact_activity(session, row)
            else:
                _redact_audit(session, row)
            session.flush()
            return dict(status="hidden")
