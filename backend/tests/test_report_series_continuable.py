"""GET /report-series/continuable is the series field of the event and subevent forms.

The reference is what the field used to assemble (PB-11): GET /report-series,
GET /events, GET /seasons, GET /events/{parent}/subevents and the subevents of every
earlier instance of the parent's series. For every reader and parent the endpoint must
list the same series in the same order with the same latest instance; a subevent the
reader cannot open (its report_series_id is masked there) never names an instance.
"""
from contextlib import contextmanager
from datetime import timedelta

import pytest
from sqlalchemy import event

from database import db, engine, SeasonORM
from test_event_workspace import ok, setup_event  # noqa: F401


def get(client, actor, path, **params):
    return ok(client.get('/api' + path, headers=actor.headers, params=params))


def reference(client, actor, parent_id=None):
    series = get(client, actor, '/report-series')['items']
    events = get(client, actor, '/events')['items']
    seasons = {s['season_id']: s for s in get(client, actor, '/seasons')['items']}
    if parent_id is None:
        instances, used = events, set()
        series = [x for x in series if x['owner_kind'] == 'event']
    else:
        parent = get(client, actor, '/events/' + parent_id)
        instances = [dict(sub, season_id=e['season_id']) for e in events
                     if e['report_series_id'] == parent['report_series_id'] and e['event_id'] != parent_id
                     for sub in get(client, actor, '/events/' + e['event_id'] + '/subevents')['items']]
        used = {sub['report_series_id'] for sub in get(client, actor, '/events/' + parent_id + '/subevents')['items']
                if sub['report_series_id']}
        series = [x for x in series if x['owner_kind'] == 'subevent' and x['parent_series_id'] == parent['report_series_id']]
    order = lambda i: seasons.get(i['season_id'], {}).get('sequence_number') or 0  # noqa: E731
    items = []
    for x in series:
        if x['series_id'] in used:
            continue
        mine = sorted((i for i in instances if i['report_series_id'] == x['series_id']), key=lambda i: -order(i))
        latest = mine[0] if mine else None
        items.append(dict(x, latest=dict(title=latest['title'], season_id=latest['season_id'],
                                         season_title=seasons[latest['season_id']]['title']) if latest else None))
    return items


def continuable(client, actor, parent_id=None):
    body = get(client, actor, '/report-series/continuable', **({'parent_event_id': parent_id} if parent_id else {}))
    assert body['next_cursor'] is None
    return body['items']


def create_event(client, chair, season_id, title, series_id=None, leader=None):
    created = ok(client.post('/api/events', headers=chair.headers, json={
        'season_id': season_id, 'title': title, 'description': '',
        **({'report_series_id': series_id} if series_id else {})}))
    if leader is not None:
        created = ok(client.put('/api/events/' + created['event_id'] + '/leaders', headers=chair.headers,
                                json={'expected_revision': created['revision'], 'user_ids': [leader.user_id]}))
    return created


def create_sub(client, chair, event_id, title, series_id=None):
    return ok(client.post('/api/events/' + event_id + '/subevents', headers=chair.headers, json={
        'title': title, 'description': 'PRIVATE ' + title, **({'report_series_id': series_id} if series_id else {})}))


@pytest.fixture
def series_world(client, setup_event, superuser, make_user):
    """Season 1 (open): the festival E1 led by `head` with its child and a second team.
    Season 2 (closed): two more festival instances, E2 led by `other_head`; their subevents
    continue both child series and start one more (CS3) in each of the two.
    Season 3 (planned): E3 led by `head` continues the festival and its first child series.
    An unrelated event E4 in season 1 has a series and a subevent of its own."""
    w = setup_event
    chair, other_head = superuser, make_user()
    e1, child = w['event'], w['child']
    second = create_sub(client, chair, e1['event_id'], 'Second team')
    season2 = ok(client.post('/api/seasons', headers=chair.headers, json={
        'title': 'Season two', 'type': 'winter_spring', 'starts_at': (w['now'] + timedelta(days=100)).isoformat(),
        'ends_at': (w['now'] + timedelta(days=250)).isoformat()}))
    e2 = create_event(client, chair, season2['season_id'], 'Festival two', e1['report_series_id'], other_head)
    create_sub(client, chair, e2['event_id'], 'Child two', child['report_series_id'])
    create_sub(client, chair, e2['event_id'], 'Second two', second['report_series_id'])
    only = create_sub(client, chair, e2['event_id'], 'Only in two')
    e2b = create_event(client, chair, season2['season_id'], 'Festival two bis', e1['report_series_id'])
    create_sub(client, chair, e2b['event_id'], 'Only in two bis', only['report_series_id'])
    with db._session() as s:
        s.get(SeasonORM, season2['season_id']).state = 'closed'
        s.commit()
    season3 = ok(client.post('/api/seasons', headers=chair.headers, json={
        'title': 'Season three', 'type': 'summer_autumn', 'starts_at': (w['now'] + timedelta(days=300)).isoformat(),
        'ends_at': (w['now'] + timedelta(days=450)).isoformat()}))
    e3 = create_event(client, chair, season3['season_id'], 'Festival three', e1['report_series_id'], w['head'])
    create_sub(client, chair, e3['event_id'], 'Child three', child['report_series_id'])
    e4 = create_event(client, chair, w['season']['season_id'], 'Unrelated')
    create_sub(client, chair, e4['event_id'], 'Unrelated team')
    return dict(w, chair=chair, other_head=other_head, e1=e1, e2=e2, e2b=e2b, e3=e3, e4=e4, second=second, only=only,
                seasons=dict(one=w['season'], two=season2, three=season3))


