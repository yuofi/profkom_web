"""Additive event presentation and explicitly assigned subevent HR metadata."""

from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Text, CheckConstraint
from database import Base


class EventWorkspaceMetaORM(Base):
    __tablename__ = "event_workspace_metadata"

    owner_kind = Column(String, primary_key=True)
    owner_id = Column(String, primary_key=True)
    all_day = Column(Boolean, nullable=False, default=False, server_default="0")
    is_closed = Column(Boolean, nullable=False, default=False, server_default="0")
    closed_at = Column(String, nullable=True)
    closed_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    # The parent Event retains its existing authoritative date columns. Only the
    # child's newly introduced dates live here; an absent row means unknown dates.
    starts_at = Column(String, nullable=True)
    ends_at = Column(String, nullable=True)
    announcement = Column(Text, nullable=False, default="", server_default="")
    hr_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    __table_args__ = (
        CheckConstraint("owner_kind IN ('event','subevent')", name="event_workspace_owner_kind"),
        CheckConstraint("owner_kind = 'subevent' OR hr_user_id IS NULL", name="event_workspace_hr_child_only"),
    )
