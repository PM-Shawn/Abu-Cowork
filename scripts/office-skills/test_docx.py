"""Tests for builtin-skills/docx/scripts (check_docx.py).

Run by scripts/officeSkills.test.ts with the bundled Python (python-docx, lxml, fontTools).
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


class CheckDocx(Tmp):
    def make(self):
        from docx import Document
        from docx.shared import Cm
        d = Document()
        from docx.oxml.ns import qn
        for rf in d.styles.element.iter(qn("w:rFonts")):      # no East Asian font anywhere in the styles
            for attr in ("w:eastAsiaTheme", "w:eastAsia"):
                if rf.get(qn(attr)) is not None:
                    del rf.attrib[qn(attr)]
        d.add_heading("报告", 1)
        d.add_paragraph("这里是正文,请填写 XXX。")
        d.add_paragraph("")
        d.add_paragraph("")
        d.add_paragraph("")
        t = d.add_table(rows=1, cols=2)
        t.autofit = False
        for c in t.rows[0].cells:
            c.width = Cm(12)
        path = self.p("a.docx")
        d.save(path)
        return path

    def test_reports_placeholder_font_page_and_wide_table(self):
        _, out = run("docx", "check_docx.py", self.make())
        self.assertIn("XXX", out)
        self.assertIn("Letter", out)
        self.assertIn("中文字体", out)
        self.assertIn("表格", out)

    def test_fix_fonts_removes_the_font_warning(self):
        path = self.make()
        run("docx", "check_docx.py", path, "--fix-fonts", "宋体")
        _, out = run("docx", "check_docx.py", path)
        self.assertNotIn("没有指定中文字体", out)


class DocxEdge(Tmp):
    def save(self, doc, name="a.docx"):
        path = self.p(name)
        doc.save(path)
        return path

    def test_nested_tables_track_changes_and_comments_do_not_crash(self):
        from docx import Document
        from docx.oxml import parse_xml
        from docx.oxml.ns import nsdecls
        d = Document()
        p = d.add_paragraph("正文含修订 ")
        p.add_run("被批注的文字")
        p._p.append(parse_xml('<w:ins %s w:id="1" w:author="a" w:date="2024-01-01T00:00:00Z"><w:r><w:t>新增</w:t></w:r></w:ins>' % nsdecls("w")))
        p._p.append(parse_xml('<w:del %s w:id="2" w:author="a" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>删除</w:delText></w:r></w:del>' % nsdecls("w")))
        d.add_comment(runs=p.runs[1], text="批注", author="x")
        t = d.add_table(rows=1, cols=1)
        cell = t.rows[0].cells[0]
        cell.text = "外层"
        inner = cell.add_table(rows=1, cols=2)
        inner.rows[0].cells[0].text = "内层 XXX"
        code, out = run("docx", "check_docx.py", self.save(d))
        self.assertEqual(code, 0, out)
        self.assertIn("修订", out)
        self.assertIn("批注", out)
        self.assertIn("XXX", out)

    def test_smartart_and_text_box_parts_do_not_crash(self):
        from docx import Document
        from docx.oxml import parse_xml
        from docx.oxml.ns import nsdecls
        d = Document()
        p = d.add_paragraph("含智能图形")
        p.add_run()._r.append(parse_xml(
            '<w:drawing %s xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
            'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline><wp:extent cx="3000000" cy="2000000"/>'
            '<wp:docPr id="9" name="SmartArt"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
            '<dgm:relIds r:dm="rId90" r:lo="rId91" r:qs="rId92" r:cs="rId93"/></a:graphicData></a:graphic></wp:inline></w:drawing>' % nsdecls("w")))
        code, out = run("docx", "check_docx.py", self.save(d))
        self.assertEqual(code, 0, out)

    def test_missing_and_wide_pictures_are_errors(self):
        from docx import Document
        from docx.shared import Cm
        from PIL import Image
        img = self.p("i.png")
        Image.new("RGB", (40, 40), (255, 0, 0)).save(img)
        d = Document()
        d.add_picture(img, width=Cm(30))
        path = self.save(d)
        _, out = run("docx", "check_docx.py", path)
        self.assertIn("超出版心", out)
        # remove the media part: the relationship now points at nothing
        broken = self.p("broken.docx")
        with zipfile.ZipFile(path) as zin, zipfile.ZipFile(broken, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename.startswith("word/media/"):
                    continue
                zout.writestr(item, zin.read(item.filename))
        code, out = run("docx", "check_docx.py", broken)       # python-docx cannot open it: the check must say so plainly
        self.assertEqual(code, 1, out)
        self.assertIn("打不开", out)
        self.assertNotIn("Traceback", out)

    def test_chinese_run_in_a_latin_only_style_is_flagged_and_fix_fonts_clears_it(self):
        from docx import Document
        from docx.oxml.ns import qn
        d = Document()
        for rf in d.styles.element.iter(qn("w:rFonts")):       # a document whose styles name no East Asian font at all
            for attr in ("w:eastAsiaTheme", "w:eastAsia"):
                if rf.get(qn(attr)) is not None:
                    del rf.attrib[qn(attr)]
        d.add_paragraph("只有中文,没有指定中文字体")
        path = self.save(d)
        _, out = run("docx", "check_docx.py", path)
        self.assertIn("没有指定中文字体", out)
        run("docx", "check_docx.py", path, "--fix-fonts", "微软雅黑")
        _, out = run("docx", "check_docx.py", path)
        self.assertNotIn("没有指定中文字体", out)

    def test_corrupt_and_zero_byte_files_get_a_message_not_a_traceback(self):
        for name, data in (("zero.docx", b""), ("junk.docx", b"PK\x03\x04junk")):
            path = self.p(name)
            with open(path, "wb") as fh:
                fh.write(data)
            code, out = run("docx", "check_docx.py", path)
            self.assertEqual(code, 1, out)
            self.assertIn("打不开", out)
            self.assertNotIn("Traceback", out)

    def test_chinese_header_and_footer_do_not_crash_the_check(self):
        from docx import Document
        d = Document()
        d.add_paragraph("正文")
        d.sections[0].header.paragraphs[0].text = "北京示例有限公司"
        d.sections[0].footer.paragraphs[0].text = "第 1 页"
        code, out = run("docx", "check_docx.py", self.save(d))
        self.assertEqual(code, 0, out)
        self.assertNotIn("Traceback", out)


class DocxSkillText(Tmp):
    def test_skill_does_not_tell_the_model_to_ask(self):
        docx = open(os.path.join(ROOT, "docx", "SKILL.md"), encoding="utf-8").read()
        self.assertNotIn("ask the user to save as .docx", docx)


if __name__ == "__main__":
    unittest.main()
