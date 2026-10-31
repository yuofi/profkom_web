"""Season marks (owner, 2026-10-31): an open or summarizing season's mark answers to the
participant's own previous marks, not to the version of the whole summary (PB-16)."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from database import SeasonDecisionORM, db
from errors import Conflict
from test_v13_tracker import work
from test_v13_season_integrity import accept, close


def put(client, actor, sid, target, body):
    return client.put(f"/api/seasons/{sid}/summary/decisions/{target}", headers=actor.headers, json=body)


def marks(summary, target):
    return next(row for row in summary["rows"] if row["user"]["user_id"] == target)["decisions"]


def summary(client, actor, sid):
    response = client.get(f"/api/seasons/{sid}/summary", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("state", ["open", "summarizing"])
def test_mark_survives_accounting_elsewhere_and_answers_to_its_own_marks(client, work, superuser, state):
    sid, target = work["season"]["season_id"], work["master"].user_id
    if state == "summarizing":
        begun = client.post(f"/api/seasons/{sid}/begin-summary", headers=superuser.headers, json={"expected_revision": 2})
        assert begun.status_code == 200, begun.text
    seen = summary(client, superuser, sid)
    accept(client, work)  # the master accepts the member's work meanwhile: the summary version moves
    moved = summary(client, superuser, sid)["version"]
    assert moved > seen["version"]
    # An old tab without the participant's marks keeps the summary version check.
    legacy = put(client, superuser, sid, target, {"expected_version": seen["version"], "decisions": ["nice"]})
    assert legacy.status_code == 409 and legacy.json()["detail"]["code"] == "revision_conflict", legacy.text
    saved = put(client, superuser, sid, target, {"expected_version": seen["version"], "expected_decisions": marks(seen, target),
        "decisions": ["nice", "kick_warning"]})
    assert saved.status_code == 200, saved.text
    assert sorted(marks(saved.json(), target)) == ["kick_warning", "nice"] and saved.json()["version"] == moved + 1
    # The marks compare in any order.
    again = put(client, superuser, sid, target, {"expected_version": seen["version"], "expected_decisions": ["kick_warning", "nice"],
        "decisions": ["kick"]})
    assert again.status_code == 200, again.text
    # A stale view of this participant's marks is refused, even with the fresh summary version.
    stale = put(client, superuser, sid, target, {"expected_version": again.json()["version"], "expected_decisions": ["nice", "kick_warning"],
        "decisions": ["golden_red_bull"]})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "revision_conflict", stale.text
    current = summary(client, superuser, sid)
    assert marks(current, target) == ["kick"] and current["version"] == again.json()["version"]
    unknown = put(client, superuser, sid, target, {"expected_version": current["version"], "expected_decisions": ["promoted"], "decisions": []})
    assert unknown.status_code == 422, unknown.text


def test_closed_season_marks_still_need_the_exact_summary_version(client, work, superuser):
    accept(client, work)
    frozen = close(client, work, superuser)
    sid, target = work["season"]["season_id"], work["member"].user_id
    stale = put(client, superuser, sid, target, {"expected_version": frozen["version"] - 1, "expected_decisions": marks(frozen, target),
        "decisions": ["nice"], "reason": "Проверено"})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "revision_conflict", stale.text
    saved = put(client, superuser, sid, target, {"expected_version": frozen["version"], "expected_decisions": marks(frozen, target),
        "decisions": ["nice"], "reason": "Проверено"})
    assert saved.status_code == 200, saved.text
    assert marks(saved.json(), target) == ["nice"] and saved.json()["version"] == frozen["version"] + 1
    # The participant's marks are current, the summary version is not: a closed season refuses.
    behind = put(client, superuser, sid, target, {"expected_version": frozen["version"], "expected_decisions": ["nice"],
        "decisions": ["kick"], "reason": "Проверено"})
    assert behind.status_code == 409 and behind.json()["detail"]["code"] == "revision_conflict", behind.text


def test_two_clicks_on_the_same_marks_save_exactly_one(client, work, superuser, monkeypatch):
    import season_summaries
    sid, target = work["season"]["season_id"], work["member"].user_id
    version = summary(client, superuser, sid)["version"]
    read = db.get_season_summary

    def slow(*args):
        result = read(*args)
        time.sleep(0.3)  # a check made outside the write transaction would pass for both clicks here
        return result

    monkeypatch.setattr(db, "get_season_summary", slow)
    start = threading.Barrier(2)

    def click(values):
        start.wait()
        try:
            return season_summaries.decisions(sid, target, values, version, None, superuser.user_id, [])
        except Conflict as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(click, (["nice"], ["kick"])))
    monkeypatch.undo()
    won = [result for result in results if not isinstance(result, Conflict)]
    lost = [result for result in results if isinstance(result, Conflict)]
    assert len(won) == 1 and len(lost) == 1 and lost[0].code == "revision_conflict", results
    winner = next(row.decisions for row in won[0].rows if row.user.user_id == target)
    assert marks(summary(client, superuser, sid), target) == winner
    with db._session() as session:
        assert session.query(SeasonDecisionORM).filter_by(season_id=sid, user_id=target).count() == 1
