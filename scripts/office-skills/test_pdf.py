"""Tests for builtin-skills/pdf/scripts (render_pdf.py, office_env.py).

Run by scripts/officeSkills.test.ts with the bundled Python (pypdfium2, reportlab, Pillow).
Each test builds its own sample file.
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


class OfficeEnv(Tmp):
    def test_fonts_command_prints_one_line_per_role(self):
        code, out = run("pdf", "office_env.py", "fonts")
        self.assertEqual(code, 0)
        self.assertEqual(len(out.strip().splitlines()), 3)


class RenderPdf(Tmp):
    def test_renders_pages_and_flags_scanned_pages(self):
        from PIL import Image
        from reportlab.pdfgen import canvas
        path = self.p("a.pdf")
        c = canvas.Canvas(path)
        c.drawString(72, 700, "Hello 123")
        c.showPage()
        img = self.p("i.png")
        Image.new("RGB", (50, 50), (200, 0, 0)).save(img)
        c.drawImage(img, 72, 600, 100, 100)
        c.showPage()
        c.save()
        out_dir = self.p("pages")
        code, out = run("pdf", "render_pdf.py", path, out_dir, "--dpi", "40")
        self.assertEqual(code, 0, out)
        self.assertTrue(os.path.exists(os.path.join(out_dir, "page_002.png")))
        self.assertTrue(os.path.exists(os.path.join(out_dir, "contact.png")))
        self.assertIn("扫描页", out)

    def test_broken_pdf_is_reported(self):
        bad = self.p("bad.pdf")
        with open(bad, "wb") as fh:
            fh.write(b"not a pdf")
        code, out = run("pdf", "render_pdf.py", bad, self.p("o"))
        self.assertEqual(code, 1)
        self.assertIn("打不开", out)


class PdfRenderScratch(Tmp):
    def test_render_pdf_defaults_to_a_scratch_folder(self):
        text = open(os.path.join(ROOT, "pdf", "scripts", "render_pdf.py"), encoding="utf8").read()
        self.assertIn("xs-pdf-pages-", text)


class PdfRenderEdge(Tmp):
    def pdf(self, pages=14, password=None):
        from reportlab.pdfgen import canvas
        path = self.p("m.pdf")
        c = canvas.Canvas(path, encrypt=password) if password else canvas.Canvas(path)
        for i in range(pages):
            c.drawString(72, 700, f"page {i + 1}")
            c.showPage()
        c.save()
        return path

    def test_page_selection_ranges_and_names(self):
        out_dir = self.p("o")
        code, out = run("pdf", "render_pdf.py", self.pdf(), out_dir, "--dpi", "30", "--pages", "7,2-3")
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(os.listdir(out_dir)), ["contact.png", "page_002.png", "page_003.png", "page_007.png"])
        self.assertIn("14 页, 渲染 3 页", out)

    def test_more_than_twelve_pages_make_numbered_contact_sheets(self):
        out_dir = self.p("o")
        run("pdf", "render_pdf.py", self.pdf(14), out_dir, "--dpi", "20")
        names = os.listdir(out_dir)
        self.assertIn("contact_1.png", names)
        self.assertIn("contact_2.png", names)
        self.assertNotIn("contact.png", names)

    def test_page_zero_and_out_of_range_numbers_are_ignored_without_crash(self):
        code, out = run("pdf", "render_pdf.py", self.pdf(3), self.p("o"), "--dpi", "20", "--pages", "0,1,9")
        self.assertEqual(code, 0, out)
        self.assertIn("渲染 1 页", out)

    def test_zero_byte_encrypted_and_missing_pdf_messages(self):
        zero = self.p("zero.pdf")
        open(zero, "wb").close()
        code, out = run("pdf", "render_pdf.py", zero, self.p("o1"))
        self.assertEqual((code, "打不开" in out), (1, True), out)
        code, out = run("pdf", "render_pdf.py", self.pdf(1, password="pw"), self.p("o2"))
        self.assertEqual(code, 1, out)
        self.assertIn("密码", out)
        code, out = run("pdf", "render_pdf.py", self.p("nothing.pdf"), self.p("o3"))
        self.assertEqual(code, 1, out)
        self.assertNotIn("Traceback", out)

    def test_a_selection_that_matches_no_page_says_so(self):
        code, out = run("pdf", "render_pdf.py", self.pdf(3), self.p("o"), "--pages", "99")
        self.assertTrue(code != 0 or "没有" in out or "超出" in out, out)

    def test_a_malformed_page_selection_gets_a_plain_message(self):
        _, out = run("pdf", "render_pdf.py", self.pdf(3), self.p("o"), "--pages", "abc")
        self.assertNotIn("Traceback", out)


class PdfSkillText(Tmp):
    def test_skill_does_not_tell_the_model_to_ask(self):
        pdf = open(os.path.join(ROOT, "pdf", "SKILL.md"), encoding="utf-8").read()
        self.assertNotIn("ask the user for the password", pdf)


if __name__ == "__main__":
    unittest.main()
