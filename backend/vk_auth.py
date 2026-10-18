"""VK verification and explicit identity links; display names never authenticate."""
import json
import os
import urllib.parse
import urllib.request
from fastapi import HTTPException
from database import db
from models import User, ContactInfo


def verified_identity(token: str) -> dict:
    try:
        data=urllib.parse.urlencode({'client_id':os.getenv('VK_CLIENT_ID','54678274'),'access_token':token}).encode()
        request=urllib.request.Request('https://id.vk.ru/oauth2/user_info',data=data)
        with urllib.request.urlopen(request,timeout=10) as response:
            payload=json.loads(response.read())
        user=payload.get('user') if not payload.get('error') else None
        if not user:
            raise ValueError('Invalid response')
    except Exception:
        try:
            url='https://api.vk.com/method/users.get?'+urllib.parse.urlencode({'v':'5.131','access_token':token,'fields':'contacts','lang':'ru'})
            with urllib.request.urlopen(urllib.request.Request(url),timeout=10) as response:
                payload=json.loads(response.read())
            if payload.get('error') or not payload.get('response'):
                raise ValueError('Invalid VK token')
            user=payload['response'][0]
        except Exception:
            raise HTTPException(401,'Failed to verify VK token')
    subject=str(user.get('user_id') or user.get('id') or '').strip()
    if not subject.isdigit() or int(subject)<=0:
        raise HTTPException(401,'Could not identify VK user')
    return {**user,'subject':'vk:'+subject,'vk_id':subject}


def login_user(token: str):
    identity=verified_identity(token)
    user=db.get_external_user(identity['subject'])
    if user:
        if user.banned or user.account_state=='archived':
            raise HTTPException(403,'Account unavailable')
        return user
    # A VK email/name is not proof of ownership of an existing local account.
    email=identity.get('email') or f"vk_{identity['vk_id']}@vk.com"
    if db.get_user_by_email(email):
        email=f"vk_{identity['vk_id']}@vk.com"
    if db.get_user_by_email(email):
        raise HTTPException(409,'Authenticate the existing account to link VK')
    name=identity.get('first_name') or 'VK'
    surname=identity.get('last_name') or 'User'
    user=db.create_user_with_contact(
        ContactInfo(user_id=0,email=email,name=name,surname=surname,kkr_name=f'{name} {surname}',group_number='0',phone=str(identity.get('phone') or identity.get('phone_number') or identity.get('mobile_phone') or ''),vk=f"https://vk.com/id{identity['vk_id']}"),
        User(user_id=0,hashed_password='',group_number='0',account_state='pending'),
    )
    db.link_external_identity(user.user_id,identity['subject'])
    return user
