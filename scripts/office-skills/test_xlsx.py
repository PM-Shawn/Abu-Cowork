"""Tests for builtin-skills/xlsx/scripts (check_xlsx.py, office_env.py).

Run by scripts/officeSkills.test.ts with the bundled Python (openpyxl, XlsxWriter, matplotlib, fontTools).
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

D_TEXT_NUM = "20"


class OfficeEnv(Tmp):
    def test_report_has_a_font_per_role(self):
        code, out = run("xlsx", "office_env.py")
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertEqual(set(report["chinese_fonts"]), {"sans", "serif", "heiti"})
        self.assertNotIn("soffice", report)


class CheckXlsx(Tmp):
    def make(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "汇总"
        ws.append(["部门", "一月", "合计"])
        for i, (n, a) in enumerate([("销售", 120.5), ("市场", 80), ("研发", 300)], start=2):
            ws.append([n, a, f"=B{i}*2"])
        ws.append(["总计", "=SUM(B2:B3)", "=SUM(C2:C4)"])      # first total stops short
        ws["E1"] = "=1/0"
        ws["E2"] = "=Missing!A1"
        ws["E3"] = '=IF(B2>100,"高","低")'
        path = self.p("a.xlsx")
        wb.save(path)
        return path

    def test_reports_errors_short_total_and_estimates_values(self):
        _, out = run("xlsx", "check_xlsx.py", self.make(), "--values")
        self.assertIn("#DIV/0!", out)
        self.assertIn("不存在的工作表", out)
        self.assertIn("合计只到第 3 行", out)
        self.assertIn("C5 = 1001", out.replace("汇总!", ""))
        self.assertIn("8/8 个公式在本地做了估算", out)
        self.assertNotIn("独立算过", out)
        self.assertNotIn("[错误] 汇总!E1", out)      # an estimated error is a hint, never a certain error

    def test_check_does_not_write_values_and_has_no_fix_option(self):
        from openpyxl import load_workbook
        path = self.make()
        code, _ = run("xlsx", "check_xlsx.py", path, "--fix")
        self.assertNotEqual(code, 0)
        self.assertIsNone(load_workbook(path, data_only=True)["汇总"]["C5"].value)

    def test_unsupported_function_is_said_to_be_unverified(self):
        from openpyxl import Workbook
        wb = Workbook()
        wb.active["A1"] = "=XLOOKUP(1,B1:B2,C1:C2)"
        path = self.p("u.xlsx")
        wb.save(path)
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertIn("XLOOKUP", out)
        self.assertIn("无法在本地验证", out)

    def chain(self, n, name="chain.xlsx"):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws["A1"] = 1
        for i in range(2, n + 1):
            ws[f"A{i}"] = f"=A{i - 1}+1"
        ws["B1"] = f"=SUM(A{n})"
        path = self.p(name)
        wb.save(path)
        return path

    def test_a_long_dependency_chain_is_estimated_on_the_default_stack(self):
        code, out = run("xlsx", "check_xlsx.py", self.chain(5000), "--values")
        self.assertEqual(code, 0, out)
        self.assertIn("5000/5000 个公式在本地做了估算", out)
        self.assertIn("B1 = 5000", out)

    def test_the_check_runs_where_the_thread_stack_size_cannot_be_set(self):
        # the Windows runtime refuses threading.stack_size(256 MB) with ValueError
        wrapper = (
            "import runpy, sys, threading\n"
            "def refuse(size=0):\n"
            "    if size: raise ValueError('size not valid: %d bytes' % size)\n"
            "    return 0\n"
            "threading.stack_size = refuse\n"
            "sys.argv = sys.argv[1:]\n"
            "runpy.run_path(sys.argv[0], run_name='__main__')\n"
        )
        for name, path in (("plain", self.make()), ("chain", self.chain(3000))):
            proc = subprocess.run([sys.executable, "-I", "-c", wrapper, script("xlsx", "check_xlsx.py"), path],
                                  capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.assertEqual(proc.returncode, 0, name + proc.stdout + proc.stderr)
            self.assertIn("文件:", proc.stdout)

    def test_no_script_changes_the_thread_stack_size(self):
        import ast
        scripts = os.path.join(ROOT, "xlsx", "scripts")
        for file in os.listdir(scripts):
            if file.endswith(".py"):
                with open(os.path.join(scripts, file), encoding="utf-8") as fh:
                    tree = ast.parse(fh.read())
                names = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
                names |= {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
                self.assertNotIn("stack_size", names, file)
                self.assertNotIn("setrecursionlimit", names, file)


class XlsxValues(Tmp):
    """Formulas are written to sheet S, data to sheet D. The checker never writes values into a file; its
    estimates are printed by --values and these tests hold every printed estimate to what Excel computes.
    A formula the checker cannot compute exactly prints no estimate (None here)."""

    def build(self, formulas):
        import datetime
        from openpyxl import Workbook
        from openpyxl.workbook.defined_name import DefinedName
        wb = Workbook()
        d = wb.active
        d.title = "D"
        for i, v in enumerate([10, D_TEXT_NUM, None, 5, "abc", 2.5], 1):     # A: numbers, a text number, text, blank
            if v is not None:
                d.cell(i, 1, v)
        d["A7"] = True                                                     # a boolean
        for i, (b, c) in enumerate([("apple", 1), ("apricot", 2), ("banana", 3), ("Apple", 4), ("a*b", 5), ("ab", 6)], 1):
            d.cell(i, 2, b)
            d.cell(i, 3, c)
        for i, (e, f) in enumerate([(1, "a"), (3, "b"), (5, "c"), (7, "d")], 1):
            d.cell(i, 5, e)
            d.cell(i, 6, f)
        d["H1"] = datetime.datetime(2024, 1, 31)
        d["H2"] = datetime.datetime(2024, 3, 1)
        d["I1"] = 0.15
        d["I1"].number_format = "0%"
        d["J1"] = "123"
        d["K1"] = "15%"
        d.merge_cells("A10:C10")
        d["A10"] = 7
        sp = wb.create_sheet("Sheet With Space")
        sp["A1"] = 5
        sp["B2"] = "=D!A1*2"
        wb.defined_names["Total"] = DefinedName("Total", attr_text="D!$A$1:$A$6")
        wb.defined_names["Rate"] = DefinedName("Rate", attr_text="D!$I$1")
        s = wb.create_sheet("S")
        for i, f in enumerate(formulas, 1):
            s.cell(i, 1, f)
        path = self.p("v.xlsx")
        wb.save(path)
        return path

    def values(self, formulas):
        import re
        path = self.build(formulas)
        code, out = run("xlsx", "check_xlsx.py", path, "--values")
        self.assertEqual(code, 0, out)
        got = {}
        for m in re.finditer(r"^\s+S!A(\d+) = (.*?)    =", out, re.M):
            text = m.group(2)
            if text in ("True", "False"):
                val = text == "True"
            else:
                try:
                    val = float(text)
                except ValueError:
                    val = text
            got[int(m.group(1))] = val
        return [got.get(i) for i in range(1, len(formulas) + 1)], out

    def only_exact(self, table):
        """Every estimate that is printed must equal Excel's value; a missing one ("not verified") is allowed."""
        got, _ = self.values([f for f, _ in table])
        for (f, want), g in zip(table, got):
            if g is not None:
                if isinstance(want, float):
                    self.assertAlmostEqual(g, want, places=9, msg=f)
                else:
                    self.assertEqual(g, want, f)

    def check(self, table):
        formulas = [f for f, _ in table]
        got, out = self.values(formulas)
        for (f, want), g in zip(table, got):
            if isinstance(want, float):
                self.assertIsNotNone(g, f)
                self.assertAlmostEqual(g, want, places=9, msg=f)
            else:
                self.assertEqual(g, want, f)

    def test_rounding_halves_away_from_zero_like_excel(self):
        self.check([
            ("=ROUND(2.5,0)", 3), ("=ROUND(-2.5,0)", -3), ("=ROUND(0.5,0)", 1), ("=ROUND(-0.5,0)", -1),
            ("=ROUND(5.5,0)", 6), ("=ROUND(6.5,0)", 7), ("=ROUND(1.005,2)", 1.01), ("=ROUND(2.675,2)", 2.68),
            ("=ROUND(1.15,1)", 1.2), ("=ROUND(2.345,2)", 2.35), ("=ROUND(1234.5,-2)", 1200), ("=ROUND(-1234.5,-1)", -1230),
            ("=ROUNDUP(2.1,0)", 3), ("=ROUNDUP(-2.1,0)", -3), ("=ROUNDUP(1.001,2)", 1.01), ("=ROUNDDOWN(-2.9,0)", -2),
            ("=ROUNDDOWN(1.1*3,1)", 3.3), ("=ROUND(0.1+0.2,1)", 0.3),
        ])

    def test_arithmetic_precedence_and_integer_functions(self):
        self.check([("=-2^2", 4), ("=2^3^2", 64), ("=INT(-1.5)", -2), ("=MOD(-7,3)", 2), ("=MOD(7,-3)", -2),
                    ("=50%*200", 100), ("=D!I1*100", 15), ("=Rate*100", 15)])

    def test_dates_are_never_guessed_and_date_arithmetic_is(self):
        got, out = self.values(["=DATE(2024,2,30)", "=DATEDIF(DATE(2020,1,31),DATE(2020,3,1),\"md\")", "=EDATE(D!H1,1)",
                                '=TEXT(D!H1,"yyyy-mm-dd")', "=TODAY()", "=D!H2-D!H1", "=D!H1+1"])
        self.assertEqual(got[:5], [None] * 5)     # cannot be computed exactly: no cached value is written
        self.assertEqual(got[5], 30)
        self.assertEqual(got[6], 45323)
        self.assertIn("无法在本地验证", out)

    def test_text_numbers_in_arithmetic_and_ranges(self):
        self.check([
            ("=D!A2+1", 21), ("=D!J1+0", 123), ("=D!K1+0", 0.15), ('=D!J1&"x"', "123x"),
            ("=SUM(D!A1:A6)", 17.5), ("=COUNT(D!A1:A6)", 3), ("=COUNTA(D!A1:A6)", 5), ("=MAX(D!A1:A6)", 10),
            ("=MIN(D!A1:A6)", 2.5), ("=AVERAGE(D!A1:A6)", 17.5 / 3), ("=SUM(D!A1:A7)", 17.5),
            ("=D!A7+1", 2), ("=SUM(TRUE,1)", 2), ("=COUNT(D!A2)", 0),
        ])

    def test_empty_cells_in_sum_and_average(self):
        self.check([("=AVERAGE(D!A2:A3)", "#DIV/0!"), ("=IFERROR(AVERAGE(D!A2:A3),0)", 0), ("=SUM(D!A3)", 0),
                    ("=D!A3+1", 1), ("=D!B20&\"x\"", "x"), ("=MAX(D!A3:A3)", 0), ("=IF(D!A3=\"\",\"blank\",\"no\")", "blank"),
                    ("=D!A3=0", True)])

    def test_iferror_catches_only_errors(self):
        self.check([('=IFERROR(1/0,"x")', "x"), ("=IFERROR(4,9)", 4), ('=IFERROR(VLOOKUP(99,D!E1:F4,2,FALSE),"none")', "none"),
                    ('=IFERROR(NOSUCH(1),"unknown")', None)])

    def test_vlookup_exact_and_approximate(self):
        self.check([
            ("=VLOOKUP(3,D!E1:F4,2,FALSE)", "b"), ("=VLOOKUP(4,D!E1:F4,2,FALSE)", "#N/A"), ("=VLOOKUP(4,D!E1:F4,2,TRUE)", "b"),
            ("=VLOOKUP(0,D!E1:F4,2,TRUE)", "#N/A"), ("=VLOOKUP(99,D!E1:F4,2,TRUE)", "d"), ("=VLOOKUP(4,D!E1:F4,2)", "b"),
            ('=VLOOKUP("APPLE",D!B1:C6,2,0)', 1), ('=VLOOKUP("3",D!E1:F4,2,FALSE)', "#N/A"), ("=VLOOKUP(3,D!E1:F4,3,FALSE)", "#REF!"),
        ])

    def test_countif_sumif_family_and_wildcards(self):
        self.check([
            ('=COUNTIF(D!A1:A6,">5")', 1), ('=COUNTIF(D!B1:B6,"ap*")', 3), ('=COUNTIF(D!B1:B6,"a?")', 1),
            ('=COUNTIF(D!B1:B6,"*an*")', 1), ('=COUNTIF(D!B1:B6,"apple")', 2), ('=COUNTIF(D!B1:B6,"<>apple")', 4),
            ('=SUMIF(D!B1:B6,"ap*",D!C1:C6)', 7), ('=SUMIFS(D!C1:C6,D!B1:B6,"ap*",D!C1:C6,">1")', 6),
            ('=COUNTIFS(D!B1:B6,"ap*",D!C1:C6,"<4")', 2), ('=SUMIF(D!C1:C6,">3")', 15), ("=SUMIF(D!C1:C6,3,D!C1:C6)", 3),
        ])

    def test_cross_sheet_references_defined_names_and_merged_cells(self):
        self.check([("='Sheet With Space'!A1+1", 6), ("='Sheet With Space'!B2", 20), ("=SUM(Total)", 17.5),
                    ("=SUM(D!A10:C10)", 7), ("=D!B10+1", 1), ("=Missing!A1", "#REF!")])

    def test_percent_cells_and_literals(self):
        self.check([("=10%+5%", 0.15), ("=D!I1*200", 30), ("=D!I1", 0.15)])

    def test_comparison_rules(self):
        self.check([('=("a"="A")', True), ('=(10>"5")', False), ("=D!A2>10", True), ("=D!A2=20", False)])

    def test_text_number_through_a_single_cell_reference_is_ignored_by_aggregates(self):
        # In Excel SUM/AVERAGE/MIN/MAX ignore text and booleans that arrive through a reference.
        self.check([("=SUM(D!A2)", 0), ("=SUM(D!J1)", 0), ("=AVERAGE(D!A2)", "#DIV/0!"), ("=MAX(D!A2)", 0),
                    ("=MIN(D!A2)", 0), ("=SUM(D!A7)", 0), ("=SUM(D!A1,D!A2,D!A4)", 15), ("=SUM(\"3\",1)", 4)])

    def test_countif_tilde_escapes_a_wildcard(self):
        self.only_exact([('=COUNTIF(D!B1:B6,"a~*b")', 1)])

    def test_vlookup_exact_match_accepts_wildcards(self):
        self.only_exact([('=VLOOKUP("ban*",D!B1:C6,2,FALSE)', 3)])
        _, out = self.values(['=VLOOKUP("ban*",D!B1:C6,2,FALSE)'])
        self.assertNotIn("[错误]", out)
        self.assertNotIn("#N/A", out)

    def test_cases_found_by_the_reviewer_are_exact_or_not_verified(self):
        self.only_exact([
            ('=COUNTA(D!A1:A6)', 5), ("=INDEX(D!A1:A6,0)", None), ("=SUMIF(D!B1:B6,\"ap*\",D!C1:C3)", None),
            ("='sheet with space'!A1+1", 6), ("=VLOOKUP(4,D!E1:F4,2,TRUE)", "b"), ("=TRUE()", True),
            ('=COUNTIF(D!H1:H2,"2024-01-31")', None), ('=SUMIFS(D!C1:C6,D!H1:H2,"2024-01-31")', None),
        ])
        got, _ = self.values(["=INDEX(D!A1:A6,0)", "=SUMIF(D!B1:B6,\"ap*\",D!C1:C3)"])
        self.assertEqual(got, [None, None])

    def test_no_value_is_ever_compared_with_a_cached_value(self):
        import xlsxwriter
        path = self.p("z.xlsx")
        wb = xlsxwriter.Workbook(path)
        ws = wb.add_worksheet("S")
        ws.write("A1", 5)
        ws.write_formula("A2", "=A1*2", None, 999)      # a cached value of Excel's own: never called stale
        wb.close()
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertNotIn("不一致", out)
        self.assertNotIn("旧缓存", out)
        self.assertNotIn("独立算过", out)


