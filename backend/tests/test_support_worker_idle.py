"""PB-35: an idle support worker tick opens no write transaction; due work still runs."""
from datetime import timedelta

from sqlalchemy import event

import support
from database import db, engine
from material_retention import purge_expired
from support_models import FeedbackORM, FeedbackRateORM
from support import now


def _statements(run):
    seen = []

    def count(_conn, _cursor, statement, *_args):
        seen.append(statement.split()[0].upper())
    event.listen(engine, "before_cursor_execute", count)
    try:
        run()
    finally:
        event.remove(engine, "before_cursor_execute", count)
    return seen


def test_idle_tick_reads_only(make_user):
    def tick():
        support.retry_pending()
        purge_expired(dry_run=False)
        purge_expired()
    seen = _statements(tick)
    assert seen and set(seen) == {"SELECT"}, seen


def test_due_outbox_work_still_runs(make_user):
    actor = make_user()
    stamp = now()
    with db._session() as s:
        s.add(FeedbackORM(report_id="idle-expired", user_id=actor.user_id, kind="bug", title="T", body="B", contact="c",
                          diagnostics_json="{}", idempotency_key="idle-1", request_hash="h1", created_at=stamp.isoformat(),
                          diagnostics_expires_at=(stamp - timedelta(days=1)).isoformat(), state="withdrawn", revision=1, attempts=0))
        s.add(FeedbackRateORM(key="idle-rate", window=int(stamp.timestamp()) // 60 - 5000, count=1))
        s.commit()
    seen = _statements(support.retry_pending)
    assert "BEGIN" in seen and "UPDATE" in seen and "DELETE" in seen
    with db._session() as s:
        report = s.get(FeedbackORM, "idle-expired")
        assert report.diagnostics_json is None and report.contact is None
        assert s.get(FeedbackRateORM, "idle-rate") is None
    # Nothing left to do: the next tick is read only again.
    assert set(_statements(support.retry_pending)) == {"SELECT"}
