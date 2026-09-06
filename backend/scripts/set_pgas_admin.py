import argparse
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Импорт database выполняет миграции схемы, поэтому скрипт работает
# и на боевой базе, созданной до появления раздела ПГАС.
from database import db


def find_user(email=None, user_id=None, kkr_name=None):
    """Ищет пользователя одним из трёх способов. Возвращает User или None."""
    if email is not None:
        return db.get_user_by_email(email)
    if user_id is not None:
        return db.get_user(user_id)
    return db.get_user_by_name(kkr_name)


def describe(user):
    """Строка вида '#12 Иван Петров <ivan@example.com>' для вывода в консоль."""
    contact = db.get_contact(user.user_id)
    kkr_name = contact.kkr_name if contact else ""
    email = contact.email if contact else ""
    return f"#{user.user_id} {kkr_name} <{email}>"


def list_pgas_admins():
    """Печатает всех, у кого сейчас есть права на раздел ПГАС."""
    admins = [
        db.get_user(c.user_id)
        for c in db.list_contacts()
    ]
    admins = [u for u in admins if u and u.pgas_admin]
    if not admins:
        print("Пользователей с правами ПГАС нет.")
        return
    print(f"Пользователи с правами ПГАС ({len(admins)}):")
    for u in admins:
        print(f"  {describe(u)}")


def set_pgas_admin(user, revoke=False):
    """Выдаёт или снимает права ПГАС и печатает результат."""
    if revoke:
        if not user.pgas_admin:
            print(f"У пользователя {describe(user)} прав ПГАС и так нет. Пропуск.")
            return
        db.update_user(user.user_id, pgas_admin=False)
        print(f"Права ПГАС сняты у пользователя {describe(user)}.")
        return

    if user.pgas_admin:
        print(f"У пользователя {describe(user)} права ПГАС уже есть. Пропуск.")
        return
    db.update_user(user.user_id, pgas_admin=True)
    print(f"Права ПГАС выданы пользователю {describe(user)}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Выдать или снять роль pgas_admin (раздел ПГАС)."
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--email", help="Почта пользователя")
    target.add_argument("--user-id", type=int, help="ID пользователя")
    target.add_argument("--kkr-name", help="Имя ККР пользователя")
    parser.add_argument("--revoke", action="store_true", help="Снять роль вместо выдачи")
    parser.add_argument("--list", action="store_true", help="Показать всех, у кого есть роль")
    args = parser.parse_args()

    if args.list:
        list_pgas_admins()
        sys.exit(0)

    if args.email is None and args.user_id is None and args.kkr_name is None:
        print("Укажите пользователя: --email, --user-id или --kkr-name (либо --list).")
        sys.exit(1)

    found = find_user(email=args.email, user_id=args.user_id, kkr_name=args.kkr_name)
    if not found:
        print("Пользователь не найден.")
        sys.exit(1)

    set_pgas_admin(found, revoke=args.revoke)
