"""Additive profile, awards, preferences and KKR-template persistence.

Imported by database before create_all. No identity is copied into event JSON.
"""
from sqlalchemy import Boolean, Column, ForeignKey, Index, Integer, String, Text, text
from database import Base


class ProfileEditorVersionORM(Base):
    __tablename__ = "profile_editor_versions"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    revision = Column(Integer, nullable=False, default=1)


class AchievementDefinitionORM(Base):
    __tablename__ = "achievement_definitions"
    achievement_id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    icon = Column(String, nullable=False, default="workspace_premium")
    scope_kind = Column(String, nullable=False)
    scope_id = Column(String, nullable=True)
    created_by_user_id = Column(Integer, nullable=True)
    created_at = Column(String, nullable=False)
    revision = Column(Integer, nullable=False, default=1)
    archived = Column(Boolean, nullable=False, default=False)


class AchievementGrantORM(Base):
    __tablename__ = "achievement_grants"
    grant_id = Column(String, primary_key=True)
    achievement_id = Column(String, ForeignKey("achievement_definitions.achievement_id"), nullable=False, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    participant_id = Column(String, nullable=False, index=True)
    issued_by_user_id = Column(Integer, nullable=True)
    issued_at = Column(String, nullable=False)
    snapshot_json = Column(Text, nullable=False)
    note = Column(Text, nullable=False, default="")
    revoked_at = Column(String, nullable=True)
    revoked_by_user_id = Column(Integer, nullable=True)
    revoke_reason = Column(Text, nullable=True)
    revision = Column(Integer, nullable=False, default=1)


class AchievementEventORM(Base):
    __tablename__ = "achievement_events"
    event_id = Column(String, primary_key=True)
    grant_id = Column(String, ForeignKey("achievement_grants.grant_id"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    actor_user_id = Column(Integer, nullable=True)
    created_at = Column(String, nullable=False)


class NotificationPreferenceORM(Base):
    __tablename__ = "notification_preferences"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    preferences_json = Column(Text, nullable=False)
    revision = Column(Integer, nullable=False, default=1)


class NotificationDeliveryEventORM(Base):
    """One notification for one channel outside the site. Email and Telegram rows stay
    `not_connected`; the VK channel is the HereBot queue of stage 3 (BOT_API.md): `pending`
    until the bot reports `sent`, `denied` or `failed`, or the site `cancelled` or `expired`.
    Times are ISO 8601 UTC as `created_at` (registration.now), so they compare as text."""
    __tablename__ = "notification_delivery_events"
    delivery_id = Column(String, primary_key=True)
    user_id = Column(Integer, nullable=True, index=True)
    event_key = Column(String, nullable=False)
    category = Column(String, nullable=False)
    source_kind = Column(String, nullable=False)
    source_id = Column(String, nullable=False)
    channel = Column(String, nullable=False)
    state = Column(String, nullable=False, default="not_connected")
    created_at = Column(String, nullable=False)
    # Stage 3, added columns (database._ensure_sqlite_delivery_queue on an old schema).
    attempts = Column(Integer, nullable=False, default=0, server_default=text("0"))  # results the bot reported
    next_attempt_at = Column(String, nullable=True)  # a pending row is handed out from then on
    sent_at = Column(String, nullable=True)
    vk_message_id = Column(Integer, nullable=True)
    error_code = Column(String, nullable=True)
    updated_at = Column(String, nullable=True)
    __table_args__ = (Index("unique_profile_delivery", "user_id", "event_key", "channel", unique=True),
                      # The bot's idle poll reads this index only (BOT_API.md, «Выдача в GET /work»).
                      Index("ix_delivery_vk_pending", "next_attempt_at", "created_at",
                            sqlite_where=text("channel = 'vk' AND state = 'pending'")))


class KkrTemplateORM(Base):
    __tablename__ = "kkr_templates"
    template_id = Column(String, primary_key=True)
    owner_user_id = Column(Integer, nullable=True, index=True)
    visibility = Column(String, nullable=False)
    scope_kind = Column(String, nullable=True)
    scope_id = Column(String, nullable=True)
    title = Column(String, nullable=False)
    values_json = Column(Text, nullable=False)
    revision = Column(Integer, nullable=False, default=1)
    archived = Column(Boolean, nullable=False, default=False)
    created_at = Column(String, nullable=False)


class KkrTemplateUseORM(Base):
    __tablename__ = "kkr_template_uses"
    use_id = Column(String, primary_key=True)
    template_id = Column(String, nullable=False, index=True)
    template_revision = Column(Integer, nullable=False)
    actor_user_id = Column(Integer, nullable=True)
    target_kind = Column(String, nullable=False)
    target_id = Column(String, nullable=False, index=True)
    template_snapshot_json = Column(Text, nullable=False)
    saved_values_json = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)
