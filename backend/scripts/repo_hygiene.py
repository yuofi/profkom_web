"""Data files never go into the repository (FIX_PLAN 0.5, A-SEC-9).

No *.csv and no SQLite databases; *.sql only from ALLOWED_SQL. Used by
tests/test_repo_hygiene.py and by the pre-commit hook in .githooks/:

  python3 backend/scripts/repo_hygiene.py --staged    # files added to the next commit
  python3 backend/scripts/repo_hygiene.py --tracked   # every tracked file
"""

import re
import subprocess
import sys

FORBIDDEN = re.compile(r"\.(csv|db|sqlite3?)(-wal|-shm|-journal)?$", re.I)
# Repository-relative paths of *.sql files that may be committed.
ALLOWED_SQL = frozenset()


def violations(paths):
    return [
        p
        for p in paths
        if FORBIDDEN.search(p) or (p.lower().endswith(".sql") and p not in ALLOWED_SQL)
    ]


def git_paths(*args):
    out = subprocess.run(["git", *args, "-z"], capture_output=True, check=True).stdout
    return [p for p in out.decode().split("\0") if p]


def main():
    staged = "--staged" in sys.argv[1:]
    paths = (
        git_paths("diff", "--cached", "--name-only", "--diff-filter=ACR")
        if staged
        else git_paths("ls-files")
    )
    bad = violations(paths)
    for p in bad:
        print(f"repo hygiene: {p} — data files stay outside the repository", file=sys.stderr)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
