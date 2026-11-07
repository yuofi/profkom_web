"""Prints the hash of a new service-account password for ROOT_PASSWORD_HASH in backend/.env
(backend/docs/SERVICE_ACCOUNT.md). The password is read twice without echo and is never
printed, logged or stored; only the hash is printed.

    cd backend && python scripts/service_password_hash.py
"""
import getpass
import os
import sys
import tempfile

MIN_LENGTH = 12


def main():
    password = getpass.getpass("Пароль сервисного аккаунта: ")
    if len(password) < MIN_LENGTH or not password.strip():
        sys.exit(f"Нужен пароль не короче {MIN_LENGTH} символов.")
    if getpass.getpass("Повторите пароль: ") != password:
        sys.exit("Пароли не совпадают.")
    with tempfile.TemporaryDirectory() as scratch:
        # auth opens a database on import: a throwaway one here, never the site's.
        os.environ["DATABASE_PATH"] = os.path.join(scratch, "scratch.db")
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from auth import hash_password  # the site's own password hash
        print(hash_password(password))


if __name__ == "__main__":
    main()
