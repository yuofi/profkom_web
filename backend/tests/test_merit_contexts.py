"""GET /merits/contexts is the merit subset of the block, event and subevent DTOs.

The reference is what the merit forms used to assemble: GET /blocks, GET /events
and GET /events/{id}/subevents for every event. For every reader and season choice
the new endpoint must list the same items in the same order with exactly the merit
capabilities of those DTOs (closed events, closed and planned seasons, hidden
subevents without working access).
"""
from datetime import timedelta

import pytest

from database import db, SeasonORM
from merit_rules import MERIT_CAPS
from models import Block
from test_event_workspace import ok, setup_event  # noqa: F401


def merit(caps):
    return [cap for cap in caps if cap in MERIT_CAPS]


def reference(client, actor, season_id=None):
    blocks = ok(client.get('/api/blocks', headers=actor.headers))
    events = ok(client.get('/api/events', headers=actor.headers, params={'season_id': season_id} if season_id else {}))
    subevents = [sub for event in events['items'] for sub in
                 ok(client.get('/api/events/' + event['event_id'] + '/subevents', headers=actor.headers))['items']]
    return dict(
        blocks=[dict(block_id=b['block_id'], name=b['name'], avatar_url=b['avatar_url'], capabilities=merit(b['capabilities']))
                for b in blocks],
        events=[dict(event_id=e['event_id'], season_id=e['season_id'], title=e['title'], capabilities=merit(e['capabilities']))
                for e in events['items']],
        subevents=[dict(subevent_id=s['subevent_id'], event_id=s['event_id'], title=s['title'],
                        capabilities=merit(s['capabilities'])) for s in subevents])


@pytest.fixture
def merit_world(client, setup_event, superuser, make_user):
    w = setup_event
    master = make_user()
    for name in ('Медиа', 'IT'):
        db.create_block(Block(name=name, master='', is_hr=False))
    blocks = {b['name']: b for b in ok(client.get('/api/blocks', headers=superuser.headers))}
    ok(client.put('/api/blocks/' + blocks['IT']['block_id'] + '/leader', headers=superuser.headers,
                  json={'user_id': master.user_id, 'expected_revision': blocks['IT']['revision']}))
    closed_event = ok(client.post('/api/events', headers=superuser.headers, json={
        'season_id': w['season']['season_id'], 'title': 'Closed festival', 'description': '',
        'starts_at': w['now'].isoformat(), 'ends_at': (w['now'] + timedelta(days=1)).isoformat()}))
    closed_event = ok(client.put('/api/events/' + closed_event['event_id'] + '/leaders', headers=superuser.headers,
                                 json={'expected_revision': closed_event['revision'], 'user_ids': [w['head'].user_id]}))
    ok(client.post('/api/events/' + closed_event['event_id'] + '/subevents', headers=w['head'].headers,
                   json={'title': 'Closed team', 'description': ''}))
    ok(client.post('/api/events/' + closed_event['event_id'] + '/close', headers=superuser.headers,
                   json={'expected_revision': closed_event['revision']}))
    ok(client.post('/api/events/' + w['event']['event_id'] + '/subevents', headers=w['head'].headers,
                   json={'title': 'Second team', 'description': ''}))
    seasons = {}
    for offset, label in ((300, 'closed'), (100, 'planned')):
        season = ok(client.post('/api/seasons', headers=superuser.headers, json={
            'title': label, 'type': 'winter_spring', 'starts_at': (w['now'] + timedelta(days=offset)).isoformat(),
            'ends_at': (w['now'] + timedelta(days=offset + 150)).isoformat()}))
        event = ok(client.post('/api/events', headers=superuser.headers, json={
            'season_id': season['season_id'], 'title': label + ' event', 'description': ''}))
        ok(client.put('/api/events/' + event['event_id'] + '/leaders', headers=superuser.headers,
                      json={'expected_revision': event['revision'], 'user_ids': [w['head'].user_id]}))
        ok(client.post('/api/events/' + event['event_id'] + '/subevents', headers=w['head'].headers,
                       json={'title': label + ' team', 'description': ''}))
        seasons[label] = season
        if label == 'closed':
            # Only one planned season may exist: close this one before the next.
            with db._session() as s:
                s.get(SeasonORM, season['season_id']).state = 'closed'
                s.commit()
    return dict(w, master=master, seasons=seasons, superuser=superuser)


def readers(w):
    return [w['superuser'], w['head'], w['lead'], w['organizer'], w['outsider'], w['curator'], w['master']]


def test_contexts_equal_the_merit_subset_of_the_dtos(client, merit_world):
    w = merit_world
    choices = [None, w['season']['season_id'], w['seasons']['planned']['season_id'], w['seasons']['closed']['season_id']]
    granted = set()
    for actor in readers(w):
        for season_id in choices:
            r = client.get('/api/merits/contexts', headers=actor.headers,
                           params={'season_id': season_id} if season_id else {})
            assert r.status_code == 200, r.text
            assert r.json() == reference(client, actor, season_id)
            granted |= {(kind, cap) for kind in ('blocks', 'events', 'subevents')
                        for item in r.json()[kind] for cap in item['capabilities']}
    # The fixture exercises every merit capability somewhere.
    assert granted == {('blocks', 'create_volunteer_merit'), ('events', 'create_head_merit'),
                       ('subevents', 'create_volunteer_merit')}


def test_contexts_hide_nothing_new_and_need_a_session(client, merit_world):
    w = merit_world
    body = ok(client.get('/api/merits/contexts', headers=w['outsider'].headers))
    assert all(not item['capabilities'] for kind in ('events', 'subevents') for item in body[kind])
    assert 'PRIVATE' not in str(body)
    assert client.get('/api/merits/contexts').status_code == 401
