"""Comment file bindings, current task ACL, bytes and additive legacy SQLite upgrade."""
import json,os,sqlite3,subprocess,sys
from pathlib import Path
import pytest
from database import db,CommentORM,TaskActivityORM
from test_v13_tracker import work  # noqa: F401
DATA=b'%PDF-1.7 synthetic comment attachment'

def upload(client,actor,mock_s3,tid,purpose='comment',complete=True,name='comment.pdf'):
    r=client.post('/api/files/upload-intents',headers=actor.headers,json=dict(owner_kind='task',owner_id=tid,purpose=purpose,name=name,mime_type='application/pdf',size_bytes=len(DATA)))
    assert r.status_code==200,r.text
    fid=r.json()['file_id'];mock_s3['objects']['private/'+fid]=(DATA,'application/pdf')
    if complete:
        r=client.post('/api/files/'+fid+'/complete',headers=actor.headers,json={});assert r.status_code==200,r.text
    return fid

def post(client,actor,tid,files=None,body='Комментарий'):
    data={'content':body}
    if files is not None:data['file_ids']=files
    return client.post('/api/tasks/'+tid+'/comments',headers=actor.headers,json=data)

def test_upload_file_only_comment_reread_draft_acl_and_task_files_unchanged(client,work,mock_s3):
    tid=work['task']['task_id'];author=work['member'];reader=work['master'];fid=upload(client,author,mock_s3,tid)
    for suffix in ['/content','/download']:assert client.get('/api/files/'+fid+suffix,headers=reader.headers).status_code==404
    assert client.get('/api/files/'+fid+'/content',headers=author.headers).content==DATA
    made=post(client,author,tid,[fid],body='');assert made.status_code==200,made.text
    ref=dict(file_id=fid,name='comment.pdf',mime_type='application/pdf',size_bytes=len(DATA))
    assert made.json()['attachments']==[ref]
    assert client.get('/api/tasks/'+tid+'/comments',headers=reader.headers).json()['items'][0]['attachments']==[ref]
    r=client.get('/api/files/'+fid+'/content',headers=reader.headers);assert r.status_code==200 and r.content==DATA
    assert client.get('/api/files/'+fid+'/download',headers=reader.headers).json()['download_url'].endswith('/'+fid+'/content')
    assert client.get('/api/tasks/'+tid,headers=reader.headers).json()['attachments']==[]
    assert 'attach_task_file' not in client.get('/api/tasks/'+tid,headers=author.headers).json()['capabilities']

def test_edit_other_comment_preserves_files_and_removal_revokes_historical_bytes(client,work,mock_s3):
    tid=work['task']['task_id'];author=work['member'];editor=work['master'];fid=upload(client,author,mock_s3,tid)
    made=post(client,author,tid,[fid]).json();path='/api/comments/'+made['comment_id']
    for payload in [dict(content='Правка другого редактора'),dict(content='Правка с сохранением списка',file_ids=[fid])]:
        r=client.patch(path,headers=editor.headers,json=payload);assert r.status_code==200,r.text
        assert [f['file_id'] for f in r.json()['attachments']]==[fid]
    r=client.patch(path,headers=editor.headers,json=dict(content='Теперь без файла',file_ids=[]));assert r.status_code==200,r.text
    assert r.json()['attachments']==[]
    history=r.json()['history'][-1]['attachments'];assert history==[dict(file_id=fid,name='comment.pdf',mime_type='application/pdf',size_bytes=len(DATA))]
    for suffix in ['/content','/download']:assert client.get('/api/files/'+fid+suffix,headers=editor.headers).status_code==404
    assert client.get('/api/files/'+fid+'/content',headers=author.headers).content==DATA
    assert post(client,editor,tid,[fid]).status_code==403
    with db._session() as s:
        events=s.query(TaskActivityORM).filter_by(task_id=tid,kind='comment_edited').all()
        assert any(c['field']=='comment_attachments' and c['before'][0]['file_id']==fid and c['after']==[] for e in events for c in json.loads(e.changes_json))

