"""History authorization, role-at-time evidence and erasure without ledger changes."""
from datetime import datetime, timedelta, timezone
import json

import pytest

from database import (db, AuditLogORM, TaskActivityORM, TaskORM, AssignmentORM, ContributionORM,
                      SeasonORM, CommentORM)
from domain_models import MembershipORM, ScopeTenureORM, SummaryVersionORM
from history_models import HistoryRedactionORM
from models import Block


def ok(response):
    assert response.status_code == 200, response.json()
    return response.json()


def get(client, actor, kind, identifier):
    return client.get('/api/history', headers=actor.headers, params=dict(target_kind=kind, target_id=identifier))


def hide(client, actor, entry, revision=1):
    return client.post(f"/api/history/{entry['source_kind']}/{entry['source_id']}/hide", headers=actor.headers, json=dict(expected_revision=revision))


@pytest.fixture
def work(client, superuser, make_user):
    master, worker, reader, successor, outsider = [make_user() for _ in range(5)]
    db.create_block(Block(name='History Team', master='', arr_of_human=[master.user_id, worker.user_id, reader.user_id]))
    db.set_block_leader('History Team', master.user_id)
    block = ok(client.get('/api/blocks/History Team', headers=superuser.headers))
    stamp = datetime.now(timezone.utc)
    with db._session() as session:
        for member in session.query(MembershipORM).filter_by(block_id=block['block_id']):
            member.joined_at = (stamp-timedelta(days=2)).isoformat()
        session.commit()
    season = ok(client.post('/api/seasons', headers=superuser.headers, json=dict(title='History season', type='autumn_winter', starts_at=(stamp-timedelta(days=1)).isoformat(), ends_at=(stamp+timedelta(days=10)).isoformat())))
    season = ok(client.post(f"/api/seasons/{season['season_id']}/open", headers=superuser.headers, json=dict(expected_revision=season['revision'])))
    task = ok(client.post('/api/tasks', headers=master.headers, json=dict(season_id=season['season_id'], scope=dict(kind='block', id=block['block_id']), title='История задачи', description='Исходная версия', deadline_at=(stamp+timedelta(days=1)).isoformat(), assignees=[dict(user_id=worker.user_id, hours=2)])))
    return dict(master=master, worker=worker, reader=reader, successor=successor, outsider=outsider, block=block, season=season, task=task)


def edit(client, work, body):
    task = ok(client.get('/api/tasks/'+work['task']['task_id'], headers=work['worker'].headers))
    return ok(client.patch('/api/tasks/'+task['task_id'], headers=work['worker'].headers, json=dict(expected_revision=task['revision'], description={'format':'markdown','body':body})))


def test_public_task_history_excludes_private_hours_criteria_reason_and_outcomes(client, work):
    assignment = work['task']['assignments'][0]['assignment_id']
    inputs = ok(client.get(f'/api/assignments/{assignment}/assessment-inputs', headers=work['master'].headers))
    ok(client.patch(f'/api/assignments/{assignment}/assessment-inputs', headers=work['master'].headers,
                    json=dict(expected_revision=inputs['revision'], hours=731, evaluation=0, reason='PRIVATE_ACCOUNTING_REASON')))
    public = ok(get(client, work['reader'], 'task', work['task']['task_id']))
    assert public['items'] and 'PRIVATE_ACCOUNTING_REASON' not in json.dumps(public)
    assert not any(change['field'] in {'hours','evaluation','criteria','effective_completed_at'} for item in public['items'] for change in item['changes'])
    private = ok(get(client, work['master'], 'task', work['task']['task_id']))
    assert any(change['field']=='hours' and change['after']==731 for item in private['items'] for change in item['changes'])
    assert get(client, work['worker'], 'assignment', assignment).status_code == 403
    assert get(client, work['outsider'], 'task', work['task']['task_id']).status_code == 404


