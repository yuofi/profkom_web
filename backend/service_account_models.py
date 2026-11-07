"""Tables of the service (root) account's sign-in (service_account.py, docs/SERVICE_ACCOUNT.md)."""

from sqlalchemy import Column, Integer, String

from database import Base


class ServiceLoginStateORM(Base):
    """One row: failed service-account sign-ins in a row since the last success."""
    __tablename__ = "service_login_state"
    state_id = Column(Integer, primary_key=True)
    failures = Column(Integer, nullable=False, default=0, server_default="0")
    last_failed_at = Column(String, nullable=True)


class ServiceLoginThrottleORM(Base):
    """Failed service-account sign-ins per client address (a salted hash) in a fixed window."""
    __tablename__ = "service_login_throttle"
    key = Column(String, primary_key=True)
    window = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False, default=0)
