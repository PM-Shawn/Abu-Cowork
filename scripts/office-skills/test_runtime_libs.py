"""Tests that the bundled Python carries the libraries the office skills use.

Run by scripts/officeSkills.test.ts with the bundled Python.
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "builtin-skills"))


def script(skill, name):
    return os.path.join(ROOT, skill, "scripts", name)


def run(skill, name, *args, env=None, isolated=True):
    cmd = [sys.executable] + (["-I"] if isolated else []) + [script(skill, name), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          env={**os.environ, **(env or {})})
    return proc.returncode, proc.stdout + proc.stderr


class Tmp(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.dir = self._d.name

    def tearDown(self):
        self._d.cleanup()

    def p(self, name):
        return os.path.join(self.dir, name)


class RuntimeLibraryTests(unittest.TestCase):
    def test_lock_pins_dateutil_six_and_xlrd(self):
        lock = open(os.path.join(ROOT, "..", "electron", "runtime", "python-requirements.lock"), encoding="utf8").read()
        for pin in ("python-dateutil==2.9.0.post0", "six==", "xlrd==2.0.2"):
            self.assertIn(pin, lock)

    def test_pandas_handles_time_zones(self):
        import pandas as pd
        stamp = pd.Timestamp("2026-03-01 08:00", tz="Asia/Shanghai")
        self.assertEqual(stamp.tz_convert("UTC").hour, 0)
        self.assertEqual(pd.Series(pd.date_range("2026-01-01", periods=2, tz="UTC")).dt.tz_convert("Asia/Shanghai").dt.hour.tolist(), [8, 8])

    def test_pandas_reads_xls_through_xlrd(self):
        import pandas as pd
        frame = pd.read_excel(os.path.join(os.path.dirname(__file__), "fixtures", "sample.xls"))
        self.assertGreater(len(frame), 0)


if __name__ == "__main__":
    unittest.main()