def test_actor_hides_own_text_after_close_tombstone_and_next_before_do_not_leak(client, work):
    edit(client, work, 'УДАЛЯЕМАЯ_ВЕРСИЯ')
    edit(client, work, 'Текущий безопасный текст')
    entries = ok(get(client, work['worker'], 'task', work['task']['task_id']))['items']
    target = next(item for item in entries if any(change['after']=='УДАЛЯЕМАЯ_ВЕРСИЯ' for change in item['changes']))
    with db._session() as session:
        session.get(SeasonORM, work['season']['season_id']).state='closed'
        session.add(SummaryVersionORM(snapshot_id='fixed-summary', season_id=work['season']['season_id'], version=1, summary_json='{"total":42}', contributions_json='[]', bonuses_json='[]', previous_summary_version=None, changed_by_user_id=work['master'].user_id, reason='Synthetic snapshot', created_at=datetime.now(timezone.utc).isoformat()))
        session.commit()
        before = [(type(row).__name__, tuple(getattr(row,c.name) for c in row.__table__.columns)) for cls in (TaskORM, AssignmentORM, ContributionORM, SummaryVersionORM) for row in session.query(cls)]
    assert target['can_hide'] is True
    ok(hide(client, work['worker'], target))
    history = ok(get(client, work['worker'], 'task', work['task']['task_id']))['items']
    assert 'УДАЛЯЕМАЯ_ВЕРСИЯ' not in json.dumps(history, ensure_ascii=False)
    deleted = next(item for item in history if item['id']==target['id'])
    assert deleted['hidden'] and deleted['hidden_by']['user_id']==work['worker'].user_id
    assert deleted['changes']==[] and deleted['changed_by']['user_id']==work['worker'].user_id
    assert hide(client, work['worker'], target).status_code == 409
    with db._session() as session:
        after = [(type(row).__name__, tuple(getattr(row,c.name) for c in row.__table__.columns)) for cls in (TaskORM, AssignmentORM, ContributionORM, SummaryVersionORM) for row in session.query(cls)]
        assert after==before
        assert all('УДАЛЯЕМАЯ_ВЕРСИЯ' not in row.changes_json for row in session.query(TaskActivityORM).filter_by(task_id=work['task']['task_id']))
    old_route = ok(client.get('/api/tasks/'+work['task']['task_id']+'/history', headers=work['worker'].headers))
    assert 'УДАЛЯЕМАЯ_ВЕРСИЯ' not in json.dumps(old_route, ensure_ascii=False)


def test_only_proven_supervisor_at_change_time_can_hide_others_version(client, work):
    edit(client, work, 'Версия под прежним мастером')
    target = next(item for item in ok(get(client, work['master'], 'task', work['task']['task_id']))['items'] if any(change['after']=='Версия под прежним мастером' for change in item['changes']))
    db.set_block_leader('History Team', work['successor'].user_id)
    assert get(client, work['successor'], 'task', work['task']['task_id']).status_code==200
    assert hide(client, work['successor'], target).status_code==403
    assert hide(client, work['reader'], target).status_code==403
    ok(hide(client, work['master'], target))


def test_imported_unknown_tenure_is_not_proof_of_historical_supervision(client, work):
    edit(client, work, 'Недоказанная историческая связь')
    target = next(item for item in ok(get(client, work['master'], 'task', work['task']['task_id']))['items'] if any(change['after']=='Недоказанная историческая связь' for change in item['changes']))
    with db._session() as session:
        session.query(ScopeTenureORM).filter_by(user_id=work['master'].user_id).delete()
        session.commit()
    assert hide(client, work['master'], target).status_code==403


@pytest.mark.parametrize('role', ['chair', 'deputy_chair'])
def test_global_leader_needs_role_on_change_date_and_no_current_role_bypass(client, work, superuser, role):
    edit(client,work,'Версия под прежним глобальным руководителем')
    target=next(item for item in ok(get(client,work['reader'],'task',work['task']['task_id']))['items'] if any(change['after']=='Версия под прежним глобальным руководителем' for change in item['changes']))
    stamp=datetime.now(timezone.utc)
    with db._session() as session:
        session.query(ScopeTenureORM).filter_by(user_id=superuser.user_id,scope_kind='global').delete()
        session.add(ScopeTenureORM(tenure_id='late-chair',user_id=superuser.user_id,scope_kind='global',scope_id='global',role='chair',started_at=(stamp+timedelta(seconds=1)).isoformat()))
        session.add(ScopeTenureORM(tenure_id='former-global',user_id=work['reader'].user_id,scope_kind='global',scope_id='global',role=role,started_at=(stamp-timedelta(days=1)).isoformat(),ended_at=stamp.isoformat()))
        session.commit()
    # Current chair status does not create authority retroactively.
    assert hide(client,superuser,target).status_code==403
    # The actual historical global role is sufficient; a separate participation
    # interval is not an additional condition for legitimate leadership.
    ok(hide(client,work['reader'],target))
    with db._session() as session:
        session.get(ScopeTenureORM,'late-chair').started_at=(stamp-timedelta(days=1)).isoformat()
        session.commit()
    edit(client,work,'Версия в подтверждённом периоде нынешнего председателя')
    current=next(item for item in ok(get(client,superuser,'task',work['task']['task_id']))['items'] if any(change['after']=='Версия в подтверждённом периоде нынешнего председателя' for change in item['changes']))
    ok(hide(client,superuser,current))


