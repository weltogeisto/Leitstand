import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents/dispatcher"))
import mc_dispatcher as dispatcher
import workspaces
from process_control import RunCancelled


def turn(tid, message, parent=None, **extra):
    return {"id": tid, "project": "leitstand", "title": message, "description": json.dumps({"leitstand_work": 1, "message": message, "parent_id": parent, "thread_id": 1 if parent else None}), **extra}


class WorkConsoleTests(unittest.TestCase):
    def test_empty_repository_never_commits_existing_staged_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repos, work = root / "repos", root / "work"
            repos.mkdir(); work.mkdir()
            repo = repos / "leitstand"; repo.mkdir()
            workspaces.checked_git(repo, "init", "-q")
            workspaces.checked_git(repo, "remote", "add", "origin", "https://github.com/weltogeisto/Leitstand.git")
            (repo / "keep.txt").write_text("uncommitted work")
            workspaces.checked_git(repo, "add", "keep.txt")
            registry = root / "registry.json"
            registry.write_text(json.dumps([{"id": "leitstand", "repository": "weltogeisto/Leitstand"}]))
            with self.assertRaisesRegex(ValueError, "staged work"):
                workspaces.prepare("leitstand", work, str(registry), str(repos))
            self.assertNotEqual(workspaces.safe_git(repo, "rev-parse", "--verify", "HEAD").returncode, 0)
            self.assertEqual(workspaces.checked_git(repo, "diff", "--cached", "--name-only"), "keep.txt")

    def test_followup_passes_real_prior_reply_and_current_message(self):
        prior = turn(1, "Review this", result="Try option B", status="done")
        with mock.patch.object(dispatcher, "api", return_value={"task": prior}):
            prompt = dispatcher.build_prompt(turn(2, "Implement that option", 1))
        for fragment in ("Review this", "Try option B", "Implement that option"):
            self.assertIn(fragment, prompt)
        self.assertNotIn('"parent_id"', prompt)

    def test_cross_project_or_cyclic_history_fails_closed(self):
        with mock.patch.object(dispatcher, "api", return_value={"task": {**turn(1, "private"), "project": "other"}}):
            with self.assertRaises(ValueError): dispatcher.build_prompt(turn(2, "do it", 1))
        with self.assertRaises(ValueError): dispatcher.build_prompt(turn(2, "cycle", 2))

    def test_reply_is_not_cut_to_1500_characters(self):
        reply = "A" * 7000
        self.assertEqual(dispatcher.extract_result("debug\nRESULT: " + reply), reply)

    def test_cancel_kills_worker_children_before_returning(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "escaped"
            child = f"import time,pathlib;time.sleep(2);pathlib.Path({str(marker)!r}).write_text('escaped')"
            program = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child!r}]);time.sleep(30)"
            cancelled = threading.Event()
            timer = threading.Timer(.5, cancelled.set)
            dispatcher.CURRENT_RUN.cancel_event = cancelled
            timer.start()
            try:
                with self.assertRaises(RunCancelled): dispatcher.run_contained([sys.executable, "-c", program], Path(folder), 15)
            finally:
                dispatcher.CURRENT_RUN.cancel_event = None
                timer.cancel()
            time.sleep(2.1)
            self.assertFalse(marker.exists())

    def test_cancel_uses_isolated_broker_cleanup(self):
        with mock.patch.dict(os.environ, {"MC_WORKER_RUNNER": "broker.py"}), \
             mock.patch.object(dispatcher, "run_contained", side_effect=RunCancelled()), \
             mock.patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as stop:
            with self.assertRaises(RunCancelled): dispatcher.run_cli("codex", "task", Path.cwd())
            self.assertEqual(stop.call_args.args[0][1:3], ["broker.py", "stop"])

    def test_registered_existing_repository_gets_linked_workspace_without_losing_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repos, work = root / "repos", root / "work"
            repos.mkdir(); work.mkdir()
            repo = repos / "leitstand"
            repo.mkdir()
            workspaces.checked_git(repo, "init", "-q")
            workspaces.checked_git(repo, "remote", "add", "origin", "https://github.com/weltogeisto/Leitstand.git")
            workspaces.checked_git(repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "Base")
            (repo / "keep.txt").write_text("local change")
            registry = root / "registry.json"
            registry.write_text(json.dumps([{"id": "leitstand", "repository": "weltogeisto/Leitstand"}]))
            workspaces.prepare("leitstand", work, str(registry), str(repos))
            self.assertTrue((work / "leitstand" / ".git").is_file())
            self.assertEqual((repo / "keep.txt").read_text(), "local change")
            (work / "leitstand" / "followup.txt").write_text("preserve")
            workspaces.prepare("leitstand", work, str(registry), str(repos))
            self.assertEqual((work / "leitstand" / "followup.txt").read_text(), "preserve")
            for hostile in ("../secrets", "/absolute", "not-registered", "CON", "a\\b"):
                with self.assertRaises(ValueError): workspaces.prepare(hostile, work, str(registry), str(repos))


if __name__ == "__main__": unittest.main()
