"""Prepare only operator-registered projects, outside the untrusted worker.

The registry is a local trusted file, never a URL or a path supplied in a task.
Existing worktrees and uncommitted work are preserved. No dependencies, hooks,
submodules, credentials, or scripts from a repository are executed here.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading

_prepare_lock = threading.Lock()
SLUG = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}")
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*")


def regular_directory(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Workspace path must be a real directory, not a symlink or junction")


def safe_git(cwd: Path, *args: str, timeout: int = 240) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_") and not key.startswith("MC_")}
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_LFS_SKIP_SMUDGE": "1"})
    return subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false",
                           "-c", "credential.helper=", "-c", "protocol.file.allow=never",
                           "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false",
                           "-C", str(cwd), *args], env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def checked_git(cwd: Path, *args: str) -> str:
    result = safe_git(cwd, *args)
    if result.returncode:
        # Do not echo configuration, URLs containing credentials, or arbitrary tool output.
        raise ValueError("Could not prepare the project with Git. Check the PC connection and workspace.")
    return result.stdout.strip()


def prepare(project: str, workdir: Path, registry_file: str, repositories_dir: str) -> None:
    if not SLUG.fullmatch(project) or project.endswith(".") or project in {"con", "prn", "aux", "nul"} or re.fullmatch(r"(?:com|lpt)[1-9]", project):
        raise ValueError("Invalid registered project name")
    registry = json.loads(Path(registry_file).read_text(encoding="utf-8"))
    entry = next((p for p in registry if p.get("id") == project), None)
    if not entry or not REPOSITORY.fullmatch(entry.get("repository", "")):
        raise ValueError("This project is not registered on this PC")
    destination = workdir / project
    root = Path(repositories_dir)
    regular_directory(root)
    regular_directory(workdir)
    repository = root / project
    expected = "https://github.com/" + entry["repository"]
    with _prepare_lock:
        if destination.exists() or destination.is_symlink():
            regular_directory(destination)
            return  # The dispatcher's normal linked-worktree validation follows.
        if repository.exists() or repository.is_symlink():
            regular_directory(repository)
            regular_directory(repository / ".git")
            origin = checked_git(repository, "remote", "get-url", "origin").removesuffix(".git").rstrip("/")
            if origin.lower() != expected.lower():
                raise ValueError("Existing repository does not match the registered project")
        else:
            checked_git(root, "clone", "--depth", "1", "--single-branch", "--no-recurse-submodules", "--", expected + ".git", str(repository))
        head = safe_git(repository, "rev-parse", "--verify", "HEAD")
        if head.returncode:
            # Git worktrees need a commit. An empty remote gets a local, empty base;
            # it is not pushed and no user work is staged.
            checked_git(repository, "-c", "user.name=Leitstand", "-c", "user.email=leitstand@localhost", "commit", "--allow-empty", "-m", "Initialize local workspace")
        checked_git(repository, "worktree", "add", "--detach", str(destination), "HEAD")
