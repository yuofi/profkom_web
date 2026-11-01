"""include_deputies adds each leader's deputies as UserRefs; nothing else changes.

Without the parameter the event and subevent responses are byte-identical. With
it every leader gains `deputies` in deputy_user_ids order, built by the same
reference policy as leader.user (an archived deputy keeps the public reference;
a purged one is anonymous), for every reader of the page.
"""
from dataclasses import asdict

import pytest

from database import db, UserORM
from test_event_workspace import ok, setup_event  # noqa: F401


@pytest.fixture
def deputies(client, setup_event, superuser, make_user):
    w = setup_event
    first, second, gone = make_user(surname="Ответзамов"), make_user(surname="Архивов"), make_user(surname="Стёртый")
    event = ok(client.get('/api/events/' + w['event']['event_id'], headers=superuser.headers))
    leader = event['leaders'][0]
    ok(client.put('/api/role-assignments/' + leader['role_assignment_id'] + '/deputies', headers=superuser.headers,
                  json={'user_ids': [second.user_id, first.user_id], 'expected_revision': leader['revision']}))
    child = ok(client.get('/api/subevents/' + w['child']['subevent_id'], headers=superuser.headers))
    leader = child['leaders'][0]
    ok(client.put('/api/role-assignments/' + leader['role_assignment_id'] + '/deputies', headers=superuser.headers,
                  json={'user_ids': [gone.user_id], 'expected_revision': leader['revision']}))
    with db._session() as s:
        s.get(UserORM, second.user_id).account_state = 'archived'
        s.get(UserORM, gone.user_id).account_state = 'purged'
        s.commit()
    return dict(w, superuser=superuser, first=first, second=second, gone=gone)


def reference_refs(ids):
    with db._session() as s:
        return [asdict(db._get_user_ref(s, uid)) for uid in ids]


def paths(w):
    eid, sid = w['event']['event_id'], w['child']['subevent_id']
    return ['/api/events', '/api/events?season_id=' + w['season']['season_id'], '/api/events/' + eid,
            '/api/events/' + eid + '/subevents', '/api/subevents/' + sid]


def leaders_in(body):
    return [leader for item in body.get('items', [body]) for leader in item['leaders']]


def test_deputies_are_an_opt_in_addition(client, deputies):
    w = deputies
    seen = []
    for actor in (w['superuser'], w['head'], w['lead'], w['organizer'], w['outsider'], w['curator']):
        for path in paths(w):
            plain = client.get(path, headers=actor.headers)
            sep = '&' if '?' in path else '?'
            extended = client.get(path + sep + 'include_deputies=true', headers=actor.headers)
            assert plain.status_code == extended.status_code == 200, (path, extended.text)
            body = extended.json()
            for leader in leaders_in(body):
                assert leader.pop('deputies') == reference_refs(leader['deputy_user_ids'])
                seen.append(tuple(leader['deputy_user_ids']))
            assert body == plain.json()
    assert (w['second'].user_id, w['first'].user_id) in seen and (w['gone'].user_id,) in seen


def test_deputy_refs_follow_the_public_reference_policy(client, deputies):
    w = deputies
    event = ok(client.get('/api/events/' + w['event']['event_id'], headers=w['outsider'].headers,
                          params={'include_deputies': 'true'}))
    refs = event['leaders'][0]['deputies']
    assert [r['user_id'] for r in refs] == [w['second'].user_id, w['first'].user_id]
    assert refs[1]['display_name'].startswith('Ответзамов')
    child = ok(client.get('/api/subevents/' + w['child']['subevent_id'], headers=w['outsider'].headers,
                          params={'include_deputies': 'true'}))
    assert child['leaders'][0]['deputies'] == [dict(user_id=None, display_name='Обезличенный участник', avatar_url=None)]
    assert client.get('/api/events/missing?include_deputies=true', headers=w['outsider'].headers).status_code == 404


def test_block_master_deputies_are_an_opt_in_addition(client, superuser, make_user):
    """GET /blocks/{id}?include_deputies=true: the block page names the master's deputies
    without the contacts directory; without the flag, or without a master, nothing changes."""
    from models import Block
    master, first, gone, reader = (make_user(surname=name) for name in ('Мастеров', 'Замблоков', 'Стёртый', 'Читатель'))
    for name in ('Deputies block', 'Masterless block'):
        db.create_block(Block(name=name, master='', is_hr=False))
    blocks = {b['name']: b for b in ok(client.get('/api/blocks', headers=superuser.headers))}
    block = blocks['Deputies block']
    ok(client.put('/api/blocks/' + block['block_id'] + '/leader', headers=superuser.headers,
                  json={'user_id': master.user_id, 'expected_revision': block['revision']}))
    leader = ok(client.get('/api/blocks/' + block['block_id'], headers=superuser.headers))['master']
    ok(client.put('/api/role-assignments/' + leader['role_assignment_id'] + '/deputies', headers=superuser.headers,
                  json={'user_ids': [gone.user_id, first.user_id], 'expected_revision': leader['revision']}))
    with db._session() as s:
        s.get(UserORM, gone.user_id).account_state = 'purged'
        s.commit()
    for actor in (superuser, master, reader):
        for name in ('Deputies block', 'Masterless block'):
            path = '/api/blocks/' + blocks[name]['block_id']
            plain = client.get(path, headers=actor.headers)
            extended = client.get(path, headers=actor.headers, params={'include_deputies': 'true'})
            assert plain.status_code == extended.status_code == 200, extended.text
            body = extended.json()
            if body['master']:
                refs = body['master'].pop('deputies')
                assert refs == reference_refs(body['master']['deputy_user_ids'])
                assert refs[0] == dict(user_id=None, display_name='Обезличенный участник', avatar_url=None)
                assert refs[1]['user_id'] == first.user_id and refs[1]['display_name'].startswith('Замблоков')
            assert body == plain.json()
    assert ok(client.get('/api/blocks/' + blocks['Masterless block']['block_id'], headers=reader.headers,
                         params={'include_deputies': 'true'}))['master'] is None
