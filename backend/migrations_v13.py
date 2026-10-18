"""Idempotent domain migration; string names and legacy flags never grant roles."""
import json,uuid
from database import db,UserORM,ContactInfoORM,BlockORM,RoleAssignmentORM
from domain_models import MigrationORM
from domain_seed import ensure_application,now


def migrate_core():
    from domain_seed import meta_for,seed_members
    with db.atomic():
        with db._session() as s:
            if s.get(MigrationORM,'v13-membership'):return
            report={'users':0,'blocks':0,'unmapped_block_ids':[],'unknown_participation_dates':[]}
            for u in s.query(UserORM):
                c=s.get(ContactInfoORM,u.user_id)
                if not c:continue
                if u.account_state!='archived':u.account_state='active' if c.in_profcom and not u.banned else 'pending'
                ensure_application(s,u.user_id)
                report['users']+=1
                if u.account_state=='active':report['unknown_participation_dates'].append(u.user_id)
            for b in s.query(BlockORM):
                m=meta_for(s,b.name);seed_members(s,b,m);report['blocks']+=1
                if b.master and not b.master_user_id:report['unmapped_block_ids'].append(m.block_id)
                if b.master_user_id and s.get(UserORM,b.master_user_id):
                    if not s.query(RoleAssignmentORM).filter_by(scope_kind='block',scope_id=b.name,role='master').first():s.add(RoleAssignmentORM(role_assignment_id=str(uuid.uuid4()),user_id=b.master_user_id,role='master',scope_kind='block',scope_id=b.name,revision=1))
            s.add(MigrationORM(version='v13-membership',completed_at=now(),report_json=json.dumps(report)))
            s.commit()