def test_file_only_change_has_real_attachment_diff(client,work,mock_s3):
    tid=work['task']['task_id'];actor=work['member'];first=upload(client,actor,mock_s3,tid);second=upload(client,actor,mock_s3,tid,name='second.pdf')
    made=post(client,actor,tid,[first]).json()
    r=client.patch('/api/comments/'+made['comment_id'],headers=actor.headers,json=dict(content='Комментарий',file_ids=[second]));assert r.status_code==200,r.text
    with db._session() as s:
        changes=json.loads(s.query(TaskActivityORM).filter_by(task_id=tid,kind='comment_edited').one().changes_json)
        assert len(changes)==1 and changes[0]['field']=='comment_attachments'
        assert changes[0]['before'][0]['file_id']==first and changes[0]['after'][0]['file_id']==second
    for route in ['/api/tasks/'+tid+'/history','/api/history?target_kind=task&target_id='+tid]:
        response=client.get(route,headers=actor.headers);assert response.status_code==200,response.text
        visible=[change for event in response.json()['items'] for change in event['changes'] if change['field']=='comment_attachments']
        assert any(change['before']==['comment.pdf'] and change['after']==['second.pdf'] for change in visible)

def test_invalid_later_mention_rolls_back_attachment_publication(client,work,mock_s3):
    from database import NotificationORM
    tid=work['task']['task_id'];actor=work['member'];fid=upload(client,actor,mock_s3,tid)
    with db._session() as session:before=(session.query(CommentORM).count(),session.query(TaskActivityORM).count(),session.query(NotificationORM).count())
    response=client.post('/api/tasks/'+tid+'/comments',headers=actor.headers,json=dict(content='',file_ids=[fid],mentioned_user_ids=[-1]))
    assert response.status_code==422,response.text
    with db._session() as session:assert before==(session.query(CommentORM).count(),session.query(TaskActivityORM).count(),session.query(NotificationORM).count())
    assert client.get('/api/files/'+fid+'/content',headers=work['master'].headers).status_code==404

def test_hiding_comment_version_redacts_only_its_own_attachment_history(client,work,mock_s3):
    tid=work['task']['task_id'];actor=work['member'];first=upload(client,actor,mock_s3,tid);second=upload(client,actor,mock_s3,tid,name='second.pdf')
    own=post(client,actor,tid,[first]).json();other=post(client,actor,tid,[second]).json()
    for comment in [own,other]:
        response=client.patch('/api/comments/'+comment['comment_id'],headers=actor.headers,json=dict(content='Новая версия',file_ids=[]));assert response.status_code==200,response.text
    history=client.get('/api/history?target_kind=task&target_id='+tid,headers=actor.headers).json()['items']
    event=next(event for event in history if any(change['field']=='comment_attachments' and change['after']==['comment.pdf'] for change in event['changes']))
    response=client.post('/api/history/'+event['source_kind']+'/'+event['source_id']+'/hide',headers=actor.headers,json=dict(expected_revision=1));assert response.status_code==200,response.text
    comments=client.get('/api/tasks/'+tid+'/comments',headers=actor.headers).json()['items']
    assert next(comment for comment in comments if comment['comment_id']==own['comment_id'])['history'][0]['attachments']==[]
    assert next(comment for comment in comments if comment['comment_id']==other['comment_id'])['history'][0]['attachments'][0]['file_id']==second

