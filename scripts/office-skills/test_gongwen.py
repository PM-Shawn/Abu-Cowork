"""Tests for builtin-skills/gongwen/scripts (make_gongwen.py, check_docx.py --gongwen).

Run by scripts/officeSkills.test.ts with the bundled Python (python-docx, lxml, fontTools).
Each test builds its own sample file.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "builtin-skills"))


def script(name):
    return os.path.join(ROOT, "gongwen", "scripts", name)


def run(name, *args):
    proc = subprocess.run([sys.executable, "-I", script(name), *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    return proc.returncode, proc.stdout + proc.stderr


SPEC = {
    "style": "redhead", "org": "示例有限公司", "number": "示发〔2025〕1号",
    "title": "关于开展年度安全检查工作的通知", "addressee": "各部门：",
    "body": ["为做好安全生产工作,现通知如下。", "一、检查时间", "2025年3月10日至3月31日。",
             [["部门", "负责人"], ["生产部", "李四"]]],
    "sign_org": "示例有限公司", "date": "2025年3月5日",
    "cc": "各部门", "issuer": "公司办公室", "issue_date": "2025年3月5日",
}


class Gongwen(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.dir = self._d.name

    def tearDown(self):
        self._d.cleanup()

    def p(self, name):
        return os.path.join(self.dir, name)

    def make(self, spec=SPEC):
        spec_path = self.p("s.json")
        with open(spec_path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        out = self.p("n.docx")
        code, text = run("make_gongwen.py", spec_path, out)
        self.assertEqual(code, 0, text)
        return out

    def test_generated_notice_passes_the_gongwen_check(self):
        out = self.make()
        self.assertGreater(os.path.getsize(out), 5000)
        _, report = run("check_docx.py", out, "--gongwen")
        self.assertNotIn("[错误]", report)

    def test_page_geometry_is_gb_t_9704(self):
        from docx import Document
        sec = Document(self.make()).sections[0]
        mm = lambda v: round(v / 36000, 1)   # noqa: E731
        self.assertEqual((mm(sec.page_width), mm(sec.page_height)), (210.0, 297.0))
        self.assertEqual((mm(sec.top_margin), mm(sec.bottom_margin), mm(sec.left_margin), mm(sec.right_margin)),
                         (37.0, 35.0, 28.0, 26.0))

    def test_plain_style_without_red_head_passes(self):
        spec = {k: v for k, v in SPEC.items() if k not in ("org", "number")}
        spec["style"] = "plain"
        _, report = run("check_docx.py", self.make(spec), "--gongwen")
        self.assertNotIn("[错误]", report)

    def test_check_flags_wrong_layout(self):
        from docx import Document
        d = Document()
        d.add_paragraph("关于XX的通知 2025年03月05日")
        path = self.p("w.docx")
        d.save(path)
        _, report = run("check_docx.py", path, "--gongwen")
        self.assertIn("[错误]", report)
        self.assertIn("A4", report)
        self.assertIn("前导零", report)

    def test_letter_paper_is_not_reported_twice_for_a_gongwen(self):
        from docx import Document
        d = Document()
        path = self.p("l.docx")
        d.save(path)
        _, plain = run("check_docx.py", path)
        _, gong = run("check_docx.py", path, "--gongwen")
        self.assertIn("Letter", plain)
        self.assertNotIn("Letter", gong)


if __name__ == "__main__":
    unittest.main()
