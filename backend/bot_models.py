"""Additive HereBot persistence (backend/docs/BOT_API.md, stages 1 and 2).

Imported by database before create_all. The bot's own data stays in its PostgreSQL; the
site keeps the last report's state, the bot's grouped log errors and, from stage 2, the VK
link of an account with its one-time codes. Times are ISO 8601 UTC strings with `Z`, whole
seconds, so they compare as text.
"""
from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Text
from database import Base


class BotStatusORM(Base):
    """One row (id 1): the last accepted report and the last heartbeat."""
    __tablename__ = "bot_status"
    id = Column(Integer, primary_key=True)
    boot_id = Column(String, nullable=True)
    report_id = Column(String, nullable=True)  # a repeat of this report changes nothing
    started_at = Column(String, nullable=True)  # the bot process start, from the heartbeat
    last_seen_at = Column(String, nullable=True)  # server time of the last accepted report
    heartbeat_json = Column(Text, nullable=True)
    updated_at = Column(String, nullable=True)  # server time the heartbeat was stored
    cleaned_at = Column(String, nullable=True)  # the last retention pass over bot_errors


class BotErrorORM(Base):
    """One group of bot log records (WARNING and above) per fingerprint."""
    __tablename__ = "bot_errors"
    fingerprint = Column(String, primary_key=True)
    level = Column(String, nullable=False)
    logger = Column(String, nullable=False, default="")
    location = Column(String, nullable=False, default="")  # `where` on the wire
    message = Column(Text, nullable=False, default="")
    traceback = Column(Text, nullable=True)
    count = Column(Integer, nullable=False, default=0)
    first_at = Column(String, nullable=False)
    last_at = Column(String, nullable=False, index=True)


class BotLinkORM(Base):
    """The VK of an account, confirmed by the bot with a code. Its state is copied to
    users.bot_link_state in the same transaction (bot_api.save_link)."""
    __tablename__ = "bot_links"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    vk_user_id = Column(Integer, nullable=False, unique=True)
    messages_allowed = Column(Boolean, nullable=False)
    messages_at = Column(String, nullable=False)  # the bot's time of the value: later events only
    token_status = Column(String, nullable=False)  # ok, missing, invalid, unknown
    token_at = Column(String, nullable=False)
    linked_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)


class BotLinkCodeORM(Base):
    """A one-time link code: only its SHA-256 is kept. A new code of the account deletes its
    other codes and every expired one."""
    __tablename__ = "bot_link_codes"
    code_hash = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=False, index=True)
    created_at = Column(String, nullable=False)
    expires_at = Column(String, nullable=False, index=True)
    used_at = Column(String, nullable=True)
    used_vk_user_id = Column(Integer, nullable=True)  # a repeat by the same VK answers the same
