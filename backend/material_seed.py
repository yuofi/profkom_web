"""Explicit guide-ID mapping and published block placeholders, without role inference."""
import uuid,hashlib,json
from sqlalchemy import func
from database import db,GuideORM,BlockORM
from domain_models import MaterialORM,BlockMetaORM,MigrationORM
from domain_seed import meta_for,now
from legacy_markup import to_markdown


def seed_materials():
    with db.atomic():
        with db._session() as s:
            if s.get(MigrationORM,'v13-materials'):return
            report={}
            for g in s.query(GuideORM):
                if s.query(MaterialORM).filter_by(legacy_guide_id=g.guide_id).first():continue
                owner=(g.owner_block or '').strip();bid=None
                if owner.lower() not in ('','none','all'):
                    matches=s.query(BlockORM).filter(func.lower(BlockORM.name)==owner.lower()).all()
                    if len(matches)==1:bid=meta_for(s,matches[0].name).block_id
                kind='guide' if bid else ('kmb' if g.title.strip().lower()=='кмб' else 'general')
                s.add(MaterialORM(material_id=str(uuid.uuid5(uuid.NAMESPACE_URL,'profkom:guide:'+str(g.guide_id))),legacy_guide_id=g.guide_id,kind=kind,owner_block_id=bid,title=g.title,description=g.description or '',original_link=g.original_link,published_body=to_markdown(g.text or ''),has_draft=False,revision=1,placeholder=False,deleted=False,created_at=now()))
                report[str(g.guide_id)]=hashlib.sha256((g.text or '').encode()).hexdigest()
            s.flush()
            for b in s.query(BlockORM):
                bid=meta_for(s,b.name).block_id
                if not s.query(MaterialORM).filter_by(owner_block_id=bid,deleted=False).first():s.add(MaterialORM(material_id=str(uuid.uuid4()),kind='guide',owner_block_id=bid,title='Гайд '+b.name,description='Материалы блока',published_body='Материалы блока готовятся. Обратитесь к мастеру.',has_draft=False,revision=1,placeholder=True,deleted=False,created_at=now()))
            s.add(MigrationORM(version='v13-materials',completed_at=now(),report_json=json.dumps(report)));s.commit()
