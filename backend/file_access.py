"""Private file contexts, attachment checks and verified object storage I/O."""
import json
from pathlib import PurePath
from datetime import datetime,timezone,timedelta
from fastapi import HTTPException
from botocore.exceptions import ClientError
from database import db,FileRecordORM,TaskORM,AssignmentORM,ReportORM,ReportVersionORM
from utils.s3_service import s3_client
from settings import settings

TYPES={'image/png':('png',),'image/jpeg':('jpg','jpeg'),'image/webp':('webp',),'application/pdf':('pdf',),'application/zip':('zip',),'application/vnd.openxmlformats-officedocument.wordprocessingml.document':('docx',),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':('xlsx',),'application/vnd.openxmlformats-officedocument.presentationml.presentation':('pptx',),'application/msword':('doc',),'application/vnd.ms-excel':('xls',),'application/vnd.ms-powerpoint':('ppt',),'text/plain':('txt',)}

def now():return datetime.now(timezone.utc)
def key(fid):return 'private/'+fid

def validate_metadata(kind,purpose,name,mime,size):
    limit=10 if kind=='avatar' else 20
    if not 0<size<=limit*1024*1024:raise ValueError(f'File size must be between 1 byte and {limit} MiB')
    if not name or '/' in name or '\\' in name or any(ord(c)<32 for c in name):raise ValueError('Invalid file name')
    ext=name.rsplit('.',1)[-1].lower()
    if mime not in TYPES or ext not in TYPES[mime]:raise ValueError('File type is not allowed')
    if kind=='avatar' and mime not in ('image/png','image/jpeg','image/webp'):raise ValueError('Avatar must be PNG, JPEG or WebP')
    if (kind=='avatar' and purpose!='avatar') or (kind=='report' and purpose!='report') or (kind=='assignment' and purpose!='submission'):raise ValueError('Invalid file purpose')

def permitted(session,fr,uid,write=False):
    u=db.get_user(uid)
    if not u or u.banned or u.account_state!='active':return False
    if fr.owner_kind=='avatar':
        if str(uid)==fr.owner_id:return True
        if write:return False
        from domain_models import ProfileMetadataORM
        owner=db.get_user(int(fr.owner_id))
        meta=session.get(ProfileMetadataORM,int(fr.owner_id))
        return bool(owner and owner.account_state=='active' and not owner.banned and meta and meta.avatar_file_id==fr.file_id)
    if fr.owner_kind in ('assignment','task'):
        if fr.owner_kind=='assignment':
            a=session.get(AssignmentORM,fr.owner_id)
            if not a or (write and a.assignee_user_id!=uid):return False
            task=session.get(TaskORM,a.task_id)
        else:task=session.get(TaskORM,fr.owner_id)
        return bool(task and db.can_view_scope(uid,task.scope_kind,task.scope_id))
    if fr.owner_kind=='report':
        r=session.get(ReportORM,fr.owner_id)
        if not r:return False
        if db.is_report_editor(uid,r,session):return True
        if write:return False
        if not db.can_read_report(uid,r,session):return False
        published=set(json.loads(r.files_json or '[]')) if r.state=='published' else set()
        for v in session.query(ReportVersionORM).filter_by(report_id=r.report_id):published.update(json.loads(v.files_json or '[]'))
        return fr.file_id in published
    if fr.owner_kind=='material':
        from materials import can_read, can_edit
        return can_edit(fr.owner_id,uid) if write else can_read(fr.owner_id,uid)
    if fr.owner_kind=='pgas':return bool(db.is_chair(uid) or u.pgas_admin) if write else True
    return False

def presign_upload(fr):
    return s3_client.generate_presigned_url('put_object',Params={'Bucket':settings.S3_BUCKET_NAME,'Key':key(fr.file_id),'ContentType':fr.mime_type},ExpiresIn=900)

def verify_object(fr):
    try:
        metadata=s3_client.head_object(Bucket=settings.S3_BUCKET_NAME,Key=key(fr.file_id))
        sample=s3_client.get_object(Bucket=settings.S3_BUCKET_NAME,Key=key(fr.file_id),Range='bytes=0-511')['Body'].read()
    except ClientError as e:
        if e.response.get('Error',{}).get('Code') in ('404','NoSuchKey','NotFound'):
            raise HTTPException(409,'Uploaded object not found')
        raise HTTPException(503,'Object storage unavailable')
    if metadata['ContentLength']!=fr.size_bytes or metadata.get('ContentType','').split(';')[0]!=fr.mime_type:raise HTTPException(422,'Uploaded object metadata mismatch')
    checks={'image/png':sample.startswith(b'\x89PNG\r\n\x1a\n'),'image/jpeg':sample.startswith(b'\xff\xd8\xff'),'image/webp':sample.startswith(b'RIFF') and sample[8:12]==b'WEBP','application/pdf':sample.startswith(b'%PDF-')}
    valid=checks.get(fr.mime_type)
    if fr.mime_type in ('application/zip',) or 'openxmlformats' in fr.mime_type:valid=sample.startswith(b'PK\x03\x04')
    if fr.mime_type in ('application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'):valid=sample.startswith(bytes.fromhex('d0cf11e0a1b11ae1'))
    if valid is False:raise HTTPException(422,'Uploaded file content does not match type')

def complete(fid,uid):
    with db._session() as s:
        fr=s.get(FileRecordORM,fid)
        if not fr or fr.uploaded_by_user_id!=uid or not permitted(s,fr,uid,True):raise HTTPException(404,'File not found')
        if fr.state!='completed':
            if datetime.fromisoformat(fr.expires_at)<now():raise HTTPException(409,'Upload intent expired')
            verify_object(fr);fr.state='completed';s.commit()
        return dict(file_id=fr.file_id,name=fr.name,mime_type=fr.mime_type,size_bytes=fr.size_bytes)

def download(fid,uid):
    with db._session() as s:
        fr=s.get(FileRecordORM,fid)
        if not fr or fr.state!='completed' or not permitted(s,fr,uid):raise HTTPException(404,'File not found')
        url=s3_client.generate_presigned_url('get_object',Params={'Bucket':settings.S3_BUCKET_NAME,'Key':key(fid),'ResponseContentDisposition':'attachment'},ExpiresIn=300)
        return dict(download_url=url,expires_at=(now()+timedelta(seconds=300)).isoformat())

def check_attachments(session,file_ids,kind,owner_id,uid):
    if len(file_ids)!=len(set(file_ids)):raise ValueError('Duplicate files')
    for fid in file_ids:
        fr=session.get(FileRecordORM,fid)
        if not fr or fr.state!='completed' or fr.owner_kind!=kind or fr.owner_id!=owner_id or not permitted(session,fr,uid,True):raise ValueError('Forbidden: invalid attachment or context')
