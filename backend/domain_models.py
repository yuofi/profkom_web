"""Persistence for registrations, membership history and stable block metadata."""

from sqlalchemy import Column, Integer, String, Text, Boolean, Float, ForeignKey, Index, UniqueConstraint, text
from database import Base


class RegistrationORM(Base):
    __tablename__ = "registration_applications"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    status = Column(String, nullable=False, default="pending")
    fields_json = Column(Text, nullable=False, default="{}")
    attempts_used = Column(Integer, nullable=False, default=1)
    total_submissions = Column(Integer, nullable=False, default=1)
    rejection_reason = Column(Text, nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    history_json = Column(Text, nullable=False, default="[]")


class ParticipationORM(Base):
    __tablename__ = "participation_intervals"
    interval_id = Column(String, primary_key=True)
    participant_id = Column(String, nullable=False, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    started_at = Column(String, nullable=False)
    ended_at = Column(String, nullable=True)
    __table_args__ = (
        Index(
            "one_active_participation",
            user_id,
            unique=True,
            sqlite_where=text("ended_at IS NULL"),
        ),
    )


class BlockMetaORM(Base):
    __tablename__ = "block_metadata"
    block_id = Column(String, primary_key=True)
    legacy_name = Column(String, nullable=False, unique=True)
    description = Column(Text, nullable=False, default="")
    community_url = Column(String, nullable=True)
    avatar_file_id = Column(String, nullable=True)
    archived_at = Column(String, nullable=True)
    deletion_request_id = Column(String, nullable=True)
    hr_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    revision = Column(Integer, nullable=False, default=1)


class MembershipORM(Base):
    __tablename__ = "memberships"
    membership_id = Column(String, primary_key=True)
    user_id = Column(Integer, nullable=True, index=True)
    participant_id = Column(String, nullable=False, index=True)
    block_id = Column(
        String, ForeignKey("block_metadata.block_id"), nullable=False, index=True
    )
    category = Column(String, nullable=False, default="junior")
    joined_at = Column(
        String, nullable=True
    )  # Unknown migration dates are never invented.
    # Since when the membership of an approved account is known when joined_at is not:
    # the migration, the approval of the account or a roster row added later (A-DIR-18).
    observed_since = Column(String, nullable=True)
    left_at = Column(String, nullable=True)
    __table_args__ = (
        Index(
            "one_active_membership",
            user_id,
            block_id,
            unique=True,
            sqlite_where=text("left_at IS NULL"),
        ),
    )


class BlockApplicationORM(Base):
    __tablename__ = "block_applications"
    request_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    block_id = Column(
        String, ForeignKey("block_metadata.block_id"), nullable=False, index=True
    )
    state = Column(String, nullable=False, default="pending_hr")
    created_at = Column(String, nullable=False)
    stage_entered_at = Column(String, nullable=False)
    revision = Column(Integer, nullable=False, default=1)
    history_json = Column(Text, nullable=False, default="[]")
    __table_args__ = (
        Index(
            "one_open_block_application",
            user_id,
            block_id,
            unique=True,
            sqlite_where=text("state IN ('pending_hr','pending_block')"),
        ),
    )


class CategoryRevisionORM(Base):
    __tablename__ = "category_revisions"
    user_id = Column(Integer, primary_key=True)
    revision = Column(Integer, nullable=False, default=1)


class MigrationORM(Base):
    __tablename__ = "domain_migrations"
    version = Column(String, primary_key=True)
    completed_at = Column(String, nullable=False)
    report_json = Column(Text, nullable=False)


class ScopeTenureORM(Base):
    __tablename__ = "scope_tenures"
    tenure_id = Column(String, primary_key=True)
    user_id = Column(Integer, nullable=True, index=True)
    scope_kind = Column(String, nullable=False, index=True)
    scope_id = Column(String, nullable=False, index=True)
    # Legacy scope_id is a label; old rows remain unproved after migration.
    scope_block_id = Column(String, ForeignKey("block_metadata.block_id"), nullable=True, index=True)
    role = Column(String, nullable=False)
    principal_id = Column(String, nullable=True)
    started_at = Column(String, nullable=False)
    ended_at = Column(String, nullable=True)


class SummaryVersionORM(Base):
    __tablename__ = "summary_versions"
    snapshot_id = Column(String, primary_key=True)
    season_id = Column(String, nullable=False, index=True)
    version = Column(Integer, nullable=False)
    summary_json = Column(Text, nullable=False)
    contributions_json = Column(Text, nullable=False)
    bonuses_json = Column(Text, nullable=False)
    previous_summary_version = Column(Integer, nullable=True)
    changed_by_user_id = Column(Integer, nullable=True)
    reason = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)
    __table_args__ = (Index("unique_summary_version", season_id, version, unique=True),)


class MaterialORM(Base):
    __tablename__ = "materials"
    material_id = Column(String, primary_key=True)
    legacy_guide_id = Column(Integer, nullable=True, unique=True, index=True)
    kind = Column(String, nullable=False)
    # Catalogue placement is independent of the guide's format, owner and ACL.
    catalog_section = Column(String, nullable=True)
    owner_block_id = Column(
        String, ForeignKey("block_metadata.block_id"), nullable=True, index=True
    )
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    original_link = Column(String, nullable=True)
    published_body = Column(Text, nullable=True)
    draft_title = Column(String, nullable=True)
    draft_description = Column(Text, nullable=True)
    draft_original_link = Column(String, nullable=True)
    draft_body = Column(Text, nullable=True)
    published_format = Column(String, nullable=False, default="markdown", server_default="markdown")
    draft_format = Column(String, nullable=False, default="markdown", server_default="markdown")
    has_draft = Column(Boolean, nullable=False, default=True)
    revision = Column(Integer, nullable=False, default=1)
    placeholder = Column(Boolean, nullable=False, default=False)
    deleted = Column(Boolean, nullable=False, default=False)
    deleted_at = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    # When the readers' version was last published; unknown for older publications (GL-17).
    published_at = Column(String, nullable=True)
    # Who reads a block guide: "block" — its members, leads and the chair's team; "everyone" —
    # every active participant (owner, 2026-10-25). Other materials read to everyone.
    audience = Column(String, nullable=False, default="block", server_default="block")


class MaterialRenderArtifactORM(Base):
    """Bounded derived content, never a source of authorization."""
    __tablename__ = "material_render_artifacts"
    material_id = Column(String, ForeignKey("materials.material_id"), primary_key=True)
    slot = Column(String, primary_key=True)
    source_hash = Column(String, nullable=False)
    render_json = Column(Text, nullable=False)


class ProfileMetadataORM(Base):
    __tablename__ = "profile_metadata"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    participation_periods_json = Column(Text, nullable=False, default="[]")
    preset_id = Column(String, nullable=True)
    avatar_file_id = Column(String, nullable=True)


class FormerContactORM(Base):
    __tablename__ = "former_contacts"
    contact_id = Column(String, primary_key=True)
    fields_json = Column(Text, nullable=False)
    revision = Column(Integer, nullable=False, default=1, server_default="1")
    source_user_id = Column(Integer, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)


class AccountArchiveORM(Base):
    __tablename__ = "account_archives"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    archived_at = Column(String, nullable=False)
    reason = Column(Text, nullable=False)
    snapshot_json = Column(Text, nullable=False)
    restored_at = Column(String, nullable=True)
    purged_at = Column(String, nullable=True)
    anonymous_participant_id = Column(String, nullable=True, unique=True)


class ObjectDeletionORM(Base):
    __tablename__ = "object_deletions"
    object_key = Column(String, primary_key=True)
    requested_at = Column(String, nullable=False)
    completed_at = Column(String, nullable=True)


class SeasonCoefficientORM(Base):
    __tablename__ = "season_coefficients"
    coefficient_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    source_kind = Column(String, nullable=False)
    source_id = Column(String, nullable=False)
    value = Column(Float, nullable=False, default=1.0)
    revision = Column(Integer, nullable=False, default=1)
    updated_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    updated_at = Column(String, nullable=False)
    __table_args__ = (UniqueConstraint("season_id", "source_kind", "source_id", name="uq_season_coefficient_source"),)


class KkrControlEpicORM(Base):
    __tablename__ = "kkr_control_epics"
    control_id = Column(String, primary_key=True)
    season_id = Column(String, ForeignKey("seasons.season_id"), nullable=False, index=True)
    source_kind = Column(String, nullable=False)
    source_id = Column(String, nullable=False)
    task_id = Column(String, ForeignKey("tasks.task_id"), nullable=False, unique=True)
    queue_id = Column(String, ForeignKey("task_queues.queue_id"), nullable=False)
    managed_json = Column(Text, nullable=False, default="{}")
    created_at = Column(String, nullable=False)
    __table_args__ = (UniqueConstraint("season_id", "source_kind", "source_id", name="uq_kkr_control_source"),)


class ScopeChatBindingORM(Base):
    """Current binding or retained tombstone; scope identity never follows a block rename."""
    __tablename__ = "scope_chat_bindings"
    binding_id = Column(String, primary_key=True)
    scope_kind = Column(String, nullable=False)
    scope_id = Column(String, nullable=False)
    revision = Column(Integer, nullable=False, default=0)
    state = Column(String, nullable=False, default="unlinked")
    bot_identity = Column(Integer, nullable=True)
    peer_id = Column(Integer, nullable=True)
    title = Column(String, nullable=False, default="")
    confirmed_by_user_id = Column(Integer, nullable=True)
    confirmed_at = Column(String, nullable=True)
    observed_at = Column(String, nullable=True)
    __table_args__ = (UniqueConstraint("scope_kind", "scope_id", name="uq_scope_chat_binding"),)


class ScopeChatCodeORM(Base):
    __tablename__ = "scope_chat_codes"
    code_hash = Column(String, primary_key=True)
    scope_kind = Column(String, nullable=False)
    scope_id = Column(String, nullable=False)
    user_id = Column(Integer, nullable=False, index=True)
    vk_user_id = Column(Integer, nullable=False)
    expected_revision = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)
    expires_at = Column(String, nullable=False)
    used_binding_id = Column(String, nullable=True)
    used_revision = Column(Integer, nullable=True)
    used_bot_identity = Column(Integer, nullable=True)
    used_peer_id = Column(Integer, nullable=True)