def readers(w):
    return [w['chair'], w['head'], w['other_head'], w['lead'], w['organizer'], w['outsider'], w['curator']]


def test_continuable_equals_what_the_field_assembled_from_the_dtos(client, series_world):
    w = series_world
    for actor in readers(w):
        for parent in (None, w['e1'], w['e2'], w['e3'], w['e4']):
            parent_id = parent['event_id'] if parent else None
            assert continuable(client, actor, parent_id) == reference(client, actor, parent_id), (actor, parent_id)


def test_the_latest_instance_and_used_series_per_reader(client, series_world):
    w = series_world
    label = lambda items: {x['title']: x['latest'] and (x['latest']['title'], x['latest']['season_title'])  # noqa: E731
                           for x in items}
    # The chair: the first child series is used in E3; the latest instances are in season two,
    # the earlier of two equal seasons first.
    assert label(continuable(client, w['chair'], w['e3']['event_id'])) == {
        'Second team': ('Second two', 'Season two'), 'Only in two': ('Only in two', 'Season two')}
    # The festival head cannot open season two's subevents: no instance is named from there.
    head = continuable(client, w['head'], w['e3']['event_id'])
    assert label(head) == {'Second team': ('Second team', 'Event workspace'), 'Only in two': None}
    assert 'two' not in str([x['latest'] for x in head])
    # A new event continues any event series; the latest festival is in season three.
    events = label(continuable(client, w['chair']))
    assert events['Public festival'] == ('Festival three', 'Season three') and events['Unrelated'] == ('Unrelated', 'Event workspace')
    # Readers of no series history get nothing, also nothing private.
    for actor in (w['outsider'], w['organizer'], w['curator']):
        for parent in (None, w['e1']['event_id'], w['e3']['event_id']):
            assert continuable(client, actor, parent) == []


def test_unknown_parent_and_anonymous(client, series_world):
    w = series_world
    r = client.get('/api/report-series/continuable', headers=w['chair'].headers, params={'parent_event_id': 'missing'})
    assert r.status_code == 404
    assert client.get('/api/report-series/continuable').status_code == 401


@contextmanager
def sql_calls():
    calls = []
    def count(_connection, _cursor, statement, _parameters, _context, _many):
        calls.append(statement)
    event.listen(engine, 'before_cursor_execute', count)
    try:
        yield calls
    finally:
        event.remove(engine, 'before_cursor_execute', count)


@pytest.mark.parametrize('who', ['chair', 'head', 'outsider', 'organizer'])
def test_more_instances_of_the_series_add_no_statements(client, series_world, who):
    w = series_world
    actor, parent_id = w[who], w['e3']['event_id']
    continuable(client, actor, parent_id)
    with sql_calls() as before:
        first = continuable(client, actor, parent_id)
    # Four more festival instances in season one, each with both continued child teams.
    for i in range(4):
        extra = create_event(client, w['chair'], w['seasons']['one']['season_id'], f'Festival extra {i}',
                             w['e1']['report_series_id'], w['head'])
        create_sub(client, w['chair'], extra['event_id'], f'Child extra {i}', w['child']['report_series_id'])
        create_sub(client, w['chair'], extra['event_id'], f'Second extra {i}', w['second']['report_series_id'])
    with sql_calls() as after:
        second = continuable(client, actor, parent_id)
    assert [x['series_id'] for x in second] == [x['series_id'] for x in first]
    assert len(after) <= len(before) <= 40, (len(before), len(after))
