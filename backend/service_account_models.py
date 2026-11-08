"""Tables of the service (root) account's sign-in (service_account.py, docs/SERVICE_ACCOUNT.md)."""

from sqlalchemy import Column, Integer, String, text

from database import Base


class ServiceLoginStateORM(Base):
    """One row: failed service-account sign-ins in a row since the last success and the
    event key of this streak's one notice (from its third failure)."""
    __tablename__ = "service_login_state"
    state_id = Column(Integer, primary_key=True)
    failures = Column(Integer, nullable=False, default=0, server_default="0")
    last_failed_at = Column(String, nullable=True)
    notice_key = Column(String, nullable=True)


class ServiceLoginThrottleORM(Base):
    """Service-account sign-in attempts per client address (a salted hash) in a fixed window:
    taken before the password is checked, given back by a success."""
    __tablename__ = "service_login_throttle"
    key = Column(String, primary_key=True)
    window = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False, default=0)


def upgrade(engine):
    """Idempotent: notice_key of a state table made before it (a streak without a notice to
    bring up to date starts one)."""
    with engine.begin() as conn:
        names = {r[1] for r in conn.execute(text("PRAGMA table_info(service_login_state)")).fetchall()}
        if names and "notice_key" not in names:
            conn.execute(text("ALTER TABLE service_login_state ADD COLUMN notice_key VARCHAR"))
