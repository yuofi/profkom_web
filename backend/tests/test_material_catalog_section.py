"""Catalogue placement cannot broaden guide ACL, alter source or create a draft."""
import pytest
from database import db
from domain_models import MaterialRenderArtifactORM
from test_guide_embeds_materials import guide, ok, publish
from test_journal_materials import enabled, save


def move(client, actor, m, section="general", **extra):
    return client.patch('/api/materials/' + m['material_id'], headers=actor.headers,
                        json={'expected_revision': m['revision'], 'catalog_section': section, **extra})


@pytest.mark.parametrize('audience', ['everyone', 'leadership', 'block'])
def test_move_preserves_publication_and_current_acl(client, superuser, user, guide, enabled, audience):
    m = ok(publish(client, superuser, ok(save(client, superuser, guide))))
    m = ok(client.put(f"/api/materials/{m['material_id']}/audience", headers=superuser.headers,
                      json={'expected_revision': m['revision'], 'audience': audience}))
    before_reader = client.get('/api/materials/' + m['material_id'], headers=user.headers)
    with db._session() as s:
        artifact = s.get(MaterialRenderArtifactORM, (m['material_id'], 'published')).render_json
    moved = ok(move(client, superuser, m))
    assert moved == {**m, 'catalog_section': 'general', 'revision': m['revision'] + 1}
    assert 'draft_content' not in moved
    after_reader = client.get('/api/materials/' + m['material_id'], headers=user.headers)
    assert after_reader.status_code == before_reader.status_code == (200 if audience == 'everyone' else 404)
    if after_reader.status_code == 200:
        assert after_reader.json() == {**before_reader.json(), 'catalog_section': 'general', 'revision': moved['revision']}
    listed = next(x for x in ok(client.get('/api/materials', headers=superuser.headers))['items'] if x['material_id'] == m['material_id'])
    assert listed['catalog_section'] == 'general' and listed['kind'] == 'guide' and listed['audience'] == audience
    with db._session() as s:
        assert s.get(MaterialRenderArtifactORM, (m['material_id'], 'published')).render_json == artifact
    # No-op stays idempotent. A stale concurrent writer cannot overwrite placement.
    assert ok(move(client, superuser, moved)) == moved
    assert move(client, superuser, m, section=None).status_code == 409
    reset = ok(move(client, superuser, moved, section=None))
    assert 'catalog_section' not in reset and reset['published_content'] == m['published_content']
    assert reset['revision'] == moved['revision'] + 1


def test_only_chair_team_moves_and_content_commands_are_separate(client, superuser, make_user, guide):
    deputy, master, reader = make_user(), make_user(), make_user()
    lead = ok(client.get('/api/leadership', headers=superuser.headers))
    ok(client.put('/api/leadership/deputies', headers=superuser.headers,
                  json={'expected_revision': lead['revision'], 'user_ids': [deputy.user_id]}))
    block = next(b for b in ok(client.get('/api/blocks', headers=superuser.headers)) if b['block_id'] == guide['owner_block_id'])
    ok(client.put('/api/blocks/' + block['block_id'] + '/leader', headers=superuser.headers,
                  json={'expected_revision': block['revision'], 'user_id': master.user_id}))
    assert move(client, reader, guide).status_code == 404
    assert move(client, master, guide).status_code == 403
    assert move(client, superuser, guide, title='Mixed operation').status_code == 422
    assert move(client, superuser, guide, section='kmb').status_code == 422
    moved = ok(move(client, deputy, guide))
    assert moved['catalog_section'] == 'general'
    assert 'edit_material' in ok(client.get('/api/materials/' + guide['material_id'], headers=master.headers))['capabilities']
    assert move(client, master, moved, section=None).status_code == 403


def test_existing_draft_and_non_guide_are_preserved(client, superuser, guide, enabled):
    draft = ok(save(client, superuser, guide))
    moved = ok(move(client, superuser, draft))
    assert moved == {**draft, 'catalog_section': 'general', 'revision': draft['revision'] + 1}
    general = ok(client.post('/api/materials', headers=superuser.headers,
                            json={'kind':'general','title':'Document','content':{'format':'markdown','body':'text'}}))
    assert move(client, superuser, general).status_code == 422
    assert ok(client.get('/api/materials/' + general['material_id'], headers=superuser.headers)) == general
