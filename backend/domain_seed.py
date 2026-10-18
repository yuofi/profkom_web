"""Shared migration seeds. Unknown historical dates remain unknown."""
import json,uuid
from datetime import datetime,timezone
from fastapi import HTTPException
from database import db,UserORM,ContactInfoORM,BlockORM
from domain_models import RegistrationORM,BlockMetaORM,MembershipORM

def now():return datetime.now(timezone.utc).isoformat()
def fail(code,message):raise HTTPException(code,message)

def ensure_application(s,uid):
    r=s.get(RegistrationORM,uid)
    if r:return r
    u=s.get(UserORM,uid);c=s.get(ContactInfoORM,uid)
    if not u or not c:fail(404,'Account not found')
    fields=dict(surname=c.surname,name=c.name,patronymic=c.patronymic or None,group_number=c.group_number,phone=c.phone,email=c.email,tg=c.tg,vk=c.vk,funding='budget' if c.budget else 'contract',residence=c.location)
    r=RegistrationORM(user_id=uid,status='approved' if u.account_state=='active' else 'pending',fields_json=json.dumps(fields,ensure_ascii=False),attempts_used=1,total_submissions=1,revision=1,history_json=json.dumps([dict(action='initial_submission',at=now(),actor=uid)]))
    s.add(r);s.flush();return r


def meta_for(s,name):
    m=s.query(BlockMetaORM).filter_by(legacy_name=name).first()
    if not m:
        if not s.get(BlockORM,name):fail(404,'Block not found')
        m=BlockMetaORM(block_id=str(uuid.uuid5(uuid.NAMESPACE_URL,'profkom:block:'+name)),legacy_name=name,description='',revision=1)
        s.add(m);s.flush()
    return m


def seed_members(s,b,m):
    # Existing membership is preserved, with an explicitly unknown start date.
    for uid in json.loads(b.arr_of_human or '[]'):
        if s.get(UserORM,uid) and not s.query(MembershipORM).filter_by(user_id=uid,block_id=m.block_id,left_at=None).first():
            s.add(MembershipORM(membership_id=str(uuid.uuid4()),user_id=uid,participant_id=f'participant-{uid}',block_id=m.block_id,category='junior',joined_at=None))
    s.flush()

