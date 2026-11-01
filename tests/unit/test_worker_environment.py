import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents/dispatcher"))
import mc_dispatcher as dispatcher


class WorkerEnvironmentTests(unittest.TestCase):
    def test_actual_child_cannot_read_parent_credentials(self):
        secrets = {
            "MC_TOKEN": "dispatcher-control-test",
            "MC_EVENT_TOKEN": "event-control-test",
            "DATABASE_URL": "database-test",
            "GITHUB_TOKEN": "github-test",
            "ANTHROPIC_API_KEY": "provider-test",
            "OPENAI_API_KEY": "provider-test",
            "UNRELATED_SECRET": "unknown-test",
        }
        program = "import json,os; print(json.dumps(dict(os.environ)))"
        with patch.dict(os.environ, secrets), tempfile.TemporaryDirectory() as td:
            code, output, error = dispatcher.run_contained([sys.executable, "-c", program], Path(td), 10)
        self.assertEqual(code, 0, error)
        child = json.loads(output)
        self.assertTrue(set(child).isdisjoint(secrets))
        self.assertTrue(child.get("PATH") or child.get("Path"))

    def test_windows_case_variants_do_not_bypass_allowlist(self):
        with patch.dict(os.environ, {"mc_token": "secret", "Path": "cli-path"}, clear=True):
            self.assertEqual({key.upper(): value for key, value in dispatcher.worker_environment().items()}, {"PATH": "cli-path"})


if __name__ == "__main__":
    unittest.main()