def test_current_access_loss_blocks_even_own_redaction(client, work):
    edit(client, work, 'Автор ушёл из области')
    target = next(item for item in ok(get(client, work['worker'], 'task', work['task']['task_id']))['items'] if any(change['after']=='Автор ушёл из области' for change in item['changes']))
    current = ok(client.get('/api/tasks/'+work['task']['task_id'], headers=work['master'].headers))
    ok(client.post(f"/api/tasks/{current['task_id']}/assignees/{work['worker'].user_id}/remove", headers=work['master'].headers, json=dict(expected_revision=current['revision'])))
    # Removing the task's assignee leaves a watcher; leaving the block revokes scope read.
    ok(client.post(f"/api/blocks/{work['block']['block_id']}/leave", headers=work['worker'].headers))
    assert hide(client, work['worker'], target).status_code in {403,404}


def test_comment_versions_are_erased_only_for_the_same_comment(client, work):
    path=f"/api/tasks/{work['task']['task_id']}/comments"
    first=ok(client.post(path, headers=work['worker'].headers, json=dict(content='СЕКРЕТ_ОДНОГО_КОММЕНТАРИЯ')))
    second=ok(client.post(path, headers=work['reader'].headers, json=dict(content='СЕКРЕТ_ОДНОГО_КОММЕНТАРИЯ')))
    ok(client.patch('/api/comments/'+first['comment_id'], headers=work['worker'].headers, json=dict(content='Безопасный комментарий')))
    target=next(item for item in ok(get(client,work['worker'],'task',work['task']['task_id']))['items'] if item['source_kind']=='activity' and any(change['field']=='comment' and change['after']=='СЕКРЕТ_ОДНОГО_КОММЕНТАРИЯ' for change in item['changes']) and item['changed_by']['user_id']==work['worker'].user_id)
    ok(hide(client,work['worker'],target))
    with db._session() as session:
        old=session.get(CommentORM, first['comment_id'])
        unrelated=session.get(CommentORM, second['comment_id'])
        assert all(item.get('content', {}).get('body') != 'СЕКРЕТ_ОДНОГО_КОММЕНТАРИЯ' for item in json.loads(old.history_json))
        assert json.loads(unrelated.content_json)['body'] == 'СЕКРЕТ_ОДНОГО_КОММЕНТАРИЯ'
        assert json.loads(old.content_json)['body'] == 'Безопасный комментарий'


def test_metadata_and_roster_changes_capture_actual_actor_with_no_contact_snapshot(client, work, superuser):
    block=ok(client.get('/api/blocks/'+work['block']['block_id'], headers=superuser.headers))
    ok(client.put('/api/blocks/'+block['block_id']+'/leader', headers=superuser.headers,
                  json=dict(expected_revision=block['revision'], user_id=work['successor'].user_id)))
    rows=ok(get(client,work['reader'],'block',block['block_id']))['items']
    assert rows and any(row['changed_by']['user_id']==superuser.user_id and any(change['field'] in {'master_user_id','user_id'} for change in row['changes']) for row in rows)
    assert not any(key in json.dumps(rows) for key in ('hashed_password','phone','email','kkr_score'))


def test_read_history_does_not_write_rows_and_supports_cursor(client, work, monkeypatch):
    import api_contract
    monkeypatch.setattr(api_contract,'PAGE_SIZE',2)
    for index in range(4):
        edit(client,work,f'Версия {index}')
    with db._session() as session:
        before=(session.query(AuditLogORM).count(),session.query(HistoryRedactionORM).count(),session.query(TaskActivityORM).count())
    seen=[];cursor=None
    while True:
        params=dict(target_kind='task',target_id=work['task']['task_id'])
        if cursor:params['cursor']=cursor
        page=ok(client.get('/api/history',headers=work['reader'].headers,params=params))
        seen.extend(row['id'] for row in page['items']);cursor=page['next_cursor']
        if not cursor:break
    assert len(seen)>=5 and len(seen)==len(set(seen))
    with db._session() as session:
        assert before==(session.query(AuditLogORM).count(),session.query(HistoryRedactionORM).count(),session.query(TaskActivityORM).count())


