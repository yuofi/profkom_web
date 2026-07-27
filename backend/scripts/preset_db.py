import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from settings import settings 
from main import ContactInfo, User, hash_password

from database import db
from models import Guide

def preset_guides():
    """
    Presets guides in the database by reading markdown files from public/md.
    Equivalent to the TypeScript presetGuides implementation.
    """
    # Equivalent to path.resolve(process.cwd(), "public", "md")
    md_dir = os.path.join(os.getcwd(), "./", "md")
    
    names = ["гайды", "информация", "КМБ"]
    
    for name in names:
        file_path = os.path.join(md_dir, f"{name}.md")
        
        try:
            if not os.path.exists(file_path):
                print(f"Ошибка: файл не найден: {file_path}")
                continue
                
            with open(file_path, "r", encoding="utf-8") as f:
                text = f.read()
            
            guide = Guide(
                guide_id=0,  # SQLite auto-increment will handle the actual ID
                title=name,
                owner_block="none",
                text=text,
                original_link=None
            )
            
            db.create_guide(guide)
            print(f"Успешно сохранен гайд: {name}")
            
        except Exception as err:
            print(f"Ошибка при обработке файла {name}.md: {err}")

def set_admin(superadmin: bool, custom_payload=None):
    payload = custom_payload
    if (custom_payload is None):
        payload = {
            "name": settings.ADMIN_NAME,
            "password": settings.ADMIN_PASSWORD,
            "surname": "",
            "patronymic": "",
            "group_number": 0,
            "tg": "",
            "email": f'{settings.ADMIN_NAME}@example.com',
        }
    contact_model = ContactInfo(
        user_id=0,
        surname=payload["surname"],
        name=payload["name"],
        patronymic=payload["patronymic"],
        kkr_name=f"{payload['surname']} {payload['name']}".strip(),
        group_number=str(payload["group_number"]),
        location="",
        blocks="",
        phone="",
        vk="",
        tg=payload["tg"],
        email=str(payload["email"]),
        budget=False,
        in_profcom=True,
    )
    user_model = User(
        user_id=0,
        hashed_password=hash_password(payload["password"]),   # ← hash!
        kkr_score=0,
        group_number=str(payload["group_number"]),
        blocks="",
        banned=False,
        super_user=superadmin,
        admin=True,
    )
    db.create_user_with_contact(contact_model, user_model)
    rights = "superadmin" if superadmin else "admin"
    print(f"Админ создан успешно. Логин: {payload["email"]} Права: {rights}")

if __name__ == "__main__":
    preset_guides()
    set_admin(superadmin=True)

    # payload = {
    #         "name": "Admin",
    #         "password": "12345678",
    #         "surname": "Adminovich",
    #         "patronymic": "",
    #         "group_number": 0,
    #         "tg": "",
    #         "email": f'test_email@vk.com',
    #     }

    # set_admin(superadmin=False, custom_payload=payload)