import sys
import os
sys.path.append(os.getcwd())
from database import Database, UserORM, ContactInfoORM
from models import ContactInfo as ContactInfoDC, User as UserDC
from auth import hash_password

db = Database()

# First check if admin already exists
with db._session() as session:
    c = session.query(ContactInfoORM).filter(ContactInfoORM.email == "admin@admin.com").first()
    if c:
        u = session.get(UserORM, c.user_id)
        if u:
            u.hashed_password = hash_password("admin123")
            session.commit()
            print("Updated existing admin")
            sys.exit(0)

contact = ContactInfoDC(
    user_id=0,
    surname="Admin",
    name="Admin",
    patronymic="",
    kkr_name="Admin Admin",
    group_number="101",
    location="",
    blocks="Админка",
    phone="+79999999999",
    vk="",
    tg="@admin",
    email="admin@admin.com",
    budget=True,
    in_profcom=True
)

user = UserDC(
    user_id=0,
    hashed_password=hash_password("admin123"),
    kkr_score=0,
    group_number="101",
    blocks="Админка",
    banned=False,
    super_user=True,
    admin=True,
    photo_url=None
)

db.create_user_with_contact(contact, user)
print("Created new admin")
