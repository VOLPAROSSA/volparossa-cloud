#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Real supervised lock/process-group checks; no storage or browser claim."""
import fcntl
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class UploadLock(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / 'build').mkdir(mode=0o700, exist_ok=True)

    def test_forced_termination_is_not_normal_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='lock-kill-contract-', dir=ROOT / 'build') as name:
            child = subprocess.Popen(['/usr/bin/python3', '-I', '-B',
                ROOT / 'scripts/upload_lock.py', name], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                self.assertEqual(child.stdout.readline(64), b'LOCKED\n')
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate(timeout=5)
                self.assertEqual(child.returncode, -signal.SIGKILL)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.communicate(timeout=5)

    def test_group_shutdown_retains_lock_until_owner_pipe_closes(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum), tempfile.TemporaryDirectory(
                    prefix='lock-contract-', dir=ROOT / 'build') as name:
                root = Path(name)
                child = subprocess.Popen(['/usr/bin/python3', '-I', '-B',
                    ROOT / 'scripts/upload_lock.py', root], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                    self.assertEqual(child.stdout.readline(64), b'LOCKED\n')
                    os.killpg(child.pid, signum)
                    # A signal must not release the lock before the owner has
                    # drained writes and closed the supervised stdin pipe.
                    with self.assertRaises(subprocess.TimeoutExpired):
                        child.wait(timeout=.1)
                    with (root / 'LOCK').open('rb') as contender:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        stdout, stderr = child.communicate(timeout=5)
                        self.assertEqual((child.returncode, stdout, stderr), (0, b'', b''))
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGKILL)
                    child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
