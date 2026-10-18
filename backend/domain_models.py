"""Persistence for registrations, membership history and stable block metadata."""
from sqlalchemy import Column,Integer,String,Text,Boolean,ForeignKey,Index,text
from database import Base

class RegistrationORM(Base):
    __tablename__='registration_applications'
    user_id=Column(Integer,ForeignKey('users.user_id'),primary_key=True)
    status=Column(String,nullable=False,default='pending')
    fields_json=Column(Text,nullable=False,default='{}')
    attempts_used=Column(Integer,nullable=False,default=1)
    total_submissions=Column(Integer,nullable=False,default=1)
    rejection_reason=Column(Text,nullable=True)
    revision=Column(Integer,nullable=False,default=1)
    history_json=Column(Text,nullable=False,default='[]')

class ParticipationORM(Base):
    __tablename__='participation_intervals'
    interval_id=Column(String,primary_key=True)
    participant_id=Column(String,nullable=False,index=True)
    user_id=Column(Integer,nullable=True,index=True)
    started_at=Column(String,nullable=False)
    ended_at=Column(String,nullable=True)
    __table_args__=(Index('one_active_participation',user_id,unique=True,sqlite_where=text('ended_at IS NULL')),)

class BlockMetaORM(Base):
    __tablename__='block_metadata'
    block_id=Column(String,primary_key=True)
    legacy_name=Column(String,nullable=False,unique=True)
    description=Column(Text,nullable=False,default='')
    community_url=Column(String,nullable=True)
    revision=Column(Integer,nullable=False,default=1)

class MembershipORM(Base):
    __tablename__='memberships'
    membership_id=Column(String,primary_key=True)
    user_id=Column(Integer,nullable=True,index=True)
    participant_id=Column(String,nullable=False,index=True)
    block_id=Column(String,ForeignKey('block_metadata.block_id'),nullable=False,index=True)
    category=Column(String,nullable=False,default='junior')
    joined_at=Column(String,nullable=True) # Unknown migration dates are never invented.
    left_at=Column(String,nullable=True)
    __table_args__=(Index('one_active_membership',user_id,block_id,unique=True,sqlite_where=text('left_at IS NULL')),)

class BlockApplicationORM(Base):
    __tablename__='block_applications'
    request_id=Column(String,primary_key=True)
    user_id=Column(Integer,ForeignKey('users.user_id'),nullable=False,index=True)
    block_id=Column(String,ForeignKey('block_metadata.block_id'),nullable=False,index=True)
    state=Column(String,nullable=False,default='pending_hr')
    created_at=Column(String,nullable=False)
    stage_entered_at=Column(String,nullable=False)
    revision=Column(Integer,nullable=False,default=1)
    history_json=Column(Text,nullable=False,default='[]')
    __table_args__=(Index('one_open_block_application',user_id,block_id,unique=True,sqlite_where=text("state IN ('pending_hr','pending_block')")),)

class CategoryRevisionORM(Base):
    __tablename__='category_revisions'
    user_id=Column(Integer,primary_key=True)
    revision=Column(Integer,nullable=False,default=1)

class MigrationORM(Base):
    __tablename__='domain_migrations'
    version=Column(String,primary_key=True)
    completed_at=Column(String,nullable=False)
    report_json=Column(Text,nullable=False)

class ScopeTenureORM(Base):
    __tablename__='scope_tenures'
    tenure_id=Column(String,primary_key=True)
    user_id=Column(Integer,nullable=True,index=True)
    scope_kind=Column(String,nullable=False,index=True)
    scope_id=Column(String,nullable=False,index=True)
    role=Column(String,nullable=False)
    principal_id=Column(String,nullable=True)
    started_at=Column(String,nullable=False)
    ended_at=Column(String,nullable=True)
