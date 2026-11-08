"""A queue shows its team, its event's season and whether a task can be created there now.

A queue has no season of its own (owner 2026-11-08, В8): the hint follows the rule of
database.create_task, readers who do not see the scope see none of it, and the catalogue
reads it for a whole page in a fixed number of statements.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from database import db, engine, SeasonORM, TaskQueueORM
import task_queues
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, request_grant, legacy_queue
from test_website_support import setup_support, ok


PLACE = {'scope_title', 'season', 'task_creation'}


def queue(client, actor, scope, key, private=False):
    return ok(client.post('/api/task-queues', headers=actor.headers, json=dict(name='Очередь '+key, key=key, scope=scope, is_private=private)))


def place(client, actor, queue_id):
    item = ok(client.get('/api/task-queues/'+queue_id, headers=actor.headers))
    return {key: item[key] for key in PLACE}


def set_state(season_id, state):
    with db._session() as session:
        session.get(SeasonORM, season_id).state = state
        session.commit()


def team(client, superuser, season_id):
    event = ok(client.post('/api/events', headers=superuser.headers, json={'season_id': season_id, 'title': 'Фестиваль', 'description': ''}))
    sub = ok(client.post('/api/events/'+event['event_id']+'/subevents', headers=superuser.headers, json={'title': 'Сцена', 'description': ''}))
    return event, sub


def task_in(client, actor, w, item, season_id):
    return client.post('/api/tasks', headers=actor.headers, json={**w['payload'], 'scope': None, 'queue_id': item['queue_id'], 'season_id': season_id, 'assignees': []})


def test_queue_shows_its_team_event_season_and_the_creation_rule_of_tasks(client, work, superuser):
    w = work;season = w['season'];sid = season['season_id']
    event, sub = team(client, superuser, sid)
    by_event = queue(client, superuser, {'kind': 'event', 'id': event['event_id']}, 'FEST')
    by_sub = queue(client, superuser, {'kind': 'subevent', 'id': sub['subevent_id']}, 'STAGE1')
    by_block = make_queue(client, w, key='BLOCKQ')
    by_chair = queue(client, superuser, {'kind': 'chair', 'id': 'chair'}, 'CHAIRQ')
    open_season = {'season_id': sid, 'title': season['title'], 'state': 'open'}
    available = {'available': True, 'reason': None}
    assert place(client, superuser, by_event['queue_id']) == {'scope_title': 'Фестиваль', 'season': open_season, 'task_creation': available}
    assert place(client, superuser, by_sub['queue_id']) == {'scope_title': 'Сцена', 'season': open_season, 'task_creation': available}
    assert place(client, w['master'], by_block['queue_id']) == {'scope_title': 'IT', 'season': None, 'task_creation': available}
    assert place(client, superuser, by_chair['queue_id']) == {'scope_title': 'Работа председателя', 'season': None, 'task_creation': available}
    # The create and update answers carry the same place.
    assert {key: by_sub[key] for key in PLACE} == place(client, superuser, by_sub['queue_id'])

    set_state(sid, 'summarizing')
    assert place(client, superuser, by_event['queue_id'])['task_creation'] == {'available': False, 'reason': 'season_summarizing'}
    assert place(client, superuser, by_sub['queue_id'])['season']['state'] == 'summarizing'
    assert place(client, w['master'], by_block['queue_id'])['task_creation'] == {'available': False, 'reason': 'no_open_season'}
    assert place(client, superuser, by_chair['queue_id'])['task_creation'] == {'available': False, 'reason': 'no_open_season'}
    # The hint says what POST /tasks answers.
    for actor, item in ((superuser, by_event), (w['master'], by_block)):
        refused = task_in(client, actor, w, item, sid)
        assert refused.status_code == 409 and 'season' in refused.json()['detail']['message'].lower(), refused.text

    set_state(sid, 'closed')
    assert place(client, superuser, by_sub['queue_id'])['task_creation'] == {'available': False, 'reason': 'season_closed'}
    # A planned season opens nothing for the closed event, a block or the chair; a legacy
    # independent queue takes tasks in a planned season.
    now = datetime.now(timezone.utc)
    planned = ok(client.post('/api/seasons', headers=superuser.headers, json={'title': 'Следующий', 'type': 'winter_spring',
        'starts_at': (now+timedelta(days=60)).isoformat(), 'ends_at': (now+timedelta(days=120)).isoformat()}))
    assert planned['state'] == 'planned'
    assert place(client, superuser, by_event['queue_id'])['task_creation']['reason'] == 'season_closed'
    assert place(client, w['master'], by_block['queue_id'])['task_creation']['reason'] == 'no_open_season'
    independent = legacy_queue(client, superuser, key='LEGACYPLACE')
    assert {key: independent[key] for key in PLACE} == {'scope_title': None, 'season': None, 'task_creation': available}
    set_state(planned['season_id'], 'closed')
    assert place(client, superuser, independent['queue_id'])['task_creation'] == {'available': False, 'reason': 'no_season'}


def test_locked_queue_shows_no_place_and_a_grant_shows_it(client, work):
    w = work
    private = make_queue(client, w, key='PRIVATEPLACE', private=True)
    for actor in (w['outside'], w['member']):
        item = next(x for x in ok(client.get('/api/task-queues', headers=actor.headers))['items'] if x['queue_id'] == private['queue_id'])
        assert item['access'] == 'locked' and not PLACE & item.keys()
    refused = client.get('/api/task-queues/'+private['queue_id'], headers=w['member'].headers)
    assert refused.status_code == 403 and not PLACE & refused.json()['detail']['fields']['queue'].keys()
    request_grant(client, private, w['member'], w['master'])
    assert place(client, w['member'], private['queue_id'])['scope_title'] == 'IT'


def test_service_queues_carry_no_creation_hint(client, superuser, make_user):
    master, settings = setup_support(client, superuser, make_user)
    with db._session() as session:
        support = session.query(TaskQueueORM).filter_by(key='WEBSUPPORT').one()
        result = task_queues.projection(session, support, master.user_id, include_assignable=False)
    assert result['access'] == 'granted' and 'create_task' not in result['capabilities']
    assert result['task_creation'] is None and result['scope_title'] == 'Technical support fixture'


def test_catalogue_reads_places_in_a_fixed_number_of_statements(client, work, superuser):
    w = work;sid = w['season']['season_id']
    def measured(queues):
        with db._session() as session:
            rows = [session.get(TaskQueueORM, item['queue_id']) for item in queues]
            with patch.object(engine.dialect, 'do_execute', wraps=engine.dialect.do_execute) as sql:
                places = task_queues.queue_bindings(session, rows)
            return sql.call_count, places
    def kinds(suffix):
        event, sub = team(client, superuser, sid)
        return [queue(client, superuser, {'kind': 'event', 'id': event['event_id']}, 'E'+suffix),
                queue(client, superuser, {'kind': 'subevent', 'id': sub['subevent_id']}, 'S'+suffix),
                make_queue(client, w, key='B'+suffix), queue(client, superuser, {'kind': 'chair', 'id': 'chair'}, 'C'+suffix)]
    few = kinds('1')
    many = few + [item for index in range(2, 7) for item in kinds(str(index))]
    small, _ = measured(few)
    large, places = measured(many)
    assert small == large <= 4
    assert {places[item['queue_id']]['scope_title'] for item in many} == {'Фестиваль', 'Сцена', 'IT', 'Работа председателя'}
    # The catalogue asks once per page, not once per queue.
    with patch.object(task_queues, 'queue_bindings', wraps=task_queues.queue_bindings) as bindings:
        catalog = ok(client.get('/api/task-queues', headers=superuser.headers))
    assert bindings.call_count == 1
    assert all(PLACE <= item.keys() for item in catalog['items'] if item['access'] == 'granted')
