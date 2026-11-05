"""Additive HereBot persistence (backend/docs/BOT_API.md, stages 1, 2, 4 and 5).

Imported by database before create_all. The bot's own data stays in its PostgreSQL; the
site keeps the last report's state, the bot's grouped log errors, from stage 2 the VK link
of an account with its one-time codes, from stage 4 the broadcasts with their batches and
recipients and from stage 5 the console's commands and its pause. Times of stages 1 and 2
and of the pause are ISO 8601 UTC strings with `Z`, whole seconds; those of stages 4 and 5
have microseconds and `+00:00` (bot_link.iso), as the stage 3 queue. Each kind compares as
text.
"""
from sqlalchemy import Boolean, Column, ForeignKey, Index, Integer, String, Text, text
from database import Base


class BotStatusORM(Base):
    """One row (id 1): the last accepted report and the last heartbeat; from stage 5 also the
    console's pause (database._ensure_sqlite_bot_console adds its columns to an old table)."""
    __tablename__ = "bot_status"
    id = Column(Integer, primary_key=True)
    boot_id = Column(String, nullable=True)
    report_id = Column(String, nullable=True)  # a repeat of this report changes nothing
    started_at = Column(String, nullable=True)  # the bot process start, from the heartbeat
    last_seen_at = Column(String, nullable=True)  # server time of the last accepted report
    heartbeat_json = Column(Text, nullable=True)
    updated_at = Column(String, nullable=True)  # server time the heartbeat was stored
    cleaned_at = Column(String, nullable=True)  # the last retention pass over bot_errors
    # Stage 5: the console paused sending (GET /work hands out no deliveries or batches).
    paused = Column(Boolean, nullable=False, default=False, server_default=text("0"))
    paused_at = Column(String, nullable=True)  # NULL while not paused
    paused_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)  # NULL after retention


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


class BroadcastORM(Base):
    """A broadcast (stage 4): `sending` while a recipient is pending, then `done`, or
    `cancelled` by a sender before that. The author is NULL after the account's retention."""
    __tablename__ = "broadcasts"
    broadcast_id = Column(String, primary_key=True)
    author_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    text = Column(Text, nullable=False)
    state = Column(String, nullable=False)  # sending, done, cancelled
    idempotency_key = Column(String, nullable=True)  # GL-07, as POST /tasks (request_keys)
    request_hash = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)
    cancelled_at = Column(String, nullable=True)
    cancelled_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    __table_args__ = (Index("ux_broadcasts_idempotency_key", "idempotency_key", unique=True),
                      Index("ix_broadcasts_list", "created_at", "broadcast_id"))


class BroadcastBatchORM(Base):
    """Up to 100 recipients the bot sends in one messages.send: `pending` until the bot's
    report leaves none of them pending (`done`), or `cancelled`, `expired` after 24 hours."""
    __tablename__ = "broadcast_batches"
    batch_id = Column(String, primary_key=True)  # <broadcast_id>-0000, in the recipients' user_id order
    broadcast_id = Column(String, ForeignKey("broadcasts.broadcast_id"), nullable=False, index=True)
    state = Column(String, nullable=False)
    attempts = Column(Integer, nullable=False, default=0)  # reports that named it while pending
    next_attempt_at = Column(String, nullable=False)
    created_at = Column(String, nullable=False)  # the broadcast's
    updated_at = Column(String, nullable=False)
    # The bot's idle poll reads this index only (BOT_API.md, «Рассылки», «Выдача в GET /work»).
    __table_args__ = (Index("ix_broadcast_batches_pending", "next_attempt_at", "created_at",
                            sqlite_where=text("state = 'pending'")),)


class BroadcastRecipientORM(Base):
    """One account in the list fixed at send, with the VK its link had then."""
    __tablename__ = "broadcast_recipients"
    broadcast_id = Column(String, ForeignKey("broadcasts.broadcast_id"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    batch_id = Column(String, nullable=False, index=True)
    vk_user_id = Column(Integer, nullable=False)
    state = Column(String, nullable=False)  # pending, sent, denied, failed, cancelled, expired
    vk_message_id = Column(Integer, nullable=True)
    error_code = Column(String, nullable=True)  # VK's code or the bot's word, as text
    updated_at = Column(String, nullable=False)


class BotCommandORM(Base):
    """A console command (stage 5): `pending` until the bot reports `running` or its result
    (`done`, `failed`, `unsupported`); `expired` when pending for 10 minutes or running for 30
    since created_at. The requester's fields are NULL after the account's retention."""
    __tablename__ = "bot_commands"
    command_id = Column(String, primary_key=True)  # 32 hex, secrets.token_hex(16)
    kind = Column(String, nullable=False)  # restart, logs, updates_check, update, rollback
    args_json = Column(Text, nullable=False)
    state = Column(String, nullable=False)
    code = Column(String, nullable=True)  # the bot's machine reason, at most 64 characters
    message = Column(Text, nullable=True)  # the bot's words for a person, at most 500 characters
    output = Column(Text, nullable=True)  # the log lines of `logs`, wiped after 24 hours
    requested_by_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    requested_vk_user_id = Column(Integer, nullable=True)  # the VK of the requester's link then
    requested_name = Column(String, nullable=True)  # the requester's site display name then
    idempotency_key = Column(String, nullable=True)  # GL-07, as POST /tasks (request_keys)
    request_hash = Column(String, nullable=True)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)
    finished_at = Column(String, nullable=True)  # when the result came
    # The bot's poll checks the open commands over the partial index only (BOT_API.md,
    # «Консоль бота», «Выдача в GET /work»); the console's history pages over the second.
    __table_args__ = (Index("ux_bot_commands_idempotency_key", "idempotency_key", unique=True),
                      Index("ix_bot_commands_open", "created_at", "command_id", sqlite_where=text("state IN ('pending', 'running')")),
                      Index("ix_bot_commands_list", "created_at", "command_id"))