class ScopeChatAttemptORM(Base):
    __tablename__ = "scope_chat_attempts"
    attempt_id = Column(String, primary_key=True)
    vk_user_id = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)
    __table_args__ = (Index("ix_scope_chat_attempt_vk_time", "vk_user_id", "created_at"),)


class TaskChatAnnouncementORM(Base):
    __tablename__ = "task_chat_announcements"
    announcement_id = Column(String, primary_key=True)
    task_id = Column(String, ForeignKey("tasks.task_id"), nullable=False, unique=True)
    binding_id = Column(String, nullable=False, index=True)
    binding_revision = Column(Integer, nullable=False)
    created_by_user_id = Column(Integer, nullable=False)
    created_at = Column(String, nullable=False)
    expires_at = Column(String, nullable=False)
    state = Column(String, nullable=False, default="pending")
    revision = Column(Integer, nullable=False, default=1)
    payload_json = Column(Text, nullable=False)
    payload_hash = Column(String, nullable=False)
    recipient_user_ids_json = Column(Text, nullable=False, default="[]")
    error_code = Column(String, nullable=True)
    sent_at = Column(String, nullable=True)
    retry_at = Column(String, nullable=True)
    attempts = Column(Integer, nullable=False, default=0)
    result_fingerprint = Column(String, nullable=True)
    checked_at = Column(String, nullable=True)
    retry_generation = Column(Integer, nullable=False, default=0)
    worker_id = Column(String, nullable=True)
    lease_token = Column(String, nullable=True)
    lease_expires_at = Column(String, nullable=True)
    fence = Column(Integer, nullable=False, default=0)
    parts_total = Column(Integer, nullable=True)
    __table_args__ = (Index("ix_task_chat_due", "state", "retry_at", "created_at"),
                      Index("ix_task_chat_sweep", "state", "checked_at", "created_at"),)


