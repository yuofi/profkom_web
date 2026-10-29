"""Published guide selection and narrow legacy text corrections."""
import json
from database import db, GuideORM
from domain_models import MaterialORM, MigrationORM
from models import Block
from material_updates import migrate_kmb, PUBLIC_COMMUNITY_URL


def test_published_placeholder_is_not_replaced_by_an_unpublished_guide(client, superuser):
    db.create_block(Block(name='Guide fixture', master=''))
    db.set_block_leader('Guide fixture', superuser.user_id)
    card = client.get('/api/blocks/Guide fixture', headers=superuser.headers).json()
    placeholder = card['guide_material_id']
    draft = client.post('/api/materials', headers=superuser.headers, json=dict(kind='guide', owner_block_id=card['block_id'], title='Actual guide', content=dict(format='markdown', body='Published later')))
    assert draft.status_code == 200, draft.text
    assert client.get('/api/blocks/' + card['block_id'], headers=superuser.headers).json()['guide_material_id'] == placeholder
    published = client.post('/api/materials/' + draft.json()['material_id'] + '/publish', headers=superuser.headers, json=dict(expected_revision=draft.json()['revision']))
    assert published.status_code == 200, published.text
    assert client.get('/api/blocks/' + card['block_id'], headers=superuser.headers).json()['guide_material_id'] == published.json()['material_id']


def test_placeholder_vacancy_and_explicit_community_are_visible_without_invented_leader(client, superuser):
    db.create_block(Block(name='Vacant guide fixture', master=''))
    card = client.get('/api/blocks/Vacant guide fixture', headers=superuser.headers).json()
    changed = client.patch('/api/blocks/' + card['block_id'], headers=superuser.headers, json=dict(expected_revision=card['revision'], community_url='https://vk.ru/synthetic_community'))
    assert changed.status_code == 200, changed.text
    body = client.get('/api/materials/' + card['guide_material_id'], headers=superuser.headers).json()
    assert body['placeholder'] and body['community_url'] == 'https://vk.ru/synthetic_community'
    assert PUBLIC_COMMUNITY_URL in body['published_content']['body']
    assert 'Мастер блока пока не назначен' in body['published_content']['body']
    assert 'Обратитесь к мастеру' not in body['published_content']['body']


def test_kmb_correction_is_idempotent_preserves_other_source_and_reports_counts_only(client, superuser):
    source = '# Heading\n>** Synthetic name**\n\nOther ** spaced text** stays\nUnchanged bytes'
    with db._session() as session:
        guide = GuideORM(title='КМБ', text=source, description='', owner_block='none')
        session.add(guide);session.flush()
        material = MaterialORM(material_id='fixture-kmb', kind='kmb', title='КМБ', description='', published_body=source, legacy_guide_id=guide.guide_id, created_at='2026-01-01', revision=1, has_draft=False, placeholder=False, deleted=False)
        session.add(material);session.commit()
        gid = guide.guide_id
    migrate_kmb();migrate_kmb()
    with db._session() as session:
        expected = source.replace('>** Synthetic name**', '>**Synthetic name**')
        assert session.get(MaterialORM, 'fixture-kmb').published_body == expected
        assert session.get(GuideORM, gid).text == expected
        report = json.loads(session.get(MigrationORM, 'kmb-bold-spacing-20261028').report_json)
        assert len(report) == 2 and all(entry['changed_lines'] == 1 for entry in report)
        assert all('Synthetic name' not in str(entry) for entry in report)
