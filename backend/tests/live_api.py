"""Disposable localhost API for frontend HTTP/browser acceptance, never production.

Run from backend/: python tests/live_api.py --database /tmp/new-test-dir/site.db
The target must be a new file under the system temporary directory.
"""

import argparse
import os
from pathlib import Path
import sys
import tempfile


def serve():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--port", type=int, default=18000)
    parser.add_argument("--frontend-origin", default="http://localhost:15173")
    args = parser.parse_args()
    database = (
        args.database or Path(tempfile.mkdtemp(prefix="profkom-live-")) / "site.db"
    ).resolve()
    temporary_roots = (Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve())
    if (
        not any(database.is_relative_to(root) for root in temporary_roots)
        or database.exists()
    ):
        parser.error("Use a NEW database file under the system temporary directory")
    database.parent.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    os.environ.update(
        DATABASE_PATH=str(database),
        APP_ENV="integration-test",
        JWT_SECRET_KEY="synthetic-local-integration-key-at-least-32-characters",
        S3_ENDPOINT="http://127.0.0.1:1",
        S3_ACCESS_KEY="synthetic",
        S3_SECRET_KEY="synthetic",
        S3_BUCKET_NAME="synthetic",
        S3_TENANT_ID="synthetic",
        S3_REGION_NAME="test",
        FRONTEND_URL=args.frontend_origin,
        ADMIN_NAME="",
        ADMIN_PASSWORD="",
    )
    from scripts.preset_db import set_admin
    from database import db
    from models import Block

    set_admin(
        custom_payload=dict(
            name="Председатель",
            surname="Тестовый",
            email="chair@example.com",
            password="Synthetic-Local-2026",
            group_number="301",
            tg="@profkom_test",
        )
    )
    db.create_block(Block(name="Integration HR", master="", is_hr=True))
    db.set_block_leader(
        "Integration HR", db.get_user_by_email("chair@example.com").user_id
    )
    db.create_block(Block(name="Integration IT", master=""))
    print(f"Disposable integration DB: {database}", flush=True)
    import main
    from live_storage import install

    install(main.app, args.port)
    import uvicorn

    uvicorn.run(main.app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    serve()
