"""Disposable localhost API for frontend HTTP/browser acceptance, never production.

Run from backend/: python tests/live_api.py --port 18080 [--database /tmp/new-test-dir/site.db]
The target must be a new file under the system temporary directory. The port is always
explicit: 18000 belongs to the developer stand. --integration-suite serves a one-time nonce
that the destructive frontend integration suite must present before its first test
(PROFKOM_TEST_API_NONCE overrides the generated value).
"""

import argparse
import os
from pathlib import Path
import secrets
import sys
import tempfile


def install_integration_nonce(app, nonce):
    if os.environ.get("APP_ENV") != "integration-test":
        raise RuntimeError("The integration nonce is served only by the disposable integration API")

    @app.get("/_test/integration-nonce", include_in_schema=False)
    def integration_nonce():
        return {"nonce": nonce}


def install_request_log(app, path):
    """Append 'METHOD /path' for every request, to verify what a client really sent."""

    @app.middleware("http")
    async def log_request(request, call_next):
        with path.open("a", encoding="utf-8") as log:
            log.write(f"{request.method} {request.url.path}\n")
        return await call_next(request)


def serve():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--frontend-origin", default="http://localhost:15173")
    parser.add_argument("--integration-suite", action="store_true")
    parser.add_argument("--request-log", type=Path)
    args = parser.parse_args()
    if args.port == 18000:
        parser.error("Port 18000 belongs to the developer stand; pick another free port")
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
    # Keep one block vacant even when acceptance assigns the IT leader. This
    # exercises nullable bonus recipients in real summary responses and UI.
    db.create_block(Block(name="Integration vacant", master=""))
    from models import Guide

    # A guide from the old site linking to an old public upload: since FIX_PLAN 0.2
    # such links can no longer be added through the API.
    db.create_guide(
        Guide(
            guide_id=0,
            title="Integration legacy guide",
            owner_block="none",
            text="Старый [файл](https://global.s3.cloud.ru/synthetic/guides/%D0%A1%D1%82%D0%B0%D1%80%D1%8B%D0%B9.pdf)",
            description="",
            original_link=None,
        )
    )
    print(f"Disposable integration DB: {database}", flush=True)
    import main
    from live_storage import install

    install(main.app, args.port)
    if args.request_log:
        install_request_log(main.app, args.request_log.resolve())
    if args.integration_suite:
        # Small pages make the suite walk every cursor list page by page (A-EVT-10).
        import api_contract

        api_contract.PAGE_SIZE = 3
        nonce = os.environ.get("PROFKOM_TEST_API_NONCE") or secrets.token_hex(16)
        install_integration_nonce(main.app, nonce)
        print(
            f"PROFKOM_TEST_API_ORIGIN=http://127.0.0.1:{args.port} PROFKOM_TEST_API_NONCE={nonce}",
            flush=True,
        )
    import uvicorn

    uvicorn.run(main.app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    serve()
