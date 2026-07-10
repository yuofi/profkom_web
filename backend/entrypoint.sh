#!/bin/sh

set -e
python ./scripts/preset_db.py
exec uvicorn main:app --host 0.0.0.0 --port 8000