"""Additive HereBot persistence (backend/docs/BOT_API.md, stage 1).

Imported by database before create_all. The bot's own data stays in its PostgreSQL; the
site keeps only the last report's state and the bot's grouped log errors. Times are
ISO 8601 UTC strings with `Z`, so they compare as text.
"""
from sqlalchemy import Column, Integer, String, Text
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
