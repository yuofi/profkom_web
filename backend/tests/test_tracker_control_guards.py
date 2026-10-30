"""Managed KKR tickets never become ordinary shareable or product grouping tasks."""
from database import db,TaskORM,CommentORM,TaskLinkORM,TaskTrackerORM,NotificationORM
from domain_models import KkrControlEpicORM
from tracker_collaboration_models import TaskMentionRequestORM,TaskAccessGrantORM
from test_v13_tracker import work  # noqa:F401
from tracker import now


def control_for(work):
    with db._session() as session:
        row=session.query(KkrControlEpicORM).filter_by(season_id=work['task']['season_id'],source_kind='block',source_id=work['block']['block_id']).one()
        return row.task_id,row.queue_id


def test_control_mentions_notify_existing_roles_but_cannot_request_or_approve_outsiders(client,work,superuser):
    tid,_=control_for(work);path='/api/tasks/'+tid
    assert client.get(path,headers=work['master'].headers).status_code==200
    response=client.post(path+'/comments',headers=superuser.headers,json={'content':'Рабочее напоминание','mentioned_user_ids':[work['master'].user_id]})
    assert response.status_code==200,response.text
    with db._session() as session:
        before=session.query(CommentORM).filter_by(task_id=tid).count()
        assert session.query(NotificationORM).filter_by(user_id=work['master'].user_id,kind='task_mention').count()==1
    response=client.post(path+'/comments',headers=superuser.headers,json={'content':'Несогласованный посторонний','mentioned_user_ids':[work['outside'].user_id]})
    assert response.status_code==409 and response.json()['detail']['code']=='control_epic_managed'
    with db._session() as session:
        assert session.query(CommentORM).filter_by(task_id=tid).count()==before
        assert session.query(TaskMentionRequestORM).filter_by(task_id=tid).count()==0
        # An old pending request must not overwrite a real managed-role grant.
        original=session.get(TaskAccessGrantORM,(tid,work['master'].user_id));assert original.source=='control'
        session.add(TaskMentionRequestORM(request_id='old-control-request',task_id=tid,target_user_id=work['master'].user_id,requested_by_user_id=superuser.user_id,status='pending',created_at=now(),revision=1));session.commit()
    response=client.post(path+'/mentions/old-control-request/approve',headers=superuser.headers,json={'expected_revision':1})
    assert response.status_code==409 and response.json()['detail']['code']=='control_epic_managed'
    with db._session() as session:
        assert session.get(TaskAccessGrantORM,(tid,work['master'].user_id)).source=='control'
        assert session.get(TaskMentionRequestORM,'old-control-request').status=='pending'


def test_historical_ordinary_grant_cannot_open_managed_control_in_single_or_batch_reads(client,work,superuser):
    tid,qid=control_for(work)
    with db._session() as session:
        session.add(TaskAccessGrantORM(task_id=tid,user_id=work['outside'].user_id,active=True,source='mention',granted_at=now(),granted_by_user_id=superuser.user_id));session.commit()
    assert client.get('/api/tasks/'+tid,headers=work['outside'].headers).status_code==404
    listed=client.get('/api/tasks',headers=work['outside'].headers);assert listed.status_code==200
    assert tid not in {row['task_id'] for row in listed.json()['items']}
    assert client.get('/api/task-queues/'+qid,headers=work['outside'].headers).status_code==403


def test_managed_link_cannot_be_deleted_via_business_task_or_added_as_product_epic_or_parent(client,work,superuser):
    tid,_=control_for(work);business=work['task'];path='/api/tasks/'+business['task_id']
    response=client.post(path+'/status',headers=work['master'].headers,json={'expected_revision':business['revision'],'status':'closed'});assert response.status_code==200,response.text
    saved=response.json();link=next(link for link in saved['links'] if link['task']['task_id']==tid)
    assert link['managed'] is True
    response=client.request('DELETE',path+'/links/'+link['link_id'],headers=work['master'].headers,json={'expected_revision':saved['revision']})
    assert response.status_code==409 and response.json()['detail']['code']=='control_epic_managed'
    for kind in ('epic','related','blocks'):
        response=client.post(path+'/links',headers=work['master'].headers,json={'expected_revision':saved['revision'],'target_task_id':tid,'kind':kind})
        assert response.status_code==409 and response.json()['detail']['code']=='control_epic_managed'
    response=client.patch(path,headers=work['master'].headers,json={'expected_revision':saved['revision'],'parent_task_id':tid})
    assert response.status_code==409 and response.json()['detail']['code']=='control_epic_managed'
    with db._session() as session:
        assert session.get(TaskLinkORM,link['link_id']) is not None
        assert session.get(TaskORM,business['task_id']).revision==saved['revision']
        assert session.query(TaskTrackerORM).filter_by(task_id=business['task_id']).one().parent_task_id is None
