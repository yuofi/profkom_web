"""Explicit, revocable task-only sharing and approval of comment mentions."""
from sqlalchemy import Boolean, Column, ForeignKey, Index, Integer, String, text
from database import Base


class TaskMentionRequestORM(Base):
    __tablename__ = "task_mention_requests"
    request_id = Column(String, primary_key=True)
    task_id = Column(String, ForeignKey("tasks.task_id"), nullable=False, index=True)
    comment_id = Column(String, ForeignKey("task_comments.comment_id"), nullable=True)
    target_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False)
    requested_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False)
    status = Column(String, nullable=False, default="pending")
    created_at = Column(String, nullable=False)
    decided_at = Column(String, nullable=True)
    decided_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    __table_args__ = (Index("one_pending_task_mention", task_id, target_user_id,
        unique=True, sqlite_where=text("status = 'pending'")),)


class TaskAccessGrantORM(Base):
    __tablename__ = "task_access_grants"
    task_id = Column(String, ForeignKey("tasks.task_id"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    active = Column(Boolean, nullable=False, default=True)
    source = Column(String, nullable=False, default="mention")
    granted_at = Column(String, nullable=False)
    granted_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    revoked_at = Column(String, nullable=True)