def test_legacy_scope_label_reuse_never_grants_historical_redaction(client, work):
    edit(client,work,'История с неоднозначным именем блока')
    target=next(item for item in ok(get(client,work['master'],'task',work['task']['task_id']))['items'] if any(change['after']=='История с неоднозначным именем блока' for change in item['changes']))
    stamp=(datetime.now(timezone.utc)-timedelta(days=5)).isoformat()
    with db._session() as session:
        session.add(ScopeTenureORM(tenure_id='legacy-ambiguous', user_id=work['reader'].user_id, scope_kind='block', scope_id='History Team', scope_block_id=None, role='master', started_at=stamp, ended_at=None))
        session.commit()
    assert hide(client,work['reader'],target).status_code==403
    profile=ok(client.get(f"/api/profiles/{work['reader'].user_id}/activity",headers=work['reader'].headers))
    legacy=next(item for item in profile['items'] if item['role']=='master')
    assert legacy['scope']==dict(kind='block',id=None,name='History Team')


def test_private_audit_hide_preserves_numeric_truth_and_current_accounting(client, work):
    assignment=work['task']['assignments'][0]['assignment_id']
    inputs=ok(client.get(f'/api/assignments/{assignment}/assessment-inputs',headers=work['master'].headers))
    saved=ok(client.patch(f'/api/assignments/{assignment}/assessment-inputs',headers=work['master'].headers,json=dict(expected_revision=inputs['revision'],hours=9,evaluation=0,reason='ПРИВАТНЫЙ_УДАЛЯЕМЫЙ_ТЕКСТ')))
    rows=ok(get(client,work['master'],'assignment',assignment))['items']
    target=next(item for item in rows if item['reason']=='ПРИВАТНЫЙ_УДАЛЯЕМЫЙ_ТЕКСТ')
    ok(hide(client,work['master'],target))
    after=ok(client.get(f'/api/assignments/{assignment}/assessment-inputs',headers=work['master'].headers))
    assert after==saved
    with db._session() as session:
        raw=session.get(AuditLogORM,int(target['source_id']))
        assert raw.reason is None and json.loads(raw.new_values_json)['hours']==9
    assert 'ПРИВАТНЫЙ_УДАЛЯЕМЫЙ_ТЕКСТ' not in json.dumps(ok(get(client,work['master'],'assignment',assignment)),ensure_ascii=False)


def test_new_block_history_survives_rename_and_never_joins_reused_legacy_label(client, work, superuser):
    block=ok(client.get('/api/blocks/'+work['block']['block_id'],headers=superuser.headers))
    ok(client.put('/api/blocks/'+block['block_id']+'/leader',headers=superuser.headers,json=dict(expected_revision=block['revision'],user_id=work['successor'].user_id)))
    before=ok(get(client,work['reader'],'block',block['block_id']))['items']
    ids={item['id'] for item in before}
    current=ok(client.get('/api/blocks/'+block['block_id'],headers=superuser.headers))
    ok(client.patch('/api/blocks/'+block['block_id'],headers=superuser.headers,json=dict(expected_revision=current['revision'],name='History Team Renamed')))
    db.create_block(Block(name='History Team',master='',arr_of_human=[work['outsider'].user_id]))
    reused=ok(client.get('/api/blocks/History Team',headers=superuser.headers))
    renamed=ok(get(client,work['reader'],'block',block['block_id']))['items']
    other=ok(get(client,work['outsider'],'block',reused['block_id']))['items']
    assert ids.issubset({item['id'] for item in renamed})
    assert not ids & {item['id'] for item in other}
    assert any(change['field']=='name' and change['before']=='History Team' and change['after']=='History Team Renamed' for item in renamed for change in item['changes'])
    with db._session() as session:
        ambiguous=AuditLogORM(target_kind='block',target_id='History Team',changed_by_user_id=work['outsider'].user_id,reason='Unproven legacy label',old_values_json='{}',new_values_json='{"description":"AMBIGUOUS_LEGACY_BLOCK_TEXT"}',created_at=datetime.now(timezone.utc).isoformat())
        session.add(ambiguous);session.flush();source_id=str(ambiguous.id);session.commit()
    assert 'AMBIGUOUS_LEGACY_BLOCK_TEXT' not in json.dumps(ok(get(client,work['outsider'],'block',reused['block_id'])))
    assert client.post('/api/history/audit/'+source_id+'/hide',headers=work['outsider'].headers,json=dict(expected_revision=1)).status_code==404
