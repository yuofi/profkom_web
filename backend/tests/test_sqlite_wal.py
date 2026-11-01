"""PB-31 (owner 2026-10-31): SQLite works in WAL with synchronous=FULL.

With SQLITE_JOURNAL_MODE=WAL (this suite runs so, conftest) every new connection of the
application keeps WAL and synchronous=FULL; an existing rollback-journal database keeps
its rows and indexes, and without the setting it keeps or returns to the rollback
journal. Acknowledged commits survive a killed writer, the backup of DEPLOY.md is
consistent while writes run and after a stop, units that read before they write never
fail with SQLITE_BUSY while other writers commit, an HTTP read right after an acknowledged
write sees it, and a stopped backend or script leaves only the database file. The
migration scripts hash the file before they open it.
"""
import hashlib
import json
import os
import random
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

import database
from database import db, engine, UserORM
from read_context import reusable
from settings import Settings
from test_v13_tracker import work  # noqa: F401 - the fixture

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
SCRIPTS = BACKEND / "scripts"


def pragmas(connection):
    return [connection.execute(f"PRAGMA {name}").fetchone()[0] for name in ("journal_mode", "synchronous")]


def test_every_new_connection_is_wal_with_full_sync():
    pool = engine.pool.recreate()  # the listeners of the engine, no pooled connection
    try:
        connection = pool.connect()
        try:
            cursor = connection.cursor()
            assert pragmas(cursor) == ["wal", 2]
            cursor.close()
        finally:
            connection.close()
    finally:
        pool.dispose()
    with closing(sqlite3.connect(engine.url.database)) as other:  # the mode is stored in the file
        assert other.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_a_new_connection_inside_a_read_unit_keeps_its_memo(make_user):
    user = make_user()
    engine.dispose()  # the read unit below opens a new connection
    with db.atomic(write=False):
        with db._session() as session:
            assert session.get(UserORM, user.user_id) is not None
            assert reusable(session)
            cursor = session.connection().connection.dbapi_connection.cursor()
            assert pragmas(cursor) == ["wal", 2]
            cursor.close()
            assert reusable(session)


OLD = """
CREATE TABLE block(name VARCHAR PRIMARY KEY, master VARCHAR NOT NULL, hr VARCHAR NOT NULL DEFAULT '',
  cnt_of_human INTEGER NOT NULL DEFAULT 0, arr_of_human TEXT NOT NULL DEFAULT '[]');
CREATE TABLE notifications(notification_id VARCHAR PRIMARY KEY, user_id INTEGER NOT NULL, kind VARCHAR NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}', is_read BOOLEAN NOT NULL DEFAULT 0, created_at VARCHAR NOT NULL);
CREATE INDEX custom_notification_index ON notifications(user_id);
INSERT INTO block(name, master) VALUES ('Старый', 'Мастер');
INSERT INTO notifications VALUES ('n1', 7, 'kind', '{}', 0, 'same'), ('n2', 7, 'kind', '{}', 1, 'later');
"""


def old_database(path):
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(OLD)
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "delete"


def state(path):
    with closing(sqlite3.connect(path)) as connection:
        rows = {t: connection.execute(f"SELECT * FROM {t} ORDER BY rowid").fetchall() for t in ("block", "notifications")}
        schema = connection.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall()
        return connection.execute("PRAGMA journal_mode").fetchone()[0], rows, schema, connection.execute("PRAGMA integrity_check").fetchone()[0]


