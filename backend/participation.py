"""Participation is measured from persisted active/approved intervals, not scores."""
from datetime import datetime,timezone
import uuid
from database import db,UserORM
from domain_models import ParticipationORM,MembershipORM,CategoryRevisionORM
from registration import now,audit


def dt(value):
    d=datetime.fromisoformat(value.replace('Z','+00:00')) if isinstance(value,str) else value
    if d.tzinfo is None:raise ValueError('Timezone is required')
    return d.astimezone(timezone.utc)

def merged(intervals):
    result=[]
    for a,b in sorted((a,b) for a,b in intervals if b>a):
        if result and a<=result[-1][1]:result[-1]=(result[-1][0],max(result[-1][1],b))
        else:result.append((a,b))
    return result

def participation_seconds(session,participant_id,starts,ends,closed_at,block_id=None):
    a=dt(starts);b=min(dt(ends),dt(closed_at))
    if b<=a:return 0.0
    active=[]
    for r in session.query(ParticipationORM).filter_by(participant_id=participant_id):active.append((max(a,dt(r.started_at)),min(b,dt(r.ended_at) if r.ended_at else b)))
    active=merged(active)
    if block_id is not None:
        members=[]
        for m in session.query(MembershipORM).filter_by(participant_id=participant_id,block_id=block_id):
            if m.joined_at:members.append((max(a,dt(m.joined_at)),min(b,dt(m.left_at) if m.left_at else b)))
        active=merged((max(x,a),min(y,b)) for x,y in active for a,b in members)
    return sum((y-x).total_seconds() for x,y in active)

def promote(session,season,closed_at):
    duration=(dt(season.ends_at)-dt(season.starts_at)).total_seconds()
    if duration<=0:raise ValueError('Invalid season interval')
    threshold=duration/2
    for u in session.query(UserORM).filter_by(category='junior'):
        amount=participation_seconds(session,f'participant-{u.user_id}',season.starts_at,season.ends_at,closed_at)
        if amount>=threshold:
            u.category='activist'
            rev=session.get(CategoryRevisionORM,u.user_id)
            if rev:rev.revision+=1
            else:session.add(CategoryRevisionORM(user_id=u.user_id,revision=2))
            audit(session,'participant_category',u.user_id,0,'Automatic promotion',dict(category='junior'),dict(category='activist',season_id=season.season_id,participation=amount,threshold=threshold))
    for m in session.query(MembershipORM).filter_by(category='junior'):
        amount=participation_seconds(session,m.participant_id,season.starts_at,season.ends_at,closed_at,m.block_id)
        if amount>=threshold:
            m.category='member'
            audit(session,'membership',m.membership_id,0,'Automatic block promotion',dict(category='junior'),dict(category='member',season_id=season.season_id,participation=amount,threshold=threshold))

def close_intervals(session,uid,at):
    for row in session.query(ParticipationORM).filter_by(user_id=uid,ended_at=None):row.ended_at=at

def open_interval(session,uid,at):
    if not session.query(ParticipationORM).filter_by(user_id=uid,ended_at=None).first():session.add(ParticipationORM(interval_id=str(uuid.uuid4()),participant_id=f'participant-{uid}',user_id=uid,started_at=at))
