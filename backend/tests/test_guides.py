"""Old guide IDs resolve to current materials; the duplicate CRUD is retired (АВ-11/37)."""
import pytest
from database import db, GuideORM
from domain_models import MaterialORM

PUBLIC_OWNERS=('', 'none','all',' NoNe ',' ALL ')


def resolve(client, actor, guide_id):
    return client.get(f'/api/materials/legacy-guides/{guide_id}',headers=actor.headers)


@pytest.mark.parametrize('owner',PUBLIC_OWNERS+('Медиа',' медиа '))
def test_old_id_resolution_preserves_source_and_current_visibility(client,user,make_user,make_block,make_guide,owner):
    member=make_user();make_block(arr_of_human=[member.user_id])
    source='# Гайд\n\n**Жирный** *Курсив*\n- Пункт\n[Ссылка](https://example.com)'
    guide=make_guide(title='Исходный',owner_block=owner,text=source)
    path=f'/api/materials/legacy-guides/{guide.guide_id}'
    assert client.get(path).status_code==401
    assert resolve(client,user,guide.guide_id).status_code==(404 if owner.strip().casefold()=='медиа' else 200)
    viewed=resolve(client,member,guide.guide_id)
    assert viewed.status_code==200,viewed.text
    mapped=viewed.json()
    assert set(mapped)=={'guide_id','material_id','revision'}
    assert mapped['guide_id']==guide.guide_id
    material=client.get('/api/materials/'+mapped['material_id'],headers=member.headers).json()
    assert material['published_content']['body']==source
    assert 'draft_content' not in material
    assert resolve(client,member,guide.guide_id).json()==mapped
    assert db.get_guide(guide.guide_id).text==source


@pytest.mark.parametrize('method,path',[(method,path) for method in ('GET','POST','PUT','PATCH','DELETE') for path in ('/api/guides','/api/guides/{id}')]+[('GET','/api/guides/{id}/material')])
def test_retired_guide_api_has_no_route_or_mutation(client,superuser,make_guide,method,path):
    guide=make_guide(owner_block='none',text='Сохранённая история')
    response=client.request(method,path.format(id=guide.guide_id),headers=superuser.headers,json=dict(expected_revision=1,title='Нельзя сохранить',text='Не перезаписывать'))
    assert response.status_code==404,response.text
    assert db.get_guide(guide.guide_id).text=='Сохранённая история'
    assert len(db.list_guides())==1


def test_private_draft_resolution_does_not_disclose_id_or_publish(client,superuser,user,make_guide):
    guide=make_guide(text='Ранняя публикация')
    mapped=resolve(client,superuser,guide.guide_id).json()
    with db._session() as session:
        row=session.get(MaterialORM,mapped['material_id'])
        row.published_body=None;row.has_draft=True;row.draft_body='Приватный черновик'
        session.commit()
    assert resolve(client,user,guide.guide_id).status_code==404
    assert resolve(client,superuser,guide.guide_id).json()==mapped
    material=client.get('/api/materials/'+mapped['material_id'],headers=superuser.headers).json()
    assert material['published_content'] is None and material['draft_content']['body']=='Приватный черновик'
    assert client.get('/api/materials/'+mapped['material_id'],headers=user.headers).status_code==404


def test_shared_draft_does_not_change_publication_and_stale_editor_conflicts(client,superuser,user,make_guide):
    guide=make_guide(text='Исходная публикация')
    mapped=resolve(client,superuser,guide.guide_id).json();mid=mapped['material_id']
    patch=dict(expected_revision=mapped['revision'],content=dict(format='markdown',body='Новый черновик'))
    draft=client.patch('/api/materials/'+mid,headers=superuser.headers,json=patch)
    assert draft.status_code==200,draft.text
    assert client.patch('/api/materials/'+mid,headers=superuser.headers,json=patch).status_code==409
    assert client.get('/api/materials/'+mid,headers=user.headers).json()['published_content']['body']=='Исходная публикация'
    assert 'draft_content' not in client.get('/api/materials/'+mid,headers=user.headers).json()
    published=client.post('/api/materials/'+mid+'/publish',headers=superuser.headers,json=dict(expected_revision=draft.json()['revision']))
    assert published.status_code==200,published.text
    assert resolve(client,user,guide.guide_id).json()['material_id']==mid
    assert db.get_guide(guide.guide_id).text=='Новый черновик'


def test_resolver_keeps_object_editor_rights_and_deleted_ids_unavailable(client,make_master,make_user,make_guide):
    master,block=make_master();outsider=make_user()
    guide=make_guide(owner_block=block.name,text='Своя публикация')
    mapped=resolve(client,master,guide.guide_id).json();mid=mapped['material_id']
    assert resolve(client,outsider,guide.guide_id).status_code==404
    assert client.delete('/api/materials/'+mid,headers=outsider.headers).status_code==403
    removed=client.delete('/api/materials/'+mid,headers=master.headers)
    assert removed.status_code==200,removed.text
    assert resolve(client,master,guide.guide_id).status_code==404
    assert resolve(client,master,999999).status_code==404
    with db._session() as session:
        assert session.get(GuideORM,guide.guide_id).text=='Своя публикация'
