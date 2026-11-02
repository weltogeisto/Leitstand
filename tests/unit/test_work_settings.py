import json
from pathlib import Path
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents/dispatcher"))
import mc_dispatcher as dispatcher
import work_settings


class WorkSettingsTests(unittest.TestCase):
    def test_catalog_has_compatible_defaults_and_no_duplicate_model_ids(self):
        for platform, provider in work_settings.CATALOG.items():
            work_settings.validate(platform, {"model": provider["default_model"], "effort": provider["default_effort"]})
            ids = [m["id"] for m in provider["models"]]
            self.assertEqual(len(ids), len(set(ids)))
            for model in provider["models"]:
                self.assertIn(model["default_effort"], model["efforts"])

    def test_explicit_selections_reach_the_isolated_runner_as_separate_arguments(self):
        for platform, model, effort in [("codex", "gpt-6.1-sol", "low"), ("claude-code", "claude-sonnet-5-5", "xhigh")]:
            with mock.patch.dict(dispatcher.os.environ, {"MC_WORKER_RUNNER": "broker.py"}, clear=True), \
                    mock.patch.object(dispatcher, "run_contained", return_value=(0, '{"result":"OK"}', "")) as run, \
                    mock.patch.object(dispatcher.subprocess, "run", return_value=mock.Mock(returncode=0)):
                ok, _, _ = dispatcher.run_cli(platform, "test", Path.cwd(), settings={"model": model, "effort": effort})
            self.assertTrue(ok)
            argv = run.call_args.args[0]
            self.assertEqual(argv[1:3], ["broker.py", "run"])
            self.assertEqual(argv[argv.index("--model") + 1], model)
            if platform == "codex":
                self.assertIn('model_reasoning_effort="low"', argv)
                self.assertIn("workspace-write", argv)
            else:
                self.assertEqual(argv[argv.index("--effort") + 1], effort)
                self.assertIn("acceptEdits", argv)

    def test_invalid_or_incompatible_settings_never_launch_a_worker(self):
        for settings in [None, [], {}, {"model": "claude-opus-5-5", "effort": "high"},
                         {"model": "gpt-6-luna", "effort": "ultra"},
                         {"model": "gpt-6-astra", "effort": "high", "args": ["--bad"]},
                         {"model": "gpt-6-astra", "effort": 'high"\nnetwork_access=true'}]:
            with self.assertRaises(ValueError): work_settings.validate("codex", settings)
        with mock.patch.object(dispatcher, "run_contained") as run:
            with self.assertRaises(ValueError):
                dispatcher.run_cli("codex", "test", Path.cwd(), settings={"model": "--bad", "effort": "high"})
        run.assert_not_called()

    def test_task_settings_are_checked_before_preparing_or_opening_project(self):
        task = {"id": 100, "project": "leitstand", "description": json.dumps({"leitstand_work": 1, "message": "test",
                "parent_id": None, "thread_id": None, "settings": {"model": "bogus", "effort": "high"}})}
        with mock.patch.dict(dispatcher.os.environ, {}, clear=True), \
                mock.patch.object(dispatcher, "resolve_project") as prepare, \
                mock.patch.object(dispatcher, "finish_task") as finish:
            dispatcher.run_task(task, "codex", threading.Semaphore(0))
        prepare.assert_not_called()
        self.assertEqual(finish.call_args.args[1]["status"], "failed")

    def test_legacy_tasks_keep_original_runner_defaults(self):
        self.assertEqual(work_settings.cli_args("codex", None), [])


if __name__ == "__main__": unittest.main()
