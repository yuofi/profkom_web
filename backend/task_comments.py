"""Commands on a published comment besides its edit: a checklist mark and deletion.

Both belong to whoever may comment on the task (tracker.can_comment: every current
reader, closed seasons and control epics included; owner 2026-11-08, V4/V5).

A mark flips one ``[ ]``/``[x]`` marker named by its UTF-16 offset, as the description
command does. The client sends the body it saw; another body is a 409 ``comment_changed``
unless it is exactly this mark already made (a repeat after a lost answer). The comment is
not marked edited and gets no version snapshot; the task activity records the mark.

Deletion is soft (``deleted_at``/``deleted_by_user_id``) and leaves no placeholder: the
comment, its file bindings and its pending mention requests leave the task, earlier history
entries stay as they are and one more entry says who deleted it. A pending request stays
pending and moves to another live comment when one written or edited since the request was
raised still links the person (one request serves them all). Access already granted by an
approved mention stays. Repeating the deletion is a no-op.
"""
import json
import re

from database import db, TaskORM, CommentORM, _comment_orm_to_dc
from errors import Conflict, Forbidden, NotFound

LABEL_LIMIT = 80
_SLOT = re.compile("\ue000([0-9]+)\ue001")
# A backslash escape or a code span, whichever starts first; both are literal text.
_LITERAL = re.compile(r"\\([!-/:-@\[-`{-~])|(`+)(.+?)(?<!`)\2(?!`)")
_LINK = re.compile(r"!?\[((?:\\.|[^\]\\\n])*)\]\((?:[^()\n]|\([^()\n]*\))*\)")
_AUTOLINK = re.compile(r"<((?:https?|mailto):[^>\s]*)>")
_STRONG = re.compile(r"(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1")
_EMPHASIS = re.compile(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])")


def _readable(session, comment_id, uid):
    comment = session.get(CommentORM, comment_id)
    task = session.get(TaskORM, comment.task_id) if comment else None
    # Like its GET: someone who cannot read the task learns nothing about the comment.
    if not task or not db.can_read_task(uid, task, session):
        raise NotFound("Comment not found")
    return comment, task


def _body(comment):
    """The body the comment DTO shows (database._comment_orm_to_dc), legacy rows included."""
    try:
        content = json.loads(comment.content_json or "{}")
    except ValueError:
        return str(comment.content_json or "")
    return content.get("body", "") if isinstance(content, dict) else str(comment.content_json or "")


def _plain(text):
    """Inline Markdown as a reader sees it: link text without its target, no emphasis or code marks."""
    kept = []

    def literal(match):
        kept.append(match[1] or match[3].strip() or match[3])
        return "\ue000%d\ue001" % (len(kept) - 1)

    text = _LITERAL.sub(literal, _SLOT.sub("", text))
    text = _AUTOLINK.sub(r"\1", _LINK.sub(r"\1", text))
    for _ in range(3):
        text = _STRONG.sub(r"\2", text)
    text = _EMPHASIS.sub(lambda match: match[1] or match[2], text)
    return " ".join(_SLOT.sub(lambda match: kept[int(match[1])], text).split())


def _label(body, index):
    """The item's own line after its marker, as plain text, for the history description."""
    text = _plain(body[index + 2:].split("\n", 1)[0])
    if len(text) > LABEL_LIMIT:
        text = text[:LABEL_LIMIT - 1].rstrip() + "…"
    return text or "без текста"


def _marked(body, index, checked):
    return body[:index] + ("x" if checked else " ") + body[index + 1:]


def toggle_checklist(comment_id, uid, expected_body, offset, checked):
    from markdown_checklist import checklist_marker_utf16_offsets
    from tracker import activity, can_comment
    with db.atomic():
        with db._session() as session:
            comment, task = _readable(session, comment_id, uid)
            if comment.deleted_at:
                raise NotFound("Comment was deleted", "comment_deleted")
            if not can_comment(session, task, uid):
                raise Forbidden("Forbidden: cannot mark this comment")
            before = _body(comment)
            if before != expected_body:
                seen = checklist_marker_utf16_offsets(expected_body).get(offset)
                if seen is not None and before == _marked(expected_body, seen, checked):
                    return _comment_orm_to_dc(session, comment, uid)
                raise Conflict("Comment changed since it was read", "comment_changed")
            index = checklist_marker_utf16_offsets(before).get(offset)
            if index is None:
                raise Forbidden("Only checklist marks may be changed", "checklist_only")
            if (before[index] != " ") == checked:
                return _comment_orm_to_dc(session, comment, uid)
            body = _marked(before, index, checked)
            comment.content_json = json.dumps({"format": "markdown", "body": body})
            session.info.setdefault("comment_activity_written", set()).add(comment.comment_id)
            label = _label(body, index)
            activity(session, task, "comment_checklist_toggled", uid,
                     f"Отмечен пункт «{label}» в комментарии" if checked else f"Снята отметка с пункта «{label}» в комментарии",
                     changes=[dict(field="comment", label="Комментарий", comment_id=comment.comment_id, before=before, after=body)])
            session.flush()
            return _comment_orm_to_dc(session, comment, uid)


def delete(comment_id, uid):
    from tracker import activity, can_comment, now, _file_refs
    from tracker_collaboration import _comment_profile_ids
    from tracker_collaboration_models import TaskMentionRequestORM
    with db.atomic():
        with db._session() as session:
            comment, task = _readable(session, comment_id, uid)
            if not can_comment(session, task, uid):
                raise Forbidden("Forbidden: cannot delete this comment")
            if comment.deleted_at:
                return
            stamp = now()
            comment.deleted_at, comment.deleted_by_user_id = stamp, uid
            changes = [dict(field="comment", label="Комментарий", comment_id=comment.comment_id, before=_body(comment), after=None)]
            files = _file_refs(session, json.loads(comment.files_json or "[]"))
            if files:
                changes.append(dict(field="comment_attachments", label="Вложения комментария", comment_id=comment.comment_id, before=files, after=[]))
            activity(session, task, "comment_deleted", uid, "Комментарий удалён", at=stamp, changes=changes)
            pending = session.query(TaskMentionRequestORM).filter_by(comment_id=comment.comment_id, status="pending").all()
            live = session.query(CommentORM).filter(
                CommentORM.task_id == task.task_id, CommentORM.deleted_at.is_(None), CommentORM.comment_id != comment.comment_id,
            ).order_by(CommentORM.created_at, CommentORM.comment_id).all() if pending else []
            for row in pending:
                row.revision += 1
                # One pending request per task and person serves every comment that calls them since it
                # was raised (tracker_collaboration._sync); it moves to the first such comment still live.
                heir = next((other.comment_id for other in live if max(other.created_at or "", other.updated_at or "") >= row.created_at
                             and row.target_user_id in _comment_profile_ids(_body(other))), None)
                if heir:
                    row.comment_id = heir
                else:
                    row.status, row.decided_at, row.decided_by_user_id = "cancelled", stamp, uid
            session.flush()
