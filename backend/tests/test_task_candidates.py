"""Mention and assignee candidates: one batch read decision, the same as task_read per person."""
from database import db, TaskORM, UserORM
import access
from task_queues import task_readers, _task_read
from test_v13_tracker import work  # noqa: F401
from test_tracker_queues import make_queue, request_grant, create_in, legacy_queue
from test_tracker_control_guards import control_for
from test_website_support import setup_support, report, ok


def test_task_view_policy_is_the_one_mirrored_by_batch_readers():
    # task_readers mirrors these relations source by source; a policy change must revisit it.
    assert access.roles_for("task.view") == access.TACHKI | {access.HR_MASTER, access.HR_DEPUTY, access.HR_TRACKER_READER,
        access.BLOCK_HR, access.SUBEVENT_HR, access.EVENT_TEAM} | access.AREA_TEAM


def test_batch_readers_match_task_read_for_every_person_and_queue_kind(client, work, superuser, make_user):
    w = work; block_task = w['task']['task_id']
    comment = client.post('/api/tasks/' + block_task + '/comments', headers=w['member'].headers,
                          json={'content': 'Нужна помощь', 'mentioned_user_ids': [w['outside'].user_id]})
    assert comment.status_code == 200, comment.text
    request = client.get('/api/tasks/' + block_task + '/mentions', headers=w['master'].headers).json()['items'][0]
    approved = client.post('/api/tasks/' + block_task + '/mentions/' + request['request_id'] + '/approve',
                           headers=w['master'].headers, json={'expected_revision': request['revision']})
    assert approved.status_code == 200, approved.text
    private = make_queue(client, w, key='PRIV', private=True); private_task = create_in(client, w, private, title='Закрытая', assignees=[])['task_id']
    member_of = make_user(); request_grant(client, private, member_of, w['master'])
    independent = legacy_queue(client, w['outside'], 'INDEP')
    created = client.post('/api/tasks', headers=w['outside'].headers, json={'queue_id': independent['queue_id'], 'season_id': w['task']['season_id'],
                          'title': 'Без команды', 'description': '', 'deadline_at': w['task']['deadline_at']})
    assert created.status_code == 200, created.text
    control, _ = control_for(w)
    support_master, _ = setup_support(client, superuser, make_user); author = make_user()
    ticket = ok(report(client, author)[0])['task_id']
    archived = make_user()
    with db._session() as session:
        session.get(UserORM, archived.user_id).account_state = 'archived'; session.commit()
    readers = {}
    with db._session() as session:
        people = [row.user_id for row in session.query(UserORM)]
        for task_id in (block_task, private_task, created.json()['task_id'], control, ticket):
            task = session.get(TaskORM, task_id)
            readers[task_id] = task_readers(session, task, people)
            assert readers[task_id] == {uid for uid in people if _task_read(session, task, uid)}, task_id
    assert {w['master'].user_id, w['member'].user_id, w['outside'].user_id, superuser.user_id} <= readers[block_task]
    assert member_of.user_id in readers[private_task] and w['member'].user_id not in readers[private_task]
    assert readers[created.json()['task_id']] >= {w['member'].user_id, author.user_id} and archived.user_id not in readers[created.json()['task_id']]
    assert w['master'].user_id in readers[control] and w['outside'].user_id not in readers[control]
    assert readers[ticket] == {author.user_id, support_master.user_id}


def test_candidates_mark_who_can_be_assigned_and_closed_tasks_offer_only_readers(client, work, superuser, make_user):
    w = work; path = '/api/tasks/' + w['task']['task_id']

    def offered(actor, task_path=path):
        response = client.get(task_path + '/mention-candidates', headers=actor.headers)
        assert response.status_code == 200, response.text
        return {row['user_id']: row['can_assign'] for row in response.json()['items']}

    by_author = offered(w['master'])
    assert w['outside'].user_id in by_author and all(by_author.values())
    by_chair = offered(superuser)
    assert by_chair[w['master'].user_id] and by_chair[w['member'].user_id] and by_chair[superuser.user_id]
    assert by_chair[w['outside'].user_id] is False
    task = client.get(path, headers=superuser.headers).json()
    refused = client.post(path + '/assignees/' + str(w['outside'].user_id) + '/add', headers=superuser.headers, json={'expected_revision': task['revision']})
    assert refused.status_code == 403 and refused.json()['detail']['code'] == 'task_access_approval_required'
    added = client.post(path + '/assignees/' + str(w['master'].user_id) + '/add', headers=superuser.headers, json={'expected_revision': task['revision']})
    assert added.status_code == 200, added.text

    control, _ = control_for(w)
    in_control = offered(superuser, '/api/tasks/' + control)
    assert w['master'].user_id in in_control and w['outside'].user_id not in in_control

    support_master, _ = setup_support(client, superuser, make_user); author = make_user()
    ticket = '/api/tasks/' + ok(report(client, author)[0])['task_id']
    in_ticket = offered(author, ticket)
    assert set(in_ticket) == {author.user_id, support_master.user_id} and all(in_ticket.values())
    mention = client.post(ticket + '/comments', headers=author.headers, json={'content': 'Призыв читателя', 'mentioned_user_ids': [support_master.user_id]})
    assert mention.status_code == 200, mention.text
    hidden = client.post(ticket + '/comments', headers=author.headers, json={'content': 'Посторонний', 'mentioned_user_ids': [w['outside'].user_id]})
    assert hidden.status_code == 403
