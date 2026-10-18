"""Contextual, size-bounded private uploads; the unscoped legacy writer is closed."""
import pytest
from database import db,FileRecordORM


@pytest.mark.parametrize('folder',('avatars','guides','pgas','../../other','reports'))
def test_unscoped_legacy_upload_never_signs_objects(client,user,superuser,mock_s3,folder):
    for actor in (user,superuser):
        r=client.post('/api/upload/presigned-url',headers=actor.headers,json=dict(folder=folder,content_type='image/png',file_name='a.png'))
        assert r.status_code==409
    assert mock_s3['presigned']==[] and mock_s3['upload']==[]


@pytest.mark.parametrize('state',('anonymous','pending','banned'))
def test_private_upload_requires_active_approval(client,make_user,state):
    u=make_user(password=None)
    if state=='pending':db.update_user(u.user_id,account_state='pending')
    if state=='banned':db.update_user(u.user_id,banned=True)
    r=client.post('/api/files/upload-intents',headers={} if state=='anonymous' else u.headers,json=dict(owner_kind='avatar',purpose='avatar',name='a.png',mime_type='image/png',size_bytes=10))
    assert r.status_code==(401 if state=='anonymous' else 403)


@pytest.mark.parametrize('field,value',[
    ('size_bytes',0),('size_bytes',-1),('size_bytes',10*1024*1024+1),
    ('name','../a.png'),('name','a.exe'),('name','a\n.png'),
    ('mime_type','text/html'),('mime_type','image/jpeg'),('purpose','report'),
    ('owner_kind','anything'),('owner_id','9999'),
])
def test_avatar_metadata_cannot_bypass_binary_contract(client,user,field,value):
    payload=dict(owner_kind='avatar',purpose='avatar',name='a.png',mime_type='image/png',size_bytes=10)
    payload[field]=value
    r=client.post('/api/files/upload-intents',headers=user.headers,json=payload)
    assert r.status_code in (403,422),r.text
    with db._session() as s:assert s.query(FileRecordORM).count()==0


@pytest.mark.parametrize('data,mime',[(b'not png','image/png'),(b'not jpeg','image/jpeg'),(b'RIFFxxxxWRONG','image/webp')])
def test_complete_checks_actual_binary_and_size(client,user,mock_s3,data,mime):
    ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]
    r=client.post('/api/files/upload-intents',headers=user.headers,json=dict(owner_kind='avatar',purpose='avatar',name='a.'+ext,mime_type=mime,size_bytes=len(data)))
    assert r.status_code==200,r.text
    fid=r.json()['file_id'];mock_s3['objects']['private/'+fid]=(data,mime)
    assert client.post('/api/files/'+fid+'/complete',headers=user.headers,json={}).status_code==422
    assert client.get('/api/files/'+fid+'/download',headers=user.headers).status_code==404
