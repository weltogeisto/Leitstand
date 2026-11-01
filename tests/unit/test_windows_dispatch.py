import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"agents/dispatcher"))
import mc_dispatcher as dispatcher

@unittest.skipUnless(os.name=="nt","Windows job containment")
class WindowsDispatchTests(unittest.TestCase):
    def test_job_output_and_exit(self):
        code,out,err=dispatcher.run_contained([sys.executable,"-c","print('contained')"],Path.cwd(),10)
        self.assertEqual((code,out.strip(),err),(0,"contained",""))

    def test_timeout_kills_descendant(self):
        with tempfile.TemporaryDirectory() as td:
            marker=Path(td)/"escaped"
            child=f"import time,pathlib;time.sleep(2);pathlib.Path({str(marker)!r}).write_text('escaped')"
            parent=f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child!r}]);time.sleep(30)"
            with self.assertRaises(subprocess.TimeoutExpired):
                dispatcher.run_contained([sys.executable,"-c",parent],Path(td),.4)
            time.sleep(2.2)
            self.assertFalse(marker.exists(),"child escaped the job on timeout")

    def test_successful_parent_also_kills_descendant(self):
        with tempfile.TemporaryDirectory() as td:
            marker=Path(td)/"escaped"
            child=f"import time,pathlib;time.sleep(1);pathlib.Path({str(marker)!r}).write_text('escaped')"
            parent=f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{child!r}])"
            dispatcher.run_contained([sys.executable,"-c",parent],Path(td),10)
            time.sleep(1.2)
            self.assertFalse(marker.exists())

    def test_exclusive_worktree_lock(self):
        with tempfile.TemporaryDirectory() as td:
            first=dispatcher.WorktreeLock(Path(td));second=dispatcher.WorktreeLock(Path(td))
            first.acquire(Path(td))
            try:
                with self.assertRaises(dispatcher.DispatchRefused):second.acquire(Path(td))
            finally:first.release()
            second.acquire(Path(td));second.release()

if __name__=="__main__":unittest.main()
