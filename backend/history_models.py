"""A permanent tombstone does not retain the deleted version's text."""
from sqlalchemy import Column, Integer, String
from database import Base


class HistoryRedactionORM(Base):
    __tablename__ = "history_redactions"
    source_kind = Column(String, primary_key=True)
    source_id = Column(String, primary_key=True)
    original_actor_user_id = Column(Integer, nullable=True)
    redacted_by_user_id = Column(Integer, nullable=True)
    redacted_at = Column(String, nullable=False)

