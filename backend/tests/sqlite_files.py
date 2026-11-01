"""The stored state of an SQLite database, read through SQLite."""
import hashlib
import sqlite3
from contextlib import closing
from pathlib import Path


def database_digest(path):
    """Journal mode, schema and rows, whether they are in the file or still in -wal (PB-31).

    Never hash the file itself in a process that has the database open: closing that
    descriptor drops the process's POSIX locks, which WAL keeps while a connection is
    open; another process then takes itself for the last one and removes -wal and
    -shm under the open connections."""
    with closing(sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)) as connection:
        mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        return hashlib.sha256("\n".join([mode, *connection.iterdump()]).encode()).hexdigest()
