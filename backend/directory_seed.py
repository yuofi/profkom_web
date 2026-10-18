"""Avatar migration without auth imports, I/O or remote image retrieval."""
import json
from urllib.parse import urlsplit
from database import db,UserORM
from domain_models import ProfileMetadataORM,MigrationORM
from domain_seed import now

def is_vk_photo(url):
    host=(urlsplit(url or '').hostname or '').lower()
    return any(host==h or host.endswith('.'+h) for h in ('vk.com','vk.ru','vkuserphoto.ru','userapi.com','vk-cdn.net','vkuser.net'))

def migrate_avatars():
    with db.atomic():
        with db._session() as s:
            if s.get(MigrationORM,'v13-avatars'):return
            replaced=[];preserved=[]
            for u in s.query(UserORM):
                m=s.get(ProfileMetadataORM,u.user_id)
                if not m:m=ProfileMetadataORM(user_id=u.user_id,participation_periods_json='[]',preset_id='default');s.add(m)
                if is_vk_photo(u.photo_url):u.photo_url=None;replaced.append(u.user_id)
                elif u.photo_url:m.preset_id=None;preserved.append(u.user_id)
            s.add(MigrationORM(version='v13-avatars',completed_at=now(),report_json=json.dumps(dict(replaced_vk=replaced,preserved_own=preserved))))
            s.commit()

