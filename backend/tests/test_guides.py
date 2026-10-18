"""Legacy guide adapter under API 1.3: approved read, object write, stable IDs.

Replaces the obsolete anonymous/member-only visibility and unversioned-save
expectations. Draft publication and editor isolation also run in test_v13_materials.
"""
import pytest
from database import db,GuideORM

EDIT_METHODS=('POST','PUT','PATCH')
PUBLIC_OWNERS=('', 'none','all',' NoNe ',' ALL ')


@pytest.mark.parametrize('owner',PUBLIC_OWNERS+('Медиа',' медиа '))
def test_approved_read_preserves_id_and_source(client,user,make_block,make_guide,owner):
    make_block();source='# Гайд\n\n**Жирный** *Курсив*\n- Пункт\n[Ссылка](https://example.com)'
    g=make_guide(title='Исходный',owner_block=owner,text=source)
    assert client.get('/api/guides').status_code==401
    assert client.get(f'/api/guides/{g.guide_id}').status_code==401
    viewed=client.get(f'/api/guides/{g.guide_id}',headers=user.headers)
    assert viewed.status_code==200,viewed.text
    assert viewed.json()['text']==source and viewed.json()['guide_id']==g.guide_id
    assert isinstance(viewed.json()['material_id'],str)
    assert set(viewed.json())=={'guide_id','title','owner_block','text','description','original_link','material_id','revision','capabilities'}
    assert g.guide_id in [x['guide_id'] for x in client.get('/api/guides',headers=user.headers).json()]


@pytest.mark.parametrize('method',EDIT_METHODS)
@pytest.mark.parametrize('owner',('none','Медиа'))
def test_versioned_save_publishes_same_legacy_id(client,superuser,user,make_guide,make_block,method,owner):
    make_block();g=make_guide(owner_block=owner,text='Old')
    current=client.get(f'/api/guides/{g.guide_id}',headers=superuser.headers).json()
    payload=dict(expected_revision=current['revision'],title='Новый',description='Описание',text='**Новое**',original_link='https://example.com/document')
    r=client.request(method,f'/api/guides/{g.guide_id}',headers=superuser.headers,json=payload)
    assert r.status_code==200,r.text
    assert r.json()['guide_id']==g.guide_id and r.json()['material_id']==current['material_id']
    assert r.json()['revision']>current['revision']
    assert client.get(f'/api/guides/{g.guide_id}',headers=user.headers).json()['text']=='**Новое**'
    assert client.request(method,f'/api/guides/{g.guide_id}',headers=superuser.headers,json=payload).status_code==409


@pytest.mark.parametrize('method',EDIT_METHODS)
def test_old_save_requires_revision_and_cannot_change_owner(client,superuser,make_guide,make_block,method):
    make_block();g=make_guide(owner_block='none',text='Old')
    assert client.request(method,f'/api/guides/{g.guide_id}',headers=superuser.headers,json=dict(text='No revision')).status_code==409
    current=client.get(f'/api/guides/{g.guide_id}',headers=superuser.headers).json()
    r=client.request(method,f'/api/guides/{g.guide_id}',headers=superuser.headers,json=dict(expected_revision=current['revision'],owner_block='Медиа',text='Move'))
    assert r.status_code==422
    assert db.get_guide(g.guide_id).text=='Old'


@pytest.mark.parametrize('method',EDIT_METHODS)
def test_master_writes_own_guide_and_deputy_can_publish(client,make_master,make_user,make_guide,method):
    master,b=make_master();outsider=make_user();own=make_guide(owner_block=b.name,text='Own');global_g=make_guide(owner_block='none',text='Global')
    current=client.get(f'/api/guides/{own.guide_id}',headers=master.headers).json()
    payload=dict(expected_revision=current['revision'],text='Updated')
    assert client.request(method,f'/api/guides/{own.guide_id}',headers=outsider.headers,json=payload).status_code==403
    assert client.request(method,f'/api/guides/{own.guide_id}',headers=master.headers,json=payload).status_code==200
    current=client.get(f'/api/guides/{global_g.guide_id}',headers=master.headers).json()
    assert client.request(method,f'/api/guides/{global_g.guide_id}',headers=master.headers,json=dict(expected_revision=current['revision'],text='Forbidden')).status_code==403


@pytest.mark.parametrize('method',EDIT_METHODS)
@pytest.mark.parametrize('value',[None,'https://example.com/original'])
def test_original_link_set_and_explicit_clear(client,superuser,make_guide,method,value):
    g=make_guide(owner_block='none',text='Body',original_link='https://example.com/old')
    current=client.get(f'/api/guides/{g.guide_id}',headers=superuser.headers).json()
    r=client.request(method,f'/api/guides/{g.guide_id}',headers=superuser.headers,json=dict(expected_revision=current['revision'],original_link=value))
    assert r.status_code==200,r.text
    assert r.json()['original_link']==value and db.get_guide(g.guide_id).original_link==value


def test_create_empty_legacy_card_is_draft_until_publication(client,superuser,user):
    r=client.post('/api/guides',headers=superuser.headers,json=dict(title='Новый',owner_block='none',text=''))
    assert r.status_code==200,r.text
    g=r.json();mid=g['material_id']
    assert client.get('/api/materials/'+mid,headers=user.headers).status_code==404
    assert client.get(f"/api/guides/{g['guide_id']}",headers=user.headers).status_code==404
    assert client.get('/api/guides',headers=user.headers).json()==[]


@pytest.mark.parametrize('owner',('none','Медиа','not-an-existing-block'))
def test_create_respects_block_ownership(client,user,superuser,make_block,owner):
    make_block()
    assert client.post('/api/guides',headers=user.headers,json=dict(title='Guide',owner_block=owner,text='Body')).status_code in (403,404)
    r=client.post('/api/guides',headers=superuser.headers,json=dict(title='Guide',owner_block=owner,text='Body'))
    assert r.status_code==(404 if owner=='not-an-existing-block' else 200),r.text


def test_soft_delete_preserves_legacy_storage_and_never_reuses_id(client,superuser,user,make_guide):
    g=make_guide(owner_block='none',text='Historical')
    assert client.delete(f'/api/guides/{g.guide_id}',headers=user.headers).status_code==403
    assert client.delete(f'/api/guides/{g.guide_id}',headers=superuser.headers).json()==dict(deleted=True)
    assert client.get(f'/api/guides/{g.guide_id}',headers=user.headers).status_code==404
    with db._session() as s:assert s.get(GuideORM,g.guide_id).text=='Historical'
    made=client.post('/api/guides',headers=superuser.headers,json=dict(title='Next',owner_block='none',text='Body')).json()
    assert made['guide_id']!=g.guide_id