class TaskChatPartORM(Base):
    __tablename__ = "task_chat_parts"
    announcement_id = Column(String, ForeignKey("task_chat_announcements.announcement_id"), primary_key=True)
    part_number = Column(Integer, primary_key=True)
    bot_identity = Column(Integer, nullable=False)
    random_id = Column(Integer, nullable=False)
    part_hash = Column(String, nullable=False)
    result_fingerprint = Column(String, nullable=True)
    state = Column(String, nullable=False, default="authorized")
    message_id = Column(Integer, nullable=True)
    __table_args__ = (UniqueConstraint("bot_identity", "random_id", name="uq_task_chat_random_id"),)


class BlockDeletionRequestORM(Base):
    __tablename__ = "block_deletion_requests"
    request_id = Column(String, primary_key=True)
    block_id = Column(String, ForeignKey("block_metadata.block_id"), nullable=False, index=True)
    state = Column(String, nullable=False, default="pending")
    revision = Column(Integer, nullable=False, default=1)
    created_at = Column(String, nullable=False)
    first_user_id = Column(Integer, nullable=True)
    first_approved_at = Column(String, nullable=False)
    second_user_id = Column(Integer, nullable=True)
    second_approved_at = Column(String, nullable=True)
    scheduled_at = Column(String, nullable=True)
    delete_after = Column(String, nullable=True)
    finished_at = Column(String, nullable=True)
    cancel_reason = Column(String, nullable=True)
    last_reminder = Column(Integer, nullable=False, default=0)
    next_check_at = Column(String, nullable=True)
    __table_args__ = (Index("ix_block_deletion_due", "state", "next_check_at"),)
