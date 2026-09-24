import sys
import os
sys.path.append(os.getcwd())
from database import Database

db = Database()
u = db.get_user(1)
print(u.events_roles)
