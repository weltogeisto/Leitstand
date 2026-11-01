"""The trusted broker must confirm cleanup before a dispatch is complete."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents/dispatcher"))
import mc_dispatcher as dispatcher


class IsolatedRunnerTests(unittest.TestCase):
    def test_uncertain_cleanup_blocks_later_jobs_until_operator_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            first = dispatcher.WorktreeLock(path)
            first.acquire(path)
            first.quarantine()
            first.release()
            second = dispatcher.WorktreeLock(path)
            with self.assertRaises(dispatcher.DispatchRefused): second.acquire(path)
            first.quarantine_path.unlink()
            second.acquire(path)
            second.release()

    def test_timeout_still_stops_isolated_worker(self):
        with mock.patch.dict(os.environ, {"MC_WORKER_RUNNER": "trusted-broker.py"}), \
             mock.patch.object(dispatcher, "run_contained", side_effect=subprocess.TimeoutExpired("worker", 1)), \
             mock.patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as stop:
            ok, result, _ = dispatcher.run_cli("codex", "test", Path.cwd())
        self.assertFalse(ok)
        self.assertIn("timed out", result)
        self.assertEqual(stop.call_args.args[0][1:3], ["trusted-broker.py", "stop"])

    def test_cleanup_failure_never_becomes_success(self):
        for failure in (subprocess.CompletedProcess([], 1), subprocess.TimeoutExpired("stop", 20)):
            with self.subTest(failure=type(failure).__name__), \
                 mock.patch.dict(os.environ, {"MC_WORKER_RUNNER": "trusted-broker.py"}), \
                 mock.patch.object(dispatcher, "run_contained", return_value=(0, "done", "")), \
                 mock.patch.object(dispatcher.subprocess, "run") as stop:
                if isinstance(failure, Exception): stop.side_effect = failure
                else: stop.return_value = failure
                with self.assertRaises(dispatcher.ContainmentError):
                    dispatcher.run_cli("codex", "test", Path.cwd())
