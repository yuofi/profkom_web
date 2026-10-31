#!/bin/sh

set -e
python ./scripts/preset_db.py
# nginx of the frontend container is the only proxy: its X-Forwarded-For names the real client,
# so per-client limits (anonymous feedback) do not share nginx's address (GL-25). Docker gives
# compose networks addresses from 172.16.0.0/12 (now 172.19.0.0/16); the network is not
# pinned because recreating it would break the Marzban blocks on its gateway (DEPLOY.md).
exec uvicorn main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-172.16.0.0/12}"
