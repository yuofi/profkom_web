"""FIX_PLAN 0.5 (A-SEC-9): data files stay outside the repository."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.repo_hygiene import violations

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"


def git(*args, cwd=ROOT, **kwargs):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, **kwargs)


def test_the_rule():
    paths = ["backend/result.csv", "a/B.CSV", "site.db", "x.sqlite3", "x.db-wal", "profcom.session.sql", "backend/app.py", "docs/db.md"]
    assert violations(paths) == paths[:6]


@pytest.mark.skipif(shutil.which("git") is None or not (ROOT / ".git").exists(), reason="needs a git checkout")
def test_no_data_files_are_tracked():
    tracked = git("ls-files", "-z", check=True).stdout.split("\0")
    assert "backend/result.csv" not in tracked
    assert violations([p for p in tracked if p]) == []


def test_docker_image_excludes_csv():
    assert "*.csv" in (BACKEND / ".dockerignore").read_text().split()


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_pre_commit_hook_refuses_data_files(tmp_path):
    (tmp_path / "backend/scripts").mkdir(parents=True)
    shutil.copy(BACKEND / "scripts/repo_hygiene.py", tmp_path / "backend/scripts/")
    shutil.copytree(ROOT / ".githooks", tmp_path / ".githooks")
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com", "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}"}

    def run(*args):
        return git(*args, cwd=tmp_path, env=env)

    assert run("init", "-q").returncode == 0
    run("config", "core.hooksPath", ".githooks")
    (tmp_path / "result.csv").write_text("synthetic,row\n")
    (tmp_path / "notes.txt").write_text("ok\n")
    run("add", "-f", "result.csv", "notes.txt")
    refused = run("commit", "-q", "-m", "data")
    assert refused.returncode != 0 and "result.csv" in refused.stderr
    run("rm", "-q", "--cached", "result.csv")
    assert run("commit", "-q", "-m", "notes").returncode == 0