@pytest.mark.parametrize('invalid',['foreign','pending','purpose','other-task','duplicate','missing'])
def test_invalid_attachment_rolls_back_every_comment_side_effect(client,work,mock_s3,invalid):
    from database import NotificationORM
    tid=work['task']['task_id'];actor=work['member'];owned=upload(client,actor,mock_s3,tid)
    if invalid=='foreign':bad=upload(client,work['master'],mock_s3,tid)
    elif invalid=='pending':bad=upload(client,actor,mock_s3,tid,complete=False)
    elif invalid=='purpose':bad=upload(client,work['master'],mock_s3,tid,purpose='attachment')
    elif invalid=='other-task':
        r=client.post('/api/tasks',headers=work['master'].headers,json={**work['payload'],'title':'Другая задача'});assert r.status_code==200,r.text
        bad=upload(client,actor,mock_s3,r.json()['task_id'])
    elif invalid=='duplicate':bad=owned
    else:bad='file-missing'
    made=post(client,actor,tid,[owned]).json()
    def snapshot():
        with db._session() as s:
            c=s.get(CommentORM,made['comment_id'])
            return (c.content_json,c.files_json,c.history_json,c.updated_at,s.query(CommentORM).count(),s.query(TaskActivityORM).count(),s.query(NotificationORM).count())
    before=snapshot()
    for command in ['post','patch']:
        r=post(client,actor,tid,[owned,bad]) if command=='post' else client.patch('/api/comments/'+made['comment_id'],headers=actor.headers,json=dict(content='Невалидная правка',file_ids=[owned,bad]))
        assert r.status_code in (403,422),r.text
        assert snapshot()==before

def test_comment_file_cannot_be_task_attachment_and_loss_of_access_revokes_reads(client,work,mock_s3):
    tid=work['task']['task_id'];author=work['member'];fid=upload(client,author,mock_s3,tid)
    r=post(client,author,tid,[fid]);assert r.status_code==200,r.text
    task=client.get('/api/tasks/'+tid,headers=work['master'].headers).json()
    r=client.patch('/api/tasks/'+tid,headers=work['master'].headers,json=dict(expected_revision=task['revision'],file_ids=[fid]));assert r.status_code==403,r.text
    r=client.request('DELETE','/api/blocks/'+work['block']['block_id']+'/members/'+str(author.user_id),headers=work['master'].headers,json={});assert r.status_code==200,r.text
    for suffix in ['/content','/download']:assert client.get('/api/files/'+fid+suffix,headers=author.headers).status_code==404
    assert client.get('/api/tasks/'+tid+'/comments',headers=author.headers).status_code==404
    assert client.get('/api/files/'+fid+'/content',headers=work['master'].headers).content==DATA

def test_empty_comment_and_attachment_limit(client,work):
    tid=work['task']['task_id'];actor=work['member']
    assert post(client,actor,tid,[],body=' ').status_code==422
    assert post(client,actor,tid,['file-'+str(i) for i in range(101)]).status_code==422

def test_legacy_sqlite_upgrade_preserves_text_history_indexes_and_triggers_twice(tmp_path):
    path=tmp_path/'old-comments.db'
    with sqlite3.connect(path) as c:
        c.executescript('CREATE TABLE task_comments(comment_id TEXT PRIMARY KEY,task_id TEXT,author_user_id INTEGER,content_json TEXT,history_json TEXT,created_at TEXT,updated_at TEXT);CREATE INDEX custom_comment_index ON task_comments(task_id);CREATE TRIGGER custom_comment_trigger AFTER UPDATE ON task_comments BEGIN SELECT 1;END;')
        c.execute('INSERT INTO task_comments VALUES(?,?,?,?,?,?,?)',('historic','task-old',7,'{"format":"markdown","body":"old"}','[{"content":{"body":"older"},"edited_at":"unknown"}]','unknown',None))
        before=c.execute('SELECT * FROM task_comments').fetchone();schema=c.execute("SELECT name,sql FROM sqlite_master WHERE name LIKE 'custom_comment_%' ORDER BY name").fetchall()
    for _ in range(2):
        r=subprocess.run([sys.executable,'-c','import database; database._ensure_sqlite_comment_files_column()'],cwd=Path(__file__).resolve().parents[1],env={**os.environ,'DATABASE_PATH':str(path)},capture_output=True,text=True)
        assert r.returncode==0,r.stderr
        with sqlite3.connect(path) as c:
            assert [row[1] for row in c.execute('PRAGMA table_info(task_comments)')].count('files_json')==1
            assert c.execute('SELECT comment_id,task_id,author_user_id,content_json,history_json,created_at,updated_at FROM task_comments').fetchone()==before
            assert c.execute('SELECT files_json FROM task_comments').fetchone()==('[]',)
            assert c.execute("SELECT name,sql FROM sqlite_master WHERE name LIKE 'custom_comment_%' ORDER BY name").fetchall()==schema
