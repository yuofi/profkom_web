"""Calendar entries read subevents and schedule metadata once per request.

The reference is workspace.calendar called directly (no read UOW: the original
per-event subevent query and per-object metadata reads). The HTTP calendar must
contain exactly those items for every reader, window and mine/watching choice.
"""
from datetime import timedelta

import pytest

import workspace
from database import db, SubeventORM
from event_workspace_models import EventWorkspaceMetaORM
from test_event_workspace import ok, setup_event  # noqa: F401


@pytest.fixture
def calendar_world(client, setup_event, superuser):
    w = setup_event
    second = ok(client.post('/api/events/' + w['event']['event_id'] + '/subevents', headers=w['head'].headers,
                            json={'title': 'Second team', 'description': '',
                                  'starts_at': (w['now'] + timedelta(days=1)).isoformat(),
                                  'ends_at': (w['now'] + timedelta(days=2)).isoformat()}))
    legacy = ok(client.post('/api/events/' + w['event']['event_id'] + '/subevents', headers=w['head'].headers,
                            json={'title': 'Legacy team', 'description': ''}))
    other = ok(client.post('/api/events', headers=superuser.headers, json={
        'season_id': w['season']['season_id'], 'title': 'Other event', 'description': '',
        'starts_at': (w['now'] + timedelta(days=1)).isoformat(), 'ends_at': (w['now'] + timedelta(days=3)).isoformat()}))
    with db._session() as s:
        # A legacy subevent without schedule metadata keeps its empty dates.
        row = s.get(EventWorkspaceMetaORM, ('subevent', legacy['subevent_id']))
        if row is not None:
            s.delete(row)
        s.commit()
    return dict(w, second=second, legacy=legacy, other=other, superuser=superuser)


def expected(uid, start, end, **options):
    from workspace import date_range
    lower, upper = date_range(start, end)
    return workspace.calendar(uid, lower, upper, **options)


@pytest.mark.parametrize("mine", [True, False])
def test_calendar_equals_original_per_event_path(client, calendar_world, mine):
    w = calendar_world
    start = (w['now'] - timedelta(days=1)).isoformat()
    end = (w['now'] + timedelta(days=6)).isoformat()
    for actor in (w['superuser'], w['head'], w['lead'], w['organizer'], w['outsider'], w['curator']):
        items = ok(client.get('/api/calendar', headers=actor.headers,
                              params={'from': start, 'to': end, 'mine': str(mine).lower()}))['items']
        reference = expected(actor.user_id, start, end, mine=mine)
        assert [item['id'] for item in items] == [item['id'] for item in reference]
        assert [(i['starts_at'], i['ends_at'], i['all_day']) for i in items] == \
            [(i['starts_at'], i['ends_at'], i['all_day']) for i in reference]
    everything = ok(client.get('/api/calendar', headers=w['outsider'].headers, params={'mine': 'false'}))['items']
    assert 'subevent-' + w['second']['subevent_id'] in {item['id'] for item in everything}
    with db._session() as s:
        assert s.get(EventWorkspaceMetaORM, ('subevent', w['legacy']['subevent_id'])) is None
        assert s.get(SubeventORM, w['legacy']['subevent_id']) is not None
