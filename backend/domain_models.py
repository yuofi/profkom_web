"""Persistence for registrations, membership history and stable block metadata."""

from sqlalchemy import Column, Integer, String, Text, Boolean, ForeignKey, Index, text
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
    has_draft = Column(Boolean, nullable=False, default=True)
    revision = Column(Integer, nullable=False, default=1)
    placeholder = Column(Boolean, nullable=False, default=False)
    deleted = Column(Boolean, nullable=False, default=False)
    created_at = Column(String, nullable=False)
    # Who reads a block guide: "block" — its members, leads and the chair's team; "everyone" —
    # every active participant (owner, 2026-10-25). Other materials read to everyone.
    audience = Column(String, nullable=False, default="block", server_default="block")


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