class XlsxFix(Tmp):
    def test_the_check_never_changes_the_file(self):
        import hashlib
        import xlsxwriter
        path = self.p("x.xlsx")
        wb = xlsxwriter.Workbook(path)
        ws = wb.add_worksheet("S")
        ws.write("A1", 5)
        ws.write_formula("A2", "=DATE(2024,1,1)", None, 45292)
        ws.write_formula("A3", "=A1*2", None, 0)
        wb.close()
        digest = lambda: hashlib.sha256(open(path, "rb").read()).hexdigest()
        before = digest()
        for extra in ([], ["--values"]):
            code, _ = run("xlsx", "check_xlsx.py", path, *extra)
            self.assertEqual(code, 0)
            self.assertEqual(digest(), before)
        code, out = run("xlsx", "check_xlsx.py", path, "--fix")
        self.assertNotEqual(code, 0)             # the value-writing option is gone
        self.assertEqual(digest(), before)
        self.assertNotIn("独立算过", out)

    def test_clean_files_from_xlsxwriter_and_openpyxl_raise_no_error_or_attention(self):
        import xlsxwriter
        from openpyxl import Workbook
        from openpyxl.chart import BarChart, Reference
        rows = [("销售", 120.5, 130), ("市场", 80, 95.5), ("研发", 300, 310)]
        xw = self.p("xw.xlsx")
        wb = xlsxwriter.Workbook(xw)
        ws = wb.add_worksheet("销售")
        money = wb.add_format({"num_format": "#,##0.00"})
        ws.set_column("A:D", 14)
        ws.write_row(0, 0, ["部门", "一季度", "二季度", "合计"])
        for i, (n, a, c) in enumerate(rows, 1):
            ws.write(i, 0, n)
            ws.write(i, 1, a, money)
            ws.write(i, 2, c, money)
            ws.write_formula(i, 3, f"=B{i + 1}+C{i + 1}", money, a + c)
        ws.write(4, 0, "总计")
        ws.write_formula(4, 1, "=SUM(B2:B4)", money, 500.5)
        ws.write_formula(4, 2, "=SUM(C2:C4)", money, 535.5)
        ws.write_formula(4, 3, "=SUM(D2:D4)", money, 1036)
        ws.merge_range("A8:D8", "说明")
        wb.define_name("总额", "=销售!$D$5")
        ws.write_formula(8, 0, "=总额*2", money, 2072)
        ch = wb.add_chart({"type": "column"})
        ch.add_series({"values": "=销售!$B$2:$B$4", "categories": "=销售!$A$2:$A$4"})
        ws.insert_chart("F2", ch)
        wb.close()
        code, out = run("xlsx", "check_xlsx.py", xw)
        self.assertEqual(code, 0, out)
        self.assertNotIn("[错误]", out)
        self.assertNotIn("[注意]", out)

        op = self.p("op.xlsx")
        w = Workbook()
        s = w.active
        s.title = "销售"
        s.append(["部门", "一季度", "二季度", "合计"])
        for i, (n, a, c) in enumerate(rows, 2):
            s.append([n, a, c, f"=B{i}+C{i}"])
        s.append(["总计", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"])
        for col in "ABCD":
            s.column_dimensions[col].width = 14
        bc = BarChart()
        bc.add_data(Reference(s, min_col=2, min_row=1, max_row=4), titles_from_data=True)
        s.add_chart(bc, "F2")
        w.save(op)
        _, out = run("xlsx", "check_xlsx.py", op)
        self.assertNotIn("[错误]", out)
        self.assertNotIn("[注意]", out)

    def test_real_errors_are_still_reported(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws["A1"], ws["A2"], ws["A3"] = 1, 2, 3
        ws["B1"] = "=A1/0"
        ws["B2"] = "=#REF!+1"
        ws["B3"] = "=SUM(A1:A2)"        # stops short of A3
        path = self.p("e.xlsx")
        wb.save(path)
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertIn("#DIV/0!", out)
        self.assertIn("#REF!", out)

    def _pivot_workbook(self):
        """A workbook with one hand-built pivot table over Data!A1:B3, as Excel stores it."""
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Data"
        ws.append(["k", "v"])
        ws.append(["a", 1])
        ws.append(["b", 2])
        ws["D1"] = "=SUM(B2:B3)"
        wb.create_sheet("Rpt")
        path = self.p("pv.xlsx")
        wb.save(path)
        ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        parts = {
            "xl/pivotCache/pivotCacheDefinition1.xml":
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheDefinition {ns} r:id="rId1" refreshOnLoad="1" recordCount="2">'
                '<cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Data"/></cacheSource><cacheFields count="2">'
                '<cacheField name="k" numFmtId="0"><sharedItems count="2"><s v="a"/><s v="b"/></sharedItems></cacheField>'
                '<cacheField name="v" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="1" maxValue="2"/></cacheField>'
                '</cacheFields></pivotCacheDefinition>',
            "xl/pivotCache/pivotCacheRecords1.xml":
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotCacheRecords {ns} count="2"><r><x v="0"/><n v="1"/></r><r><x v="1"/><n v="2"/></r></pivotCacheRecords>',
            "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels":
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords" Target="pivotCacheRecords1.xml"/></Relationships>',
            "xl/pivotTables/pivotTable1.xml":
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotTableDefinition {ns} name="PivotTable1" cacheId="1" dataCaption="Values" updatedVersion="6" createdVersion="6">'
                '<location ref="A3:B6" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/><pivotFields count="2"><pivotField axis="axisRow" showAll="0"><items count="3"><item x="0"/><item x="1"/><item t="default"/></items></pivotField>'
                '<pivotField dataField="1" showAll="0"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><rowItems count="3"><i><x/></i><i><x v="1"/></i><i t="grand"><x/></i></rowItems>'
                '<colItems count="1"><i/></colItems><dataFields count="1"><dataField name="Sum of v" fld="1" baseField="0" baseItem="0"/></dataFields></pivotTableDefinition>',
            "xl/pivotTables/_rels/pivotTable1.xml.rels":
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/></Relationships>',
            "xl/worksheets/_rels/sheet2.xml.rels":
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>',
        }
        out = self.p("book2.xlsx")
        with zipfile.ZipFile(path) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == "[Content_Types].xml":
                    text = data.decode()
                    add = ('<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>'
                           '<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>'
                           '<Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>')
                    data = text.replace("</Types>", add + "</Types>").encode()
                elif item.filename == "xl/workbook.xml":
                    text = data.decode()
                    text = text.replace("</sheets>", '</sheets><pivotCaches><pivotCache cacheId="1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdPv1"/></pivotCaches>')
                    data = text.encode()
                elif item.filename == "xl/_rels/workbook.xml.rels":
                    data = data.decode().replace("</Relationships>", '<Relationship Id="rIdPv1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/></Relationships>').encode()
                zout.writestr(item, data)
            for name, text in parts.items():
                zout.writestr(name, text)
        return out

    def test_pivot_table_is_reported(self):
        _, out = run("xlsx", "check_xlsx.py", self._pivot_workbook())
        self.assertRegex(out, "透视")
        self.assertIn("副本", out)


class OfficeEnvEdge(Tmp):
    def load(self, **env):
        """Import a fresh copy of office_env with the font search redirected."""
        import importlib.util
        spec = importlib.util.spec_from_file_location("office_env_t", script("xlsx", "office_env.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def with_dirs(self, mod, dirs):
        mod._font_dirs = lambda: dirs
        mod._fonts_memo = None
        tempfile.tempdir = self.p("tmp")
        os.makedirs(tempfile.tempdir, exist_ok=True)
        self.addCleanup(setattr, tempfile, "tempdir", None)
        return mod

    def test_no_chinese_font_installed_gives_none_and_a_warning_not_a_crash(self):
        import contextlib
        mod = self.with_dirs(self.load(), [])
        self.assertTrue(all(mod.pick_font(role) is None for role in mod.FONT_CHAINS))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertIsNone(mod.setup_matplotlib_cjk())
        self.assertIn("no Chinese font", err.getvalue())
        self.assertFalse(mod.has_font("仿宋_GB2312"))
        # reportlab falls back to the built-in CID font
        self.assertEqual(mod.register_reportlab_cjk(), "STSong-Light")

    def test_chart_with_chinese_labels_still_renders_without_a_font(self):
        mod = self.with_dirs(self.load(), [])
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import contextlib
        with contextlib.redirect_stderr(io.StringIO()):
            mod.setup_matplotlib_cjk()
        fig, ax = plt.subplots()
        ax.bar(["销售", "市场"], [1, 2])
        ax.set_title("季度收入")
        out = self.p("c.png")
        fig.savefig(out)
        plt.close(fig)
        self.assertGreater(os.path.getsize(out), 1000)

    def make_font(self, path, family, style="Regular", full=None):
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.ttGlyphPen import TTGlyphPen
        fb = FontBuilder(1000, isTTF=True)
        fb.setupGlyphOrder([".notdef"])
        fb.setupCharacterMap({})
        pen = TTGlyphPen(None)
        fb.setupGlyf({".notdef": pen.glyph()})
        fb.setupHorizontalMetrics({".notdef": (500, 0)})
        fb.setupHorizontalHeader(ascent=800, descent=-200)
        fb.setupNameTable({"familyName": family, "styleName": style, **({"fullName": full} if full else {})})
        fb.setupOS2()
        fb.setupPost()
        fb.save(path)

    def test_font_lookup_by_family_full_name_and_chinese_name_in_nested_folders_with_spaces(self):
        fonts = os.path.join(self.dir, "我的 字体", "sub folder")
        os.makedirs(fonts)
        self.make_font(os.path.join(fonts, "a.ttf"), "Noto_Serif CJK SC")
        self.make_font(os.path.join(fonts, "b.ttf"), "宋体", full="宋体 Regular")
        self.make_font(os.path.join(fonts, "c.ttf"), "Microsoft YaHei", style="Bold")
        mod = self.with_dirs(self.load(), [os.path.join(self.dir, "我的 字体")])
        self.assertTrue(mod.has_font("noto serif cjk sc"))        # case, space and underscore insensitive
        self.assertTrue(mod.has_font("宋体"))
        self.assertEqual(mod.pick_font("serif"), "宋体")
        self.assertEqual(mod.pick_font("sans"), "Microsoft YaHei")    # only a bold face is installed: still usable
        path, _ = mod.font_file("宋体")
        self.assertTrue(path.endswith("b.ttf"))

    def test_broken_font_files_and_an_unreadable_cache_are_ignored(self):
        fonts = os.path.join(self.dir, "f")
        os.makedirs(fonts)
        with open(os.path.join(fonts, "bad.ttf"), "wb") as fh:
            fh.write(b"not a font")
        self.make_font(os.path.join(fonts, "ok.ttf"), "SimHei")
        mod = self.with_dirs(self.load(), [fonts])
        cache = os.path.join(tempfile.gettempdir(), "abu-work", "office-fonts-cache.json")
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w") as fh:
            fh.write('{"signature": [3, [["x", 1]], "fonts": ')          # truncated, as after a killed write
        self.assertTrue(mod.has_font("SimHei"))
        mod._fonts_memo = None
        self.assertTrue(mod.has_font("SimHei"))                          # second load reads the repaired cache

    def test_windows_font_folders_come_from_the_environment(self):
        win = os.path.join(self.dir, "Win")
        local = os.path.join(self.dir, "Local")
        roam = os.path.join(self.dir, "Roam")
        for d in (os.path.join(win, "Fonts"), os.path.join(local, "Microsoft", "Windows", "Fonts"),
                  os.path.join(roam, "kingsoft", "office6", "fonts")):
            os.makedirs(d)
        mod = self.load()
        saved = (sys.platform, {k: os.environ.get(k) for k in ("WINDIR", "LOCALAPPDATA", "APPDATA")})
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v) for k, v in saved[1].items()])
        os.environ.update({"WINDIR": win, "LOCALAPPDATA": local, "APPDATA": roam})
        mod.sys = type("S", (), {"platform": "win32", "stdout": sys.stdout, "stderr": sys.stderr})
        dirs = mod._font_dirs()
        self.assertEqual([os.path.relpath(d, self.dir).replace(os.sep, "/") for d in dirs],
                         ["Win/Fonts", "Local/Microsoft/Windows/Fonts", "Roam/kingsoft/office6/fonts"])


class RecheckXlsx(Tmp):
    """Second review (after the B1 fix): hints and estimates must match Excel; values from LibreOffice 7 and Excel."""

    build, values, only_exact = XlsxValues.build, XlsxValues.values, XlsxValues.only_exact

    # BUG(found by tester): the engine coerces text the Python way. AND/OR over a range read text as #VALUE! (Excel
    # ignores text in references), date text is not turned into a date in arithmetic, and IF("TRUE") is not read as
    # TRUE, so each of these prints a "[提示] 按本机估算这格会显示 #VALUE!" for a formula that Excel computes.
    def test_no_error_hint_where_excel_computes_a_value(self):
        table = [('=AND(D!A1:A5)', True), ('="2025-03-05"+1', 45722.0), ('=IF("TRUE",1,2)', 1.0)]
        got, out = self.values([f for f, _ in table])
        self.assertNotIn("#VALUE!", out)
        self.only_exact(table)

    # BUG(found by tester): estimates printed by --values that differ from Excel: Python's float() accepts "1_000",
    # MID/LEFT with a start or length below the allowed range return text instead of #VALUE!, COUNT ignores a
    # number typed as text in its own arguments, COUNTIF "TRUE" does not match the boolean TRUE.
    def test_printed_estimates_match_excel_for_coercion_edge_cases(self):
        self.only_exact([('="1_000"+0', "#VALUE!"), ('=MID("abcdef",0,2)', "#VALUE!"), ('=LEFT("abcdef",-1)', "#VALUE!"),
                         ('=COUNT("5",D!A1)', 2.0), ('=COUNTIF(D!A7:A7,"TRUE")', 1.0)])

    # BUG(found by tester): an AVERAGE (or any other aggregate) row between the data and the total counts as data,
    # so a correct =SUM(B2:B4) under a 平均 row is reported as "[错误] 合计只到第 4 行,下面第 5 行还有数据没算进去".
    # The skill tells the model to fix every structure error, and extending the SUM over the average gives a wrong total.
    def test_an_average_row_above_the_total_is_not_a_short_total(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(["项目", "金额"])
        for i, v in enumerate([100, 200, 300], start=2):
            ws.append([f"x{i}", v])
        ws.append(["平均", "=AVERAGE(B2:B4)"])
        ws.append(["合计", "=SUM(B2:B4)"])
        path = self.p("avg.xlsx")
        wb.save(path)
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertNotIn("[错误]", out)

    def test_a_total_that_skips_a_typed_number_is_still_an_error(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(["项目", "金额"])
        for i, v in enumerate([100, 200, 300, 400], start=2):
            ws.append([f"x{i}", v])
        ws.append(["合计", "=SUM(B2:B4)"])
        path = self.p("short.xlsx")
        wb.save(path)
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertRegex(out, r"\[错误\] Sheet!B6 .*第 5 行")


class XlsxFixRound2(Tmp):
    def test_xlsxwriter_zero_placeholders_count_as_not_computed(self):
        import xlsxwriter
        path = self.p("w.xlsx")
        wb = xlsxwriter.Workbook(path)
        ws = wb.add_worksheet("s")
        for i, v in enumerate([5, 7, 9]):
            ws.write(i, 0, v)
        ws.write_formula(3, 0, "=SUM(A1:A3)")
        ws.write_formula(4, 0, "=AVERAGE(A1:A3)")
        wb.close()
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertIn("没有保存真正的计算结果", out)
        self.assertNotIn("[错误]", out)

    def test_a_row_built_from_one_formula_shape_gets_no_pattern_hint(self):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        for r in (1, 2):
            ws.append([f"p{r}"] + [r * c for c in range(1, 6)])
        cols = "BCDEF"
        ws.append(["a"] + [f"={c}1*2" for c in cols])        # row 3
        ws.append(["b"] + [f"={c}1+{c}2" for c in cols])     # row 4: unlike rows 3 and 5
        ws.append(["c"] + [f"={c}3*2" for c in cols])        # row 5
        path = self.p("p.xlsx")
        wb.save(path)
        _, out = run("xlsx", "check_xlsx.py", path)
        self.assertEqual(out.count("规律不一样"), 0, out)

    def block_layout(self, wrong_cell=False):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(["项目"] + ["1月", "2月", "3月"])
        cols = "BCD"
        for r in (2, 3):                                    # data rows
            ws.append([f"a{r}"] + [f"=SUMPRODUCT(({c}$1=\"x\")*1)+{r}" for c in cols])
        ws.append(["小计"] + [f"=SUM({c}2:{c}3)" for c in cols])           # row 4
        for r in (5, 6):                                    # data rows
            ws.append([f"b{r}"] + [f"=SUMPRODUCT(({c}$1=\"x\")*1)+{r}" for c in cols])
        ws.append(["小计"] + [f"=SUM({c}5:{c}6)" for c in cols])           # row 7
        ws.append(["总计"] + [f"={c}4+{c}7" for c in cols])                 # row 8
        if wrong_cell:
            ws["C3"] = "=SUMPRODUCT((C$1=\"x\")*1)+99"                        # one data cell off its neighbours' pattern
        path = self.p("blocks.xlsx")
        wb.save(path)
        return run("xlsx", "check_xlsx.py", path)[1]

    def test_subtotal_and_total_rows_are_not_odd_cells(self):
        self.assertNotIn("规律不一样", self.block_layout())

    def test_one_cell_that_breaks_its_neighbours_is_still_reported(self):
        out = self.block_layout(wrong_cell=True)
        self.assertIn("规律不一样", out)


if __name__ == "__main__":
    unittest.main()
