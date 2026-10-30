"""Safe rich comment identity projection is distinct from access/notification commands."""
from types import SimpleNamespace
from sqlalchemy import event
from database import db, engine, UserORM, NotificationORM
from tracker_collaboration import _comment_profile_ids, comment_mention_refs
from test_v13_tracker import work  # noqa: F401


def test_only_canonical_prose_profile_links_supply_safe_mentions():
    body=r'''[Current](/contacts/12) [Escaped \] name](/contacts/13)
[Foreign](https://example.test/contacts/14)
[Absolute](http://127.0.0.1/contacts/15) [Query](/contacts/16?a=1)
![Image](/contacts/17) \[Escaped](/contacts/18)
`[Inline](/contacts/19)`
```markdown
[Fenced](/contacts/20)
```
~~~text
[Fenced too](/contacts/21)
~~~
    [Indented](/contacts/22)
[Fragment](/contacts/23#x) [Zero](/contacts/0) [Repeated](/contacts/12)
'''
    assert _comment_profile_ids(body)==[12,13]


def test_http_comment_chip_names_are_authoritative_and_links_do_not_grant_access(client,work):
    w=work;path='/api/tasks/'+w['task']['task_id']
    target=w['outside'].user_id
    before=None
    with db._session() as session:
        before=session.query(NotificationORM).filter_by(kind='task_mention',user_id=target).count()
    response=client.post(path+'/comments',headers=w['member'].headers,json={'content':f'Позвать [подменённое имя](/contacts/{target})'})
    assert response.status_code==200,response.text
    comment=response.json();assert len(comment['mentioned_users'])==1
    ref=comment['mentioned_users'][0]
    assert set(ref)=={'user_id','display_name','avatar_url'} and ref['user_id']==target
    assert ref['display_name']!='подменённое имя'
    assert client.get(path,headers=w['outside'].headers).status_code==404
    assert client.get(path+'/comments',headers=w['outside'].headers).status_code==404
    with db._session() as session:
        assert session.query(NotificationORM).filter_by(kind='task_mention',user_id=target).count()==before
    page=client.get(path+'/comments',headers=w['member'].headers).json()
    assert page['items'][0]['mentioned_users']==[ref]
    edited=client.patch('/api/comments/'+comment['comment_id'],headers=w['member'].headers,json={'content':f'`[Код](/contacts/{target})`'})
    assert edited.status_code==200 and edited.json()['mentioned_users']==[]


def test_unavailable_mentions_are_omitted_and_batched_without_per_comment_queries(client,work):
    w=work;member=w['member'].user_id;outside=w['outside'].user_id
    comments=[SimpleNamespace(comment_id=str(index),content=SimpleNamespace(body=f'[Первый](/contacts/{member}) [Второй](/contacts/{outside})')) for index in range(30)]
    statements=[]
    def record(_connection,_cursor,statement,*_args):
        if statement.lstrip().upper().startswith('SELECT'):statements.append(statement)
    event.listen(engine,'before_cursor_execute',record)
    try:refs=comment_mention_refs(comments)
    finally:event.remove(engine,'before_cursor_execute',record)
    assert all(len(values)==2 for values in refs.values())
    assert len(statements)<=4,statements
    with db._session() as session:
        session.get(UserORM,outside).account_state='archived';session.get(UserORM,member).banned=True;session.commit()
    assert all(values==[] for values in comment_mention_refs(comments).values())
