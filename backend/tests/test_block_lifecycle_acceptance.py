"""Cross-feature acceptance: delayed archive keeps real task/accounting/file paths usable.

HTTP requests use synthetic people and the real application. VK/S3 are test doubles;
the maintenance clock is advanced explicitly without waiting or external services.
"""
from datetime import datetime, timedelta

from database import db, ContributionORM, GuideORM, TaskORM
from test_v13_tracker import work, close_by_author  # noqa: F401
from test_task_chat_end_to_end import chat_work  # noqa: F401
from test_block_avatars import upload, bind, PNG
from test_kkr_iteration import batch, payload as accounting_payload


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def test_delayed_archive_preserves_files_accounting_and_seasonless_task_workflow(
    client, chat_work, superuser, make_user, mock_s3,
):
    import block_lifecycle

    w = chat_work
    bid = w['block']['block_id']
    path = '/api/blocks/' + bid
    deputy = make_user()
    leadership = ok(client.get('/api/leadership', headers=superuser.headers))
    ok(client.put('/api/leadership/deputies', headers=superuser.headers,
                  json={'expected_revision': leadership['revision'], 'user_ids': [deputy.user_id]}))
    fid = upload(client, w['master'], bid, mock_s3)
    ok(bind(client, w['master'], bid, fid))

    # Establish real accounting before scheduling removal; freeze its persisted rows.
    close_by_author(client, w['task']['task_id'], w['master'])
    values = batch(client, w['task'], w['master'])
    ok(client.put('/api/tasks/' + w['task']['task_id'] + '/accounting-batch',
                  headers=w['master'].headers, json=accounting_payload(values)))
    with db._session() as session:
        contributions = [(r.contribution_id, r.season_id, r.assignment_id, r.score)
                         for r in session.query(ContributionORM).order_by(ContributionORM.contribution_id)]
        guides = {r.guide_id for r in session.query(GuideORM)}

    current = ok(client.get(path, headers=superuser.headers))
    pending = ok(client.post(path + '/deletion-request', headers=superuser.headers,
                             json={'expected_revision': current['revision']}))
    scheduled = ok(client.post(path + '/deletion-request/approve', headers=deputy.headers,
                               json={'expected_revision': pending['revision'],
                                     'request_id': pending['deletion_request']['request_id']}))
    request = scheduled['deletion_request']
    due = datetime.fromisoformat(request['delete_after'].replace('Z', '+00:00'))
    started = datetime.fromisoformat(request['scheduled_at'].replace('Z', '+00:00'))
    assert due - started == timedelta(hours=72)

    # A scheduled deletion does not disable the block or its chat prematurely.
    data = {**w['payload'], 'title': 'Task survives archived block', 'season_id': None,
            'chat_announcement': {'enabled': True, 'binding_revision': w['binding']['revision']}}
    task = ok(client.post('/api/tasks', headers=w['master'].headers, json=data))
    assert task['season_id'] is None and task['chat_announcement']['state'] == 'pending'
    task_path = '/api/tasks/' + task['task_id']
    qid = task['queue']['queue_id']
    refused = client.post(task_path + '/status', headers=w['master'].headers,
                          json={'expected_revision': task['revision'], 'status': 'closed'})
    assert refused.status_code == 409 and refused.json()['detail']['code'] == 'task_season_required'
    assert ok(client.get(task_path, headers=w['master'].headers))['status'] == task['status']
    block_lifecycle.process_due(at=due - timedelta(seconds=1))
    assert ok(client.get(path, headers=superuser.headers))['archived_at'] is None
    assert ok(client.get('/api/task-queues/' + qid, headers=w['master'].headers))['task_creation']['available']

    result = block_lifecycle.process_due(at=due)
    assert result['executed'] == 1
    assert block_lifecycle.process_due(at=due)['executed'] == 0
    assert bid not in {b['block_id'] for b in ok(client.get('/api/blocks', headers=superuser.headers))}
    archived = ok(client.get(path, headers=superuser.headers))
    assert archived['archived_at'] and archived['deletion_request']['state'] == 'executed'
    queue = ok(client.get('/api/task-queues/' + qid, headers=w['member'].headers))
    assert queue['task_creation'] == {'available': False, 'reason': 'block_archived'}
    for actor in (w['master'], w['member']):
        saved = ok(client.get(task_path, headers=actor.headers))
        assert saved['task_id'] == task['task_id']
        image = client.get('/api/files/' + fid + '/content', headers=actor.headers)
        assert image.status_code == 200 and image.content == PNG
    refused = client.post('/api/tasks', headers=w['master'].headers,
                          json={**w['payload'], 'queue_id': qid})
    assert refused.status_code == 409 and refused.json()['detail']['code'] == 'block_archived'
    with db._session() as session:
        assert [(r.contribution_id, r.season_id, r.assignment_id, r.score)
                for r in session.query(ContributionORM).order_by(ContributionORM.contribution_id)] == contributions
        assert {r.guide_id for r in session.query(GuideORM)} == guides
        assert session.get(TaskORM, task['task_id']) is not None

    # Finishing existing work remains possible: one atomic season placement + close,
    # then ordinary private accounting; the removed block is not recreated.
    current = ok(client.get(task_path, headers=w['master'].headers))
    closed = ok(client.post(task_path + '/status', headers=w['master'].headers,
                            json={'expected_revision': current['revision'], 'status': 'closed',
                                  'season_id': w['season']['season_id']}))
    assert closed['season_id'] == w['season']['season_id'] and closed['status'] == 'closed'
    values = batch(client, closed, w['master'])
    ok(client.put(task_path + '/accounting-batch', headers=w['master'].headers,
                  json=accounting_payload(values)))
    assert ok(client.get(path, headers=superuser.headers))['archived_at']
