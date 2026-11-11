"""Tests for builtin-skills/pptx/scripts (check_pptx.py).

Run by scripts/officeSkills.test.ts with the bundled Python (python-pptx, lxml, fontTools).
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


class CheckPptx(Tmp):
    def test_reports_off_page_empty_placeholder_small_font_and_overflow(self):
        from pptx import Presentation
        from pptx.util import Inches, Pt
        prs = Presentation()
        s1 = prs.slides.add_slide(prs.slide_layouts[1])
        s1.shapes.title.text = "汇报"
        s1.placeholders[1].text = "\n".join(["这是一段很长很长的中文内容用来测试溢出估算是否有效" * 3] * 8)
        s2 = prs.slides.add_slide(prs.slide_layouts[1])
        s2.shapes.title.text = "第二页"
        tb = s2.shapes.add_textbox(Inches(8), Inches(5), Inches(4), Inches(2))
        tb.text_frame.text = "XXX 请填写"
        tb.text_frame.paragraphs[0].runs[0].font.size = Pt(9)
        path = self.p("a.pptx")
        prs.save(path)
        _, out = run("pptx", "check_pptx.py", path)
        self.assertIn("超出页面", out)
        self.assertIn("是空的", out)
        self.assertIn("可能放不下", out)
        self.assertIn("9 磅", out)

    def test_clean_slide_has_no_error(self):
        from pptx import Presentation
        prs = Presentation()
        s = prs.slides.add_slide(prs.slide_layouts[5])
        s.shapes.title.text = "收入同比增长 18%"
        path = self.p("ok.pptx")
        prs.save(path)
        _, out = run("pptx", "check_pptx.py", path)
        self.assertNotIn("[错误]", out)

    def test_fix_fonts_sets_east_asian_font(self):
        from pptx import Presentation
        prs = Presentation()
        s = prs.slides.add_slide(prs.slide_layouts[5])
        s.shapes.title.text = "中文标题"
        path = self.p("f.pptx")
        prs.save(path)
        run("pptx", "check_pptx.py", path, "--fix-fonts", "微软雅黑")
        _, out = run("pptx", "check_pptx.py", path)
        self.assertNotIn("没有指定中文字体", out)


class PptxEdge(Tmp):
    def deck(self):
        from pptx import Presentation
        return Presentation()

    def strip_theme_ea(self, prs):
        """A deck whose theme names no Chinese font (the default template's theme names 宋体)."""
        import re
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        theme = prs.slide_masters[0].part.part_related_by(RT.THEME)
        blob = theme.blob.decode("utf-8")
        blob = re.sub(r'<a:font script="Hans" typeface="[^"]*"\s*/>', "", blob)
        theme._blob = blob.encode("utf-8")

    def save(self, prs, name="a.pptx"):
        path = self.p(name)
        prs.save(path)
        return path

    def test_chinese_overflow_in_a_fixed_size_box_is_flagged(self):
        from pptx.util import Inches, Pt
        prs = self.deck()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(1.5), Inches(0.8))
        tb.text_frame.word_wrap = True
        tb.text_frame.text = "这是一段需要自动换行并且会溢出的中文文字内容"
        tb.text_frame.paragraphs[0].runs[0].font.size = Pt(24)
        bp = tb.text_frame._txBody.find("{http://schemas.openxmlformats.org/drawingml/2006/main}bodyPr")
        for child in list(bp):
            bp.remove(child)          # a plain box without auto-fit, as templates have
        _, out = run("pptx", "check_pptx.py", self.save(prs))
        self.assertIn("可能放不下", out)

    def test_short_chinese_text_that_fits_is_not_flagged(self):
        from pptx.util import Inches, Pt
        prs = self.deck()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
        tb.text_frame.word_wrap = True
        tb.text_frame.text = "收入同比增长 18%"
        tb.text_frame.paragraphs[0].runs[0].font.size = Pt(24)
        bp = tb.text_frame._txBody.find("{http://schemas.openxmlformats.org/drawingml/2006/main}bodyPr")
        for child in list(bp):
            bp.remove(child)
        _, out = run("pptx", "check_pptx.py", self.save(prs))
        self.assertNotIn("可能放不下", out)

    def test_overflow_is_estimated_for_python_pptx_default_text_boxes(self):
        from pptx.util import Inches, Pt
        prs = self.deck()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        tb = s.shapes.add_textbox(Inches(1), Inches(6.5), Inches(1.5), Inches(0.8))
        tb.text_frame.word_wrap = True
        tb.text_frame.text = "这是一段需要自动换行并且会溢出的中文文字内容" * 2
        tb.text_frame.paragraphs[0].runs[0].font.size = Pt(24)
        _, out = run("pptx", "check_pptx.py", self.save(prs))
        self.assertRegex(out, "可能放不下|超出页面")

    def test_missing_picture_empty_placeholder_tiny_font_and_missing_chinese_font(self):
        from pptx.util import Inches, Pt
        from PIL import Image
        img = self.p("i.png")
        Image.new("RGB", (40, 40), (255, 0, 0)).save(img)
        prs = self.deck()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        s.shapes.add_picture(img, Inches(1), Inches(1), Inches(2), Inches(2))
        tb = s.shapes.add_textbox(Inches(5), Inches(1), Inches(3), Inches(1))
        tb.text_frame.text = "九磅的中文"
        tb.text_frame.paragraphs[0].runs[0].font.size = Pt(9)
        prs.slides.add_slide(prs.slide_layouts[1])      # title + content placeholders left empty
        self.strip_theme_ea(prs)
        path = self.save(prs)
        broken = self.p("b.pptx")
        with zipfile.ZipFile(path) as zin, zipfile.ZipFile(broken, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if not item.filename.startswith("ppt/media/"):
                    zout.writestr(item, zin.read(item.filename))
        code, out = run("pptx", "check_pptx.py", broken)
        self.assertEqual(code, 0, out)
        self.assertIn("文件缺失或损坏", out)
        self.assertIn("是空的", out)
        self.assertIn("9 磅", out)
        self.assertIn("没有指定中文字体", out)

    def test_groups_charts_tables_notes_and_empty_slides_do_not_crash(self):
        from pptx.chart.data import CategoryChartData
        from pptx.enum.chart import XL_CHART_TYPE
        from pptx.util import Inches
        prs = self.deck()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        g = s.shapes.add_group_shape()
        g.shapes.add_textbox(Inches(5), Inches(4), Inches(2), Inches(1)).text_frame.text = "组内 XXX"
        cd = CategoryChartData()
        cd.categories = ["甲", "乙"]
        cd.add_series("销量", (1, 2))
        s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(5), Inches(4), Inches(2), cd)
        s.shapes.add_table(2, 2, Inches(6), Inches(5), Inches(3), Inches(1)).table.cell(0, 0).text = "表 TODO"
        s.notes_slide.notes_text_frame.text = "备注"
        prs.slides.add_slide(prs.slide_layouts[6])
        code, out = run("pptx", "check_pptx.py", self.save(prs))
        self.assertEqual(code, 0, out)
        self.assertIn("XXX", out)
        self.assertIn("TODO", out)

    def test_a_table_running_off_the_slide_is_reported(self):
        from pptx.util import Inches
        prs = self.deck()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        tbl = s.shapes.add_table(12, 2, Inches(1), Inches(4), Inches(8), Inches(5)).table
        for r in range(12):
            tbl.cell(r, 0).text = "第 %d 行" % r
        _, out = run("pptx", "check_pptx.py", self.save(prs))
        self.assertIn("会超出页面底部", out)

    def test_corrupt_files_get_a_message(self):
        for name, data in (("zero.pptx", b""), ("junk.pptx", b"PK\x03\x04junk")):
            path = self.p(name)
            with open(path, "wb") as fh:
                fh.write(data)
            code, out = run("pptx", "check_pptx.py", path)
            self.assertEqual(code, 1, out)
            self.assertIn("打不开", out)
            self.assertNotIn("Traceback", out)


if __name__ == "__main__":
    unittest.main()
