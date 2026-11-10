"""Existing block directory and safe legacy adapters under API 1.3.

Legacy roster injection, physical removal and direct entry remain disabled. The actual
application, substitution, leave and membership history run in test_v13_membership.
"""
import pytest
from database import db,BlockORM


@pytest.mark.parametrize('state',('anonymous','pending','active'))
def test_block_directory_requires_approved_account(client,make_user,make_block,state):
    make_block(name='Медиа');actor=make_user(password=None)
    if state=='pending':db.update_user(actor.user_id,account_state='pending')
    r=client.get('/api/blocks',headers={} if state=='anonymous' else actor.headers)
    assert r.status_code=={'anonymous':401,'pending':403,'active':200}[state]
    if state=='active':
        card=r.json()[0]
        assert card['name']=='Медиа' and card['block_id']!='Медиа'
        assert {'master','members','guide_material_id','revision','capabilities'}<=set(card)
        assert card['guide_material_id'] is not None


@pytest.mark.parametrize('command',('create','delete','enter'))
def test_legacy_mutations_cannot_bypass_existing_blocks_or_membership(client,superuser,make_block,user,command):
    b=make_block()
    if command=='create':r=client.post('/api/blocks',headers=superuser.headers,json=dict(name='New',master='Nobody',hr='',cnt_of_human=0,arr_of_human=[]))
    elif command=='delete':r=client.delete('/api/blocks/'+b.name,headers=superuser.headers)
    else:r=client.post('/api/blocks/'+b.name+'/enter',headers=user.headers,json={})
    assert r.status_code==(422 if command=='create' else 409),r.text
    assert db.get_block(b.name) is not None and db.get_block('New') is None
    assert not db.is_block_member(user.user_id,b.name)


@pytest.mark.parametrize('injected',('master','master_user_id','members','arr_of_human','is_hr'))
def test_block_patch_cannot_directly_change_roster(client,superuser,make_block,injected):
    b=make_block();card=client.get('/api/blocks',headers=superuser.headers).json()[0]
    r=client.patch('/api/blocks/'+card['block_id'],headers=superuser.headers,json=dict(expected_revision=card['revision'],**{injected:[]}))
    assert r.status_code==422
    assert db.get_block(b.name).arr_of_human==[]


def test_master_assignment_is_independent_of_ordinary_membership_and_name(client,superuser,make_user,make_block):
    target=make_user(name='Same',surname='Name');same=make_user(name='Same',surname='Name');b=make_block(master=target.kkr_name)
    assert not db.is_block_master(target.user_id,b.name) and not db.is_block_master(same.user_id,b.name)
    card=client.get('/api/blocks',headers=superuser.headers).json()[0]
    r=client.put('/api/blocks/'+card['block_id']+'/leader',headers=superuser.headers,json=dict(expected_revision=card['revision'],user_id=target.user_id))
    assert r.status_code==200,r.text
    assert db.is_block_master(target.user_id,b.name) and not db.is_block_master(same.user_id,b.name)
    assert not db.is_block_member(target.user_id,b.name)
    assert r.json()['master']['user']['user_id']==target.user_id


def test_block_rename_preserves_id_material_and_member_history(client,superuser,make_block):
    b=make_block();card=client.get('/api/blocks',headers=superuser.headers).json()[0]
    r=client.patch('/api/blocks/'+card['block_id'],headers=superuser.headers,json=dict(expected_revision=card['revision'],name='Новое имя',description=dict(format='markdown',body='Описание')))
    assert r.status_code==200,r.text
    assert r.json()['block_id']==card['block_id'] and r.json()['guide_material_id']==card['guide_material_id']
    assert db.get_block(b.name) is None


def test_block_page_marks_the_guide_link_only_for_its_readers(client,superuser,make_user,make_block):
    """GL-10: the guide link of a block page opens only for who may read the guide."""
    member,outsider=make_user(),make_user()
    make_block(name='Гайдовый',arr_of_human=[member.user_id])
    bid=client.get('/api/blocks',headers=superuser.headers).json()[0]['block_id']
    cards={who:client.get('/api/blocks/'+bid,headers=actor.headers).json() for who,actor in (('member',member),('outsider',outsider),('chair',superuser))}
    assert {card['guide_material_id'] for card in cards.values()}!={None}
    assert len({card['guide_material_id'] for card in cards.values()})==1
    assert 'read_guide' in cards['member']['capabilities'] and 'read_guide' in cards['chair']['capabilities']
    assert 'read_guide' not in cards['outsider']['capabilities']
    guide=cards['member']['guide_material_id']
    assert client.get('/api/materials/'+guide,headers=outsider.headers).status_code==404
    assert client.get('/api/materials/'+guide,headers=member.headers).status_code==200
    # The directory of all blocks keeps its per-card cost: no material ACL per card.
    assert all('read_guide' not in card['capabilities'] for card in client.get('/api/blocks',headers=member.headers).json())
