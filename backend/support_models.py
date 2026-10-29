"""Private feedback intake and explicitly configured website support."""
from sqlalchemy import Column, String, Text, Integer, Boolean, ForeignKey, UniqueConstraint
from database import Base


class SupportConfigORM(Base):
    __tablename__ = "support_config"
    config_id = Column(Integer, primary_key=True)
    block_id = Column(String, ForeignKey("block_metadata.block_id"), nullable=True)
    queue_id = Column(String, ForeignKey("task_queues.queue_id"), nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    system_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)


class SupportStaffORM(Base):
    __tablename__ = "support_staff"
    user_id = Column(Integer, ForeignKey("users.user_id"), primary_key=True)
    active = Column(Boolean, nullable=False, default=True)
    granted_by = Column(Integer, nullable=True)
    granted_at = Column(String, nullable=False)


class FeedbackORM(Base):
    __tablename__ = "feedback_reports"
    report_id = Column(String, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True, index=True)
    task_id = Column(String, ForeignKey("tasks.task_id"), nullable=True, unique=True)
    kind = Column(String, nullable=False)
    title = Column(String, nullable=False)
    body = Column(Text, nullable=False)
    contact = Column(Text, nullable=True)
    diagnostics_json = Column(Text, nullable=True)
    screenshot = Column(Text, nullable=True)
    idempotency_key = Column(String, nullable=False, unique=True)
    request_hash = Column(String, nullable=False)
    created_at = Column(String, nullable=False)
    diagnostics_expires_at = Column(String, nullable=False)
    state = Column(String, nullable=False, default="pending")
    revision = Column(Integer, nullable=False, default=1)
    attempts = Column(Integer, nullable=False, default=0)


class SupportNoteORM(Base):
    __tablename__ = "support_notes"
    note_id = Column(String, primary_key=True)
    report_id = Column(String, ForeignKey("feedback_reports.report_id"), nullable=False, index=True)
    author_user_id = Column(Integer, ForeignKey("users.user_id"), nullable=True)
    body = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)


class FeedbackRateORM(Base):
    __tablename__ = "feedback_rate_limits"
    key = Column(String, primary_key=True)
    window = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False, default=0)


def upgrade_tasks(engine):
    """Nullable planning dates for service tickets, preserving rows, FKs and indexes.

    SQLite cannot remove NOT NULL with ALTER COLUMN. Rebuild only this table in
    one transaction before the application starts. No identity/date is invented.
    """
    from sqlalchemy import text
    import re
    with engine.connect() as connection:
        info = list(connection.execute(text("PRAGMA table_info(tasks)")))
        if not any(row[1] in {"season_id", "deadline_at"} and row[3] for row in info):
            return
        definition = connection.execute(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'" )).scalar_one()
        objects = [row[0] for row in connection.execute(text("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='tasks' AND sql IS NOT NULL ORDER BY type,name"))]
        previous_violations = set(connection.execute(text("PRAGMA foreign_key_check")).fetchall())
        fk = connection.execute(text("PRAGMA foreign_keys")).scalar()
        connection.commit()
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        columns = ",".join('"' + row[1].replace('"', '""') + '"' for row in info)
        definition = re.sub(r'CREATE TABLE\s+["`\[]?tasks["`\]]?', 'CREATE TABLE tasks_support_upgrade', definition, count=1, flags=re.I)
        for name in ("season_id", "deadline_at"):
            definition = re.sub(r'((?:["`\[]?' + name + r'["`\]]?)\s+\w+(?:\([^)]*\))?)\s+NOT NULL', r'\1', definition, flags=re.I)
        try:
            with connection.begin():
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                connection.exec_driver_sql(definition)
                connection.exec_driver_sql(f"INSERT INTO tasks_support_upgrade ({columns}) SELECT {columns} FROM tasks")
                connection.exec_driver_sql("DROP TABLE tasks")
                connection.exec_driver_sql("ALTER TABLE tasks_support_upgrade RENAME TO tasks")
                for sql in objects:
                    connection.exec_driver_sql(sql)
                if set(connection.execute(text("PRAGMA foreign_key_check")).fetchall()) != previous_violations:
                    raise RuntimeError("Task planning migration changed foreign key integrity")
        finally:
            connection.exec_driver_sql(f"PRAGMA foreign_keys={int(bool(fk))}")
            connection.commit()