def start(path, mode):
    """`import database` in a new process, as the API and every script start. Without `mode`
    the process has no SQLITE_JOURNAL_MODE: no variable and no .env in its folder."""
    env = {k: v for k, v in os.environ.items() if k != "SQLITE_JOURNAL_MODE"}
    env.update(DATABASE_PATH=str(path), PYTHONPATH=os.pathsep.join(filter(None, [str(BACKEND), os.environ.get("PYTHONPATH")])))
    if mode:
        env["SQLITE_JOURNAL_MODE"] = mode
    result = subprocess.run([sys.executable, "-c", "import database"], cwd=path.parent, capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    return state(path)


def test_a_rollback_journal_database_switches_to_wal_and_back(tmp_path):
    path = tmp_path / "old-journal.db"
    old_database(path)
    mode, rows, schema, check = start(path, "WAL")
    assert mode == "wal" and check == "ok"
    assert rows["block"][0][:2] == ("Старый", "Мастер")
    assert [row[:6] for row in rows["notifications"]] == [("n1", 7, "kind", "{}", 0, "same"), ("n2", 7, "kind", "{}", 1, "later")]
    assert ("index", "custom_notification_index", "CREATE INDEX custom_notification_index ON notifications(user_id)") in schema
    assert start(path, "WAL") == ("wal", rows, schema, "ok")
    assert start(path, "DELETE") == ("delete", rows, schema, "ok")
    assert not Path(f"{path}-wal").exists()
    assert start(path, "WAL") == ("wal", rows, schema, "ok")


def test_only_the_setting_turns_wal_on(tmp_path):
    """The server switch is opt-in (PB-31): without SQLITE_JOURNAL_MODE=WAL in backend/.env
    the database keeps the rollback journal, so neither a release-1 deploy nor a test-site
    update turns WAL on unless the separately approved step adds the line (DEPLOY.md,
    section 7); without the line a WAL database returns to the rollback journal."""
    assert Settings.model_fields["SQLITE_JOURNAL_MODE"].default == "DELETE"
    path = tmp_path / "site.db"
    old_database(path)
    first = start(path, None)  # the startup migrations add their columns
    assert (first[0], first[3]) == ("delete", "ok")
    assert start(path, "WAL") == ("wal", *first[1:])
    assert start(path, None) == first
    assert sorted(p.name for p in tmp_path.iterdir()) == ["site.db"]


def test_a_locked_database_keeps_its_mode_until_a_later_connection(tmp_path, caplog):
    path = tmp_path / "locked.db"
    holder = sqlite3.connect(path, isolation_level=None)
    holder.execute("CREATE TABLE t(n INTEGER)")
    holder.execute("BEGIN IMMEDIATE")
    holder.execute("INSERT INTO t VALUES (1)")
    started = time.monotonic()
    with closing(sqlite3.connect(path, timeout=5)) as first:
        database._sqlite_journal(first, None)
        assert time.monotonic() - started < 2  # no wait for the busy timeout
        assert pragmas(first) == ["delete", 2]
        assert "journal mode is not WAL" in caplog.text
        holder.execute("COMMIT")
        assert first.execute("SELECT n FROM t").fetchall() == [(1,)]
    holder.close()
    with closing(sqlite3.connect(path, timeout=5)) as second:
        database._sqlite_journal(second, None)
        assert pragmas(second) == ["wal", 2]
        assert second.execute("SELECT n FROM t").fetchall() == [(1,)]


def wal_engine(path, size):
    """A separate database with the connection settings of the application."""
    other = create_engine(f"sqlite:///{path}", connect_args={"timeout": 30}, pool_size=size, max_overflow=0)
    event.listen(other, "connect", database._sqlite_journal)
    return other


def test_units_that_read_before_they_write_never_fail_while_others_commit(tmp_path):
    other = wal_engine(tmp_path / "busy.db", 20)
    with other.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE units(n INTEGER PRIMARY KEY, writer INTEGER NOT NULL, seen INTEGER NOT NULL)")
    errors, done, rounds = [], threading.Event(), 40

    def unit(k, immediate):
        with Session(other) as session:
            if immediate:  # Database.atomic
                session.execute(text("BEGIN IMMEDIATE"))
            # Otherwise the driver opens the transaction right before the INSERT.
            seen = session.execute(text("SELECT count(*) FROM units")).scalar()
            session.execute(text("INSERT INTO units(writer, seen) VALUES (:k, :seen)"), dict(k=k, seen=seen))
            assert session.execute(text("SELECT count(*) FROM units")).scalar() >= seen + 1
            session.commit()

    def writer(k):
        for _ in range(rounds):
            try:
                unit(k, immediate=k % 2 == 0)
            except Exception as error:  # noqa: BLE001 - every failure is the finding
                errors.append(repr(error))

    def reader():
        while not done.is_set():
            try:
                with Session(other) as session:
                    session.execute(text("SELECT count(*), max(n) FROM units")).one()
                    session.commit()
            except Exception as error:  # noqa: BLE001
                errors.append(repr(error))

    readers = [threading.Thread(target=reader) for _ in range(8)]
    writers = [threading.Thread(target=writer, args=(k,)) for k in range(8)]
    for thread in readers + writers:
        thread.start()
    for thread in writers:
        thread.join()
    done.set()
    for thread in readers:
        thread.join()
    with other.connect() as connection:
        assert connection.exec_driver_sql("SELECT count(*) FROM units").scalar() == 8 * rounds
    other.dispose()
    assert errors == []


def test_a_read_right_after_an_acknowledged_write_sees_it(client, work):
    """Read-your-writes over HTTP (PB-31): a command commits before its response (FastAPI
    closes the unit of work first), and the next request reads the newest commit on
    whichever pooled connection it gets, while other requests keep reading."""
    master = work["master"]
    tasks = [work["task"]] + [client.post("/api/tasks", headers=master.headers, json={**work["payload"], "title": f"Работа {k}"}).json()
                              for k in range(3)]
    stale, errors, done = [], [], threading.Event()

    def writer(task):
        path, revision, target = f"/api/tasks/{task['task_id']}", task["revision"], "in_progress"
        for i in range(12):
            r = client.post(f"{path}/status", headers=master.headers, json=dict(expected_revision=revision, status=target))
            if r.status_code != 200:
                errors.append(r.text[:300])
                return
            revision = r.json()["revision"]
            read = client.get(path, headers=master.headers).json()
            if (read["revision"], read["status"]) != (revision, target):
                stale.append((task["task_id"], revision, target, read["revision"], read["status"]))
            if i % 3 == 0:
                comment = client.post(f"{path}/comments", headers=master.headers,
                                      json=dict(content=f"Комментарий {i}", idempotency_key=str(uuid.uuid4()))).json()
                if comment["comment_id"] not in {c["comment_id"] for c in client.get(f"{path}/comments", headers=master.headers).json()["items"]}:
                    stale.append((task["task_id"], comment["comment_id"]))
            target = "open" if target == "in_progress" else "in_progress"

    def reader(k):
        while not done.is_set():
            r = client.get(("/api/tasks", "/api/workspace/home", f"/api/tasks/{tasks[k % len(tasks)]['task_id']}/comments")[k % 3],
                           headers=master.headers)
            if r.status_code != 200:
                errors.append(r.text[:300])
            k += 1

    readers = [threading.Thread(target=reader, args=(k,)) for k in range(4)]
    writers = [threading.Thread(target=writer, args=(task,)) for task in tasks]
    for thread in readers + writers:
        thread.start()
    for thread in writers:
        thread.join()
    done.set()
    for thread in readers:
        thread.join()
    assert errors == [] and stale == []


def test_the_migration_scripts_hash_the_file_before_they_open_it(tmp_path, monkeypatch):
    """source_sha256 is the database file as sha256sum prints it, read before the script
    opens the database: closing a descriptor of the file drops the POSIX locks that an
    open connection of the process keeps in WAL (tests/sqlite_files.py). source_wal_bytes
    is the size of -wal at that moment: committed transactions may still be outside the file."""
    import legacy_6eb9dea

    path = tmp_path / "copy.db"
    legacy_6eb9dea.build(path)
    connect, read = sqlite3.connect, Path.read_bytes
    with closing(connect(path)) as killed:  # an API killed with its last commit still in -wal
        killed.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
        killed.execute("PRAGMA journal_mode=WAL")
        killed.execute("UPDATE contact_info SET tg='@moved' WHERE user_id=10")
        killed.commit()
    wal = Path(f"{path}-wal").stat().st_size
    assert wal > 0
    opened, hashed = [], []

    def tracked(database, *args, **kwargs):
        opened.append(database)
        return connect(database, *args, **kwargs)

    def reading(self):
        if self == path:
            hashed.append(len(opened))
        return read(self)

    monkeypatch.setattr(sqlite3, "connect", tracked)
    monkeypatch.setattr(Path, "read_bytes", reading)
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import mapping_candidate
    import migrate_v13

    def run(script, *args):
        opened.clear()
        hashed.clear()
        monkeypatch.setattr(sys, "argv", [script.__file__, "--database", str(path), *map(str, args)])
        script.main()
        assert hashed == [0]  # one read of the file, before any connection

    run(migrate_v13, "--report", tmp_path / "dry.json")
    run(mapping_candidate, "--out", tmp_path / "candidate.json", "--review", tmp_path / "review.json")
    dry, review = (json.loads((tmp_path / name).read_text()) for name in ("dry.json", "review.json"))
    file = hashlib.sha256(read(path)).hexdigest()
    assert (dry["source_sha256"], dry["source_wal_bytes"]) == (review["source_sha256"], review["source_wal_bytes"]) == (file, wal)
    # The same content after a checkpoint: in the file alone, which now has another hash.
    with closing(connect(path)) as last:
        last.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    assert not Path(f"{path}-wal").exists()
    run(migrate_v13, "--report", tmp_path / "again.json")
    again = json.loads((tmp_path / "again.json").read_text())
    assert again["source_wal_bytes"] == 0 and again["source_sha256"] == hashlib.sha256(read(path)).hexdigest() != file
    assert (again["before"], again["unresolved"]) == (dry["before"], dry["unresolved"])


def test_scripts_that_apply_leave_only_the_database_file(tmp_path):
    """A script closes its read-only connections itself (PB-31): an sqlite3 connection sits
    in a reference cycle with its statement cache, so the `with` block leaves it open until
    a garbage collection, and at the exit of the script the last connection of the app
    could not fold -wal into the file."""
    import legacy_6eb9dea

    path = tmp_path / "copy.db"
    legacy_6eb9dea.build(path)
    env = {**os.environ, "S3_BUCKET_NAME": "synthetic"}  # the bucket of legacy_6eb9dea

    def run(script, *args):
        result = subprocess.run([sys.executable, str(SCRIPTS / script), "--database", str(path), *map(str, args)],
                                cwd=BACKEND, env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr[-3000:]
        assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith(path.name)) == [path.name], script

    run("migrate_v13.py", "--apply", "--report", tmp_path / "apply.json")
    run("migrate_v13.py", "--apply", "--report", tmp_path / "again.json")
    assert json.loads((tmp_path / "again.json").read_text())["source_wal_bytes"] == 0
    run("seal_completed_files.py", "--apply")
    run("cleanup_accounts.py", "--apply")
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as copy:
        assert copy.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


WRITER = r"""
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1], timeout=30, isolation_level=None)
# The pragmas of database._sqlite_journal.
assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
connection.execute("PRAGMA synchronous=FULL")
connection.execute("PRAGMA wal_autocheckpoint=8")  # checkpoints all the time, also when killed
n = connection.execute("SELECT coalesce(max(n), 0) FROM acked").fetchone()[0]
while True:
    n += 1
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("INSERT INTO acked(n, payload) VALUES (?, randomblob(3000))", (n,))
    connection.execute("UPDATE last SET n=?", (n,))
    connection.execute("COMMIT")
    print(n, flush=True)
"""


def test_a_killed_writer_loses_no_acknowledged_commit(tmp_path):
    """A process crash (SIGKILL, OOM): every commit the writer acknowledged is present and
    whole. This holds with any synchronous setting. Durability through a power loss is
    synchronous=FULL, which syncs -wal before COMMIT returns; here it is checked only as
    the PRAGMA of every new connection."""
    path = tmp_path / "killed.db"
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript("CREATE TABLE acked(n INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE last(n INTEGER); INSERT INTO last VALUES (0);")
    acknowledged = set()
    for _ in range(24):
        child = subprocess.Popen([sys.executable, "-c", WRITER, str(path)], stdout=subprocess.PIPE, text=True)
        time.sleep(random.uniform(0.1, 0.35))
        child.send_signal(signal.SIGKILL)
        output, _ = child.communicate()
        acknowledged |= {int(line) for line in output.splitlines(keepends=True) if line.endswith("\n")}
        with closing(sqlite3.connect(path)) as connection:
            assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            present = {n for n, in connection.execute("SELECT n FROM acked")}
            assert acknowledged <= present
            # A commit is whole: the last row and its counter, at most one unacknowledged.
            assert connection.execute("SELECT n FROM last").fetchone()[0] == max(present, default=0) <= max(acknowledged, default=0) + 1
    assert len(acknowledged) > 200


BACKUP = re.compile(r'python3 -c "(import sqlite3, sys; [^"]*\.backup\([^"]*)"')


def deploy_backup():
    """The backup command of DEPLOY.md, verbatim: one form everywhere."""
    commands = set(BACKUP.findall((ROOT / "DEPLOY.md").read_text()))
    assert len(commands) == 1, commands
    return commands.pop()


def backup(source, target):
    result = subprocess.run([sys.executable, "-c", deploy_backup(), str(source), str(target)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    with closing(sqlite3.connect(target)) as copy:
        # A copy of a WAL database is a WAL database too (DEPLOY.md, section 7).
        assert copy.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return copy.execute("SELECT count(*), max(n) FROM acked").fetchone(), copy.execute("SELECT n FROM last").fetchone()[0]


def test_the_deploy_backup_is_consistent_during_writes_and_after_a_stop(tmp_path):
    path = tmp_path / "site.db"
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript("CREATE TABLE acked(n INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE last(n INTEGER); INSERT INTO last VALUES (0);")
    # While the backend writes: every copy ends at a commit boundary.
    child = subprocess.Popen([sys.executable, "-c", WRITER, str(path)], stdout=subprocess.PIPE, text=True)
    try:
        while not Path(f"{path}-wal").exists():
            time.sleep(0.01)
        for k in range(4):
            (count, top), last = backup(path, tmp_path / f"during-{k}.db")
            assert count == top == last and count > 0
    finally:
        child.send_signal(signal.SIGKILL)
        output, _ = child.communicate()
    # Killed: committed rows wait in -wal, which the copy includes.
    assert Path(f"{path}-wal").stat().st_size > 0
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as live:
        expected = live.execute("SELECT count(*), max(n) FROM acked").fetchone()
    assert backup(path, tmp_path / "killed.db") == (expected, expected[1])
    assert int(output.split()[-1]) <= expected[1]
    # Stopped cleanly: the last connection folds -wal into the file and removes it.
    with closing(sqlite3.connect(path)) as last:
        last.execute("SELECT count(*) FROM acked").fetchone()
    assert not Path(f"{path}-wal").exists() and not Path(f"{path}-shm").exists()
    assert backup(path, tmp_path / "stopped.db") == (expected, expected[1])


SERVER = r'''
import sys
import uvicorn
from sqlalchemy import text
from main import app
from database import db
with db.atomic():
    with db._session() as session:
        session.execute(text("UPDATE block SET cnt_of_human = cnt_of_human"))
        session.commit()
uvicorn.run(app, uds=sys.argv[1], log_level="warning")
'''


def test_a_stopped_backend_or_script_leaves_only_the_database_file(tmp_path):
    folder = tmp_path / "data"
    folder.mkdir()
    path = folder / "site.db"
    env = {**os.environ, "DATABASE_PATH": str(path)}
    # The server as in the container, on a Unix socket: docker stop sends SIGTERM.
    with tempfile.TemporaryDirectory(prefix="pb31-") as short:  # a socket path has a length limit
        socket = Path(short) / "api.sock"
        server = subprocess.Popen([sys.executable, "-c", SERVER, str(socket)], cwd=BACKEND, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 60
            while not socket.exists():
                assert server.poll() is None and time.monotonic() < deadline, server.stderr.read()[-3000:] if server.poll() is not None else "no start"
                time.sleep(0.05)
            assert sorted(p.name for p in folder.iterdir()) == ["site.db", "site.db-shm", "site.db-wal"]
            server.send_signal(signal.SIGTERM)
            server.wait(30)
        finally:
            if server.poll() is None:
                server.kill()
            server.communicate()
    assert server.returncode == -signal.SIGTERM  # uvicorn re-raised it: only the shutdown handler ran
    assert sorted(p.name for p in folder.iterdir()) == ["site.db"]
    # A script that imports the application (scripts/migrate_v13.py --apply, preset_db.py).
    result = subprocess.run([sys.executable, "-c", "import database"], cwd=BACKEND, capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr[-3000:]
    assert sorted(p.name for p in folder.iterdir()) == ["site.db"]
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as copy:
        assert copy.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
