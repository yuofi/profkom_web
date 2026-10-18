"""Use configured credentials only; never reset an existing account password."""
from scripts.preset_db import set_admin

if __name__=='__main__':
    set_admin()
