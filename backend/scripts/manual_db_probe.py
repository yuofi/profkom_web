"""Manual developer probe of a local database; not a test. Run from backend/: python scripts/manual_db_probe.py"""
import sys
import os
sys.path.append(os.getcwd())
from database import Database

db = Database()
u = db.get_user(1)
print(u.events_roles)
