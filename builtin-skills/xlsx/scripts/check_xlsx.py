#!/usr/bin/env python3
"""Check an .xlsx file before handing it over, without Excel or LibreOffice.

    python check_xlsx.py report.xlsx            # print problems and a summary
    python check_xlsx.py report.xlsx --values   # also list the values this script estimates

What it does
- Structure checks: errors saved in the file, formulas pointing at missing sheets or #REF!, links to
  other files, pivot tables and slicers (openpyxl drops them), totals that stop short of the data, a
  cell whose formula differs from its neighbours, a typed number among formulas, numbers stored as
  text, columns too narrow (#####), chart series pointing at empty cells.
- A small formula engine estimates the common functions (SUM, AVERAGE, IF, SUMIF(S), COUNTIF(S),
  VLOOKUP, INDEX/MATCH, ROUND, ...) only to give a hint such as "this will probably show #DIV/0!".
  It handles only cases it computes exactly as Excel does; anything else is counted as "not
  verified". Its numbers are never written into the file and never replace Excel's own result: the
  real values come from Excel/WPS when the file is opened.
- Output is a short list: [错误] certain problem, [注意] look at it, [提示] a guess or a hint that
  you must judge yourself (a hint is not an instruction to change the file).

Exit code is 0 when the file opens; the verdict is in the printed text.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import math
import os
import re
import sys
import zipfile
from decimal import ROUND_HALF_UP, Decimal

try:
    from openpyxl import load_workbook
    from openpyxl.formula.tokenizer import Token, Tokenizer
    from openpyxl.formula.translate import Translator
    from openpyxl.utils import column_index_from_string, get_column_letter
    from openpyxl.utils.datetime import to_excel
except ImportError as exc:  # pragma: no cover
    print(f"openpyxl is required: {exc}")
    sys.exit(2)

MAX_CELLS_TO_EVALUATE = 300_000
ERRORS = ("#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!")


class XlError(str):
    """An Excel error value such as #DIV/0!."""


class Unsupported(Exception):
    """The value depends on something this checker does not compute."""


# ───────────────────────────── formula engine ─────────────────────────────

class Rng:
    """A rectangular block of values (row-major list of lists)."""

    def __init__(self, rows):
        self.rows = rows

    def flat(self):
        for row in self.rows:
            yield from row

    @property
    def shape(self):
        return len(self.rows), (len(self.rows[0]) if self.rows else 0)


_REF = re.compile(r"^(?:(?:'((?:[^']|'')+)'|([^'!:\s]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$")
_COLREF = re.compile(r"^(?:(?:'((?:[^']|'')+)'|([^'!:\s]+))!)?\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$")


class Parser:
    """Pratt parser over openpyxl's formula tokens. Produces small tuple trees."""

    BIN = {"=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5}

    def __init__(self, formula: str):
        tok = Tokenizer(formula)
        self.t = [x for x in tok.items if x.type != Token.WSPACE]
        self.i = 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self):
        tk = self.peek()
        self.i += 1
        return tk

    def parse(self):
        node = self.expr(0)
        if self.peek() is not None:
            raise Unsupported("syntax")
        return node

    def expr(self, minp):
        left = self.unary()
        while True:
            tk = self.peek()
            if tk is None or tk.type != Token.OP_IN or tk.value not in self.BIN:
                break
            p = self.BIN[tk.value]
            if p < minp:
                break
            self.take()
            right = self.expr(p + 1)
            left = ("bin", tk.value, left, right)
        return left

    def unary(self):
        tk = self.peek()
        if tk is not None and tk.type == Token.OP_PRE:
            self.take()
            return ("un", tk.value, self.unary())
        node = self.primary()
        while self.peek() is not None and self.peek().type == Token.OP_POST:
            self.take()
            node = ("pct", node)
        return node

    def primary(self):
        tk = self.take()
        if tk is None:
            raise Unsupported("syntax")
        if tk.type == Token.PAREN and tk.subtype == Token.OPEN:
            node = self.expr(0)
            close = self.take()
            if close is None or close.type != Token.PAREN:
                raise Unsupported("syntax")
            return node
        if tk.type == Token.FUNC and tk.subtype == Token.OPEN:
            name = tk.value[:-1].upper()
            name = name.replace("_XLFN.", "").replace("_XLWS.", "")
            args = []
            if self.peek() is not None and self.peek().type == Token.FUNC and self.peek().subtype == Token.CLOSE:
                self.take()
                return ("func", name, args)
            while True:
                nxt = self.peek()
                if nxt is not None and nxt.type == Token.SEP:  # empty argument
                    args.append(("blank",))
                else:
                    args.append(self.expr(0))
                nxt = self.take()
                if nxt is None:
                    raise Unsupported("syntax")
                if nxt.type == Token.FUNC and nxt.subtype == Token.CLOSE:
                    break
                if nxt.type != Token.SEP:
                    raise Unsupported("syntax")
            return ("func", name, args)
        if tk.type == Token.OPERAND:
            if tk.subtype == Token.NUMBER:
                return ("num", float(tk.value))
            if tk.subtype == Token.TEXT:
                return ("str", tk.value[1:-1].replace('""', '"'))
            if tk.subtype == Token.LOGICAL:
                return ("bool", tk.value.upper() == "TRUE")
            if tk.subtype == Token.ERROR:
                return ("err", XlError(tk.value))
            if tk.subtype == Token.RANGE:
                return ("ref", tk.value)
        raise Unsupported("syntax")


def _unquote(sheet_q, sheet_p):
    if sheet_q is not None:
        return sheet_q.replace("''", "'")
    return sheet_p


def parse_ref(text: str, default_sheet: str):
    """'Sheet 1'!$A$1:B3 -> (sheet, r1, c1, r2, c2) or None."""
    m = _REF.match(text)
    if m:
        sheet = _unquote(m.group(1), m.group(2)) or default_sheet
        c1, r1 = column_index_from_string(m.group(3).upper()), int(m.group(4))
        if m.group(5):
            c2, r2 = column_index_from_string(m.group(5).upper()), int(m.group(6))
        else:
            c2, r2 = c1, r1
        return sheet, min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)
    m = _COLREF.match(text)
    if m:
        sheet = _unquote(m.group(1), m.group(2)) or default_sheet
        c1, c2 = column_index_from_string(m.group(3).upper()), column_index_from_string(m.group(4).upper())
        return sheet, 1, min(c1, c2), None, max(c1, c2)
    return None


def _round_half_up(x: float, digits: int, mode=ROUND_HALF_UP) -> float:
    d = Decimal(repr(x))
    q = Decimal(1).scaleb(-digits)
    return float(d.quantize(q, rounding=mode))


class Engine:
    def __init__(self, wb):
        self.wb = wb
        self.cells = {}      # (sheet, row, col) -> raw value
        self.formulas = {}   # (sheet, row, col) -> formula text
        self.arrays = set()
        self.max_row = {}
        self.max_col = {}
        for ws in wb.worksheets:
            self.max_row[ws.title] = ws.max_row
            self.max_col[ws.title] = ws.max_column
            for row in ws.iter_rows():
                for c in row:
                    v = c.value
                    if v is None:
                        continue
                    key = (ws.title, c.row, c.column)
                    if hasattr(v, "text") and hasattr(v, "ref"):  # ArrayFormula
                        self.arrays.add(key)
                        self.formulas[key] = v.text
                    elif isinstance(v, str) and v.startswith("=") and len(v) > 1:
                        self.formulas[key] = v
                    else:
                        self.cells[key] = v
        self.lower_sheets = {n.lower(): n for n in wb.sheetnames}
        self.memo = {}
        self.stack = set()
        self.settling = False
        self.ast = {}
        self.names = {}
        try:
            for name, dn in wb.defined_names.items():
                self.names[name.upper()] = dn.attr_text
        except Exception:
            pass

    # -- values --
    def value_of(self, key):
        if key in self.memo:
            res = self.memo[key]
            if isinstance(res, Unsupported):
                raise res
            return res
        if key in self.formulas:
            if key in self.arrays:
                err = Unsupported("array formula")
                self.memo[key] = err
                raise err
            if key in self.stack:
                return XlError("#REF!")  # circular reference
            self._settle(key)
            if key in self.memo:
                res = self.memo[key]
                if isinstance(res, Unsupported):
                    raise res
                return res
            return self._compute(key)
        v = self.cells.get(key)
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, (_dt.datetime, _dt.date)):
            return float(to_excel(v))
        if isinstance(v, _dt.time):
            return (v.hour * 3600 + v.minute * 60 + v.second) / 86400
        if isinstance(v, str) and v in ERRORS:
            return XlError(v)
        return v

    def _compute(self, key):
        self.stack.add(key)
        try:
            try:
                node = self.ast.get(key)
                if node is None:
                    node = Parser(self.formulas[key]).parse()
                    self.ast[key] = node
                res = self.ev(node, key[0])
                if isinstance(res, Rng):
                    raise Unsupported("array result")
                if res is None:
                    res = 0.0
            except Unsupported as exc:
                self.memo[key] = exc
                raise
            except RecursionError:
                exc = Unsupported("deep chain")
                self.memo[key] = exc
                raise exc
        finally:
            self.stack.discard(key)
        self.memo[key] = res
        return res

    def _settle(self, root):
        """Evaluate every formula `root` reads, the ones furthest away first, with a work list of our own.

        A chain of formulas (A2 reads A1, A3 reads A2, ...) is then never walked by nested calls, so the
        Python call stack stays shallow however long the chain is and no stack setting is needed."""
        if self.settling:
            return          # already inside a settle: a cycle or a name found late; the plain call is shallow
        self.settling = True
        try:
            path = [(root, self._deps(root))]
            on_path = {root}
            while path:
                key, deps = path[-1]
                for dep in deps:
                    if dep in on_path and dep not in self.memo:
                        # dep is on the way down from root and reads its way back to itself: a cycle of
                        # any length. Every cell from dep to here is part of it (Excel: circular reference).
                        keys = [k for k, _ in path]
                        for member in keys[keys.index(dep):]:
                            self.memo[member] = XlError("#REF!")
                        continue
                    if dep not in self.memo and dep not in on_path and dep not in self.arrays:
                        path.append((dep, self._deps(dep)))
                        on_path.add(dep)
                        break
                else:
                    path.pop()
                    on_path.discard(key)
                    if key is not root and key not in self.memo:
                        try:
                            self._compute(key)
                        except Unsupported:
                            pass        # kept in memo; whoever reads it gets the same answer
        finally:
            self.settling = False

    def _deps(self, key):
        """The formula cells the formula in `key` reads (what value_of would go and fetch for it)."""
        node = self.ast.get(key)
        if node is None:
            try:
                node = Parser(self.formulas[key]).parse()
            except Unsupported:
                return
            self.ast[key] = node
        for text in _refs(node):
            pr = self._target(text, key[0])
            if pr is None:
                continue
            s, r1, c1, r2, c2 = pr
            if s not in self.wb.sheetnames:
                continue
            if r2 is None:
                r2 = self.max_row[s]
            r2 = min(r2, max(self.max_row[s], r1))
            c2 = min(c2, max(self.max_col[s], c1))
            for r in range(r1, r2 + 1):
                for c in range(c1, c2 + 1):
                    if (s, r, c) in self.formulas:
                        yield (s, r, c)

    def _target(self, text, sheet):
        """A reference or defined name as (sheet, r1, c1, r2, c2) with the sheet spelled as in the file, else None."""
        pr = parse_ref(text, sheet)
        if pr is None:
            name = text.upper()
            if name in self.names:
                pr = parse_ref(self.names[name].replace("$", ""), sheet)
            if pr is None:
                return None
        s, r1, c1, r2, c2 = pr
        return self.lower_sheets.get(s.lower(), s), r1, c1, r2, c2   # sheet names are case-insensitive in Excel

    def block(self, sheet, r1, c1, r2, c2):
        if sheet not in self.wb.sheetnames:
            return XlError("#REF!")
        if r2 is None:
            r2 = self.max_row[sheet]
        r2 = min(r2, max(self.max_row[sheet], r1))
        c2 = min(c2, max(self.max_col[sheet], c1))
        return Rng([[self.value_of((sheet, r, c)) for c in range(c1, c2 + 1)] for r in range(r1, r2 + 1)])

    # -- evaluation --
    def ev(self, n, sheet):
        k = n[0]
        if k == "num" or k == "str" or k == "bool" or k == "err":
            return n[1]
        if k == "blank":
            return None
        if k == "ref":
            text = n[1]
            pr = self._target(text, sheet)
            if pr is None:
                raise Unsupported("name " + text)
            s, r1, c1, r2, c2 = pr
            if s not in self.wb.sheetnames:
                return XlError("#REF!")
            if r1 == r2 and c1 == c2 and r2 is not None:
                return self.value_of((s, r1, c1))
            return self.block(s, r1, c1, r2, c2)
        if k == "un":
            v = self.ev(n[2], sheet)
            if n[1] == "-":
                return self.map1(v, lambda x: -self.num(x))
            return v
        if k == "pct":
            return self.map1(self.ev(n[1], sheet), lambda x: self.num(x) / 100.0)
        if k == "bin":
            return self.binop(n[1], self.ev(n[2], sheet), self.ev(n[3], sheet))
        if k == "func":
            return self.call(n[1], n[2], sheet)
        raise Unsupported("syntax")

    @staticmethod
    def num(x):
        if isinstance(x, XlError):
            raise _Err(x)
        if x is None:
            return 0.0
        if isinstance(x, bool):
            return 1.0 if x else 0.0
        if isinstance(x, (int, float)):
            return float(x)
        if isinstance(x, str):
            value = text_number(x)
            if value is None:
                raise _Err(XlError("#VALUE!"))
            return value
        raise _Err(XlError("#VALUE!"))

    def map1(self, v, fn):
        if isinstance(v, Rng):
            return Rng([[self._safe(fn, x) for x in row] for row in v.rows])
        return self._safe(fn, v)

    @staticmethod
    def _safe(fn, x):
        try:
            return fn(x)
        except _Err as e:
            return e.err
        except ZeroDivisionError:
            return XlError("#DIV/0!")

    def binop(self, op, a, b):
        if isinstance(a, Rng) or isinstance(b, Rng):
            return self.broadcast(op, a, b)
        return self._safe(lambda _: self.scalar_op(op, a, b), None)

    def broadcast(self, op, a, b):
        ra = a.rows if isinstance(a, Rng) else None
        rb = b.rows if isinstance(b, Rng) else None
        rows = len(ra) if ra else len(rb)
        cols = len(ra[0]) if ra else len(rb[0])
        if ra and rb and (len(ra) != len(rb) or len(ra[0]) != len(rb[0])):
            raise Unsupported("array shapes")
        out = []
        for i in range(rows):
            row = []
            for j in range(cols):
                x = ra[i][j] if ra else a
                y = rb[i][j] if rb else b
                row.append(self._safe(lambda _: self.scalar_op(op, x, y), None))
            out.append(row)
        return Rng(out)

    def scalar_op(self, op, a, b):
        if isinstance(a, XlError):
            return a
        if isinstance(b, XlError):
            return b
        if op == "&":
            return self.text(a) + self.text(b)
        if op in ("+", "-", "*", "/", "^"):
            x, y = self.num(a), self.num(b)
            if op == "+":
                return x + y
            if op == "-":
                return x - y
            if op == "*":
                return x * y
            if op == "/":
                if y == 0:
                    return XlError("#DIV/0!")
                return x / y
            try:
                r = x ** y
                if isinstance(r, complex):
                    return XlError("#NUM!")
                return r
            except ZeroDivisionError:
                return XlError("#DIV/0!")
            except OverflowError:
                return XlError("#NUM!")
        return self.compare(op, a, b)

    @staticmethod
    def text(x):
        if x is None:
            return ""
        if isinstance(x, bool):
            return "TRUE" if x else "FALSE"
        if isinstance(x, float):
            if x == int(x) and abs(x) < 1e15:
                return str(int(x))
            shown = f"{x:.15g}"          # Excel joins numbers with up to 15 significant digits
            if "e" in shown or "inf" in shown or "nan" in shown:
                raise Unsupported("number joined into text")
            return shown
        return str(x)

    @staticmethod
    def _rank(x):
        if isinstance(x, bool):
            return 2
        if isinstance(x, str):
            return 1
        return 0

    def compare(self, op, a, b):
        if a is None:
            a = "" if isinstance(b, str) else 0.0
        if b is None:
            b = "" if isinstance(a, str) else 0.0
        ra, rb = self._rank(a), self._rank(b)
        if ra != rb:
            c = (ra > rb) - (ra < rb)
        else:
            x = a.lower() if isinstance(a, str) else a
            y = b.lower() if isinstance(b, str) else b
            c = (x > y) - (x < y)
        return {"=": c == 0, "<>": c != 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0}[op]

    # -- functions --
    def nums_in(self, args, sheet, direct_text_is_error=True):
        out = []
        for a in args:
            v = self.ev(a, sheet)
            if isinstance(v, Rng):
                for x in v.flat():
                    if isinstance(x, XlError):
                        raise _Err(x)
                    if isinstance(x, (int, float)) and not isinstance(x, bool):
                        out.append(float(x))
            else:
                if v is None:
                    continue
                if isinstance(v, XlError):
                    raise _Err(v)
                if a[0] == "ref":
                    # a reference to one cell is read like a range: text and TRUE/FALSE in it are ignored
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        out.append(float(v))
                    continue
                out.append(self.num(v))
        return out

    def call(self, name, args, sheet):
        try:
            return self._call(name, args, sheet)
        except _Err as e:
            return e.err
        except ZeroDivisionError:
            return XlError("#DIV/0!")

    def _call(self, name, args, sheet):
        ev = lambda i: self.ev(args[i], sheet)  # noqa: E731
        if name == "SUM":
            return math.fsum(self.nums_in(args, sheet))
        if name == "AVERAGE":
            v = self.nums_in(args, sheet)
            return XlError("#DIV/0!") if not v else math.fsum(v) / len(v)
        if name == "MIN":
            v = self.nums_in(args, sheet)
            return min(v) if v else 0.0
        if name == "MAX":
            v = self.nums_in(args, sheet)
            return max(v) if v else 0.0
        if name == "COUNT":
            n = 0
            for a in args:
                v = self.ev(a, sheet)
                if isinstance(v, Rng) or a[0] == "ref":
                    items = v.flat() if isinstance(v, Rng) else [v]
                    n += sum(1 for x in items if isinstance(x, (int, float)) and not isinstance(x, bool))
                elif isinstance(v, bool) or isinstance(v, (int, float)):
                    n += 1       # typed straight into the formula, TRUE counts
                elif isinstance(v, str) and text_number(v) is not None:
                    n += 1       # a number typed as text in the formula itself counts (in a cell it does not)
            return float(n)
        if name == "COUNTA":
            n = 0
            for a in args:
                v = self.ev(a, sheet)
                items = v.flat() if isinstance(v, Rng) else [v]
                n += sum(1 for x in items if x is not None)   # a formula returning "" still counts
            return float(n)
        if name == "COUNTBLANK":
            v = ev(0)
            return float(sum(1 for x in (v.flat() if isinstance(v, Rng) else [v]) if x is None or x == ""))
        if name in ("TRUE", "FALSE") and not args:
            return name == "TRUE"
        if name == "ABS":
            return abs(self.num(ev(0)))
        if name == "INT":
            return float(math.floor(self.num(ev(0))))
        if name == "SQRT":
            x = self.num(ev(0))
            return XlError("#NUM!") if x < 0 else math.sqrt(x)
        if name == "POWER":
            return self.scalar_op("^", ev(0), ev(1))
        if name == "MOD":
            x, y = self.num(ev(0)), self.num(ev(1))
            return XlError("#DIV/0!") if y == 0 else x - y * math.floor(x / y)
        if name in ("ROUND", "ROUNDUP", "ROUNDDOWN"):
            x, d = self.num(ev(0)), int(self.num(ev(1)))
            if name == "ROUND":
                return _round_half_up(x, d)
            from decimal import ROUND_DOWN, ROUND_UP
            return _round_half_up(x, d, ROUND_UP if name == "ROUNDUP" else ROUND_DOWN)
        if name == "IF":
            cond = ev(0)
            if isinstance(cond, XlError):
                return cond
            truth = self.truth(cond)
            if truth:
                return self.ev(args[1], sheet) if len(args) > 1 else True
            return self.ev(args[2], sheet) if len(args) > 2 else False
        if name == "IFERROR":
            v = self.ev(args[0], sheet)
            if isinstance(v, XlError):
                return self.ev(args[1], sheet)
            return v
        if name in ("AND", "OR"):
            vals = self.logic_values(args, sheet)
            if not vals:
                return XlError("#VALUE!")
            return all(vals) if name == "AND" else any(vals)
        if name == "NOT":
            return not self.truth(ev(0))
        if name in ("CONCATENATE", "CONCAT"):
            return "".join(self.text(x) for x in self.flatten(args, sheet, keep_blank=True))
        if name == "LEN":
            return float(len(self.text(ev(0))))
        if name in ("LEFT", "RIGHT"):
            n = int(self.num(ev(1))) if len(args) > 1 else 1
            if n < 0:
                return XlError("#VALUE!")
            text = self.text(ev(0))
            if name == "LEFT":
                return text[:n]
            return text[-n:] if n else ""
        if name == "MID":
            s, a, n = self.text(ev(0)), int(self.num(ev(1))), int(self.num(ev(2)))
            if a < 1 or n < 0:
                return XlError("#VALUE!")
            return s[a - 1: a - 1 + n]
        if name in ("SUMIF", "COUNTIF", "AVERAGEIF"):
            rng = ev(0)
            crit = ev(1)
            if not isinstance(rng, Rng):
                rng = Rng([[rng]])
            tot = rng if name == "COUNTIF" or len(args) < 3 else ev(2)
            if not isinstance(tot, Rng):
                tot = Rng([[tot]])
            if tot.shape != rng.shape:
                raise Unsupported("sum range of another size")
            return self.cond_agg(name, [(rng, crit)], tot)
        if name in ("SUMIFS", "COUNTIFS", "AVERAGEIFS"):
            if name == "COUNTIFS":
                pairs = [(ev(i), ev(i + 1)) for i in range(0, len(args), 2)]
                return self.cond_agg("COUNTIFS", pairs, pairs[0][0])
            pairs = [(ev(i), ev(i + 1)) for i in range(1, len(args), 2)]
            total = ev(0)
            if not isinstance(total, Rng) or total.shape != (pairs[0][0].shape if isinstance(pairs[0][0], Rng) else None):
                raise Unsupported("sum range of another size")
            return self.cond_agg(name, pairs, total)
        if name == "SUMPRODUCT":
            arrs = [self.ev(a, sheet) for a in args]
            arrs = [a if isinstance(a, Rng) else Rng([[a]]) for a in arrs]
            shape = arrs[0].shape
            if any(a.shape != shape for a in arrs):
                return XlError("#VALUE!")
            total = 0.0
            for pos in zip(*[list(a.flat()) for a in arrs]):
                p = 1.0
                for x in pos:
                    if isinstance(x, XlError):
                        return x
                    p *= float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else 0.0
                total += p
            return total
        if name == "VLOOKUP":
            val, tbl, col = ev(0), ev(1), int(self.num(ev(2)))
            approx = True if len(args) < 4 else bool(self.num(ev(3)) != 0) if not isinstance(ev(3), bool) else ev(3)
            if isinstance(val, XlError):
                return val
            if not isinstance(tbl, Rng):
                raise Unsupported("VLOOKUP table")
            if col < 1 or col > tbl.shape[1]:
                return XlError("#REF!")
            if isinstance(val, str) and re.search(r"[*?~]", val) and not approx:
                raise Unsupported("wildcard lookup")
            if approx:
                self._need_sorted([row[0] for row in tbl.rows])
            best = None
            for row in tbl.rows:
                key = row[0]
                if isinstance(key, XlError):
                    continue
                if not approx:
                    if key is not None and self.compare("=", key, val):
                        return row[col - 1]
                elif key is not None and self._rank(key) == self._rank(val) and self.compare("<=", key, val):
                    best = row
            if approx and best is not None:
                return best[col - 1]
            return XlError("#N/A")
        if name == "INDEX":
            rng = ev(0)
            r = int(self.num(ev(1))) if len(args) > 1 else 1
            c = int(self.num(ev(2))) if len(args) > 2 else 1
            if r == 0 or c == 0:
                raise Unsupported("INDEX with row/column 0")
            if not isinstance(rng, Rng):
                return rng
            rows, cols = rng.shape
            if rows == 1 and len(args) == 2:
                r, c = 1, r
            if r < 1 or c < 1 or r > rows or c > cols:
                return XlError("#REF!")
            return rng.rows[r - 1][c - 1]
        if name == "MATCH":
            val, rng = ev(0), ev(1)
            mt = int(self.num(ev(2))) if len(args) > 2 else 1
            if not isinstance(rng, Rng):
                rng = Rng([[rng]])
            items = list(rng.flat())
            if mt == 0 and isinstance(val, str) and re.search(r"[*?~]", val):
                raise Unsupported("wildcard lookup")
            if mt != 0:
                self._need_sorted(items, descending=mt < 0)
            if mt == 0:
                for i, x in enumerate(items):
                    if x is not None and not isinstance(x, XlError) and self.compare("=", x, val):
                        return float(i + 1)
                return XlError("#N/A")
            hit = None
            for i, x in enumerate(items):
                if x is None or isinstance(x, XlError) or self._rank(x) != self._rank(val):
                    continue
                if (mt > 0 and self.compare("<=", x, val)) or (mt < 0 and self.compare(">=", x, val)):
                    hit = i
            return float(hit + 1) if hit is not None else XlError("#N/A")
        raise Unsupported(name)

    def _need_sorted(self, keys, descending=False):
        """Approximate matching only means something on sorted keys; Excel's result on others is an accident."""
        seq = [k for k in keys if k is not None and not isinstance(k, XlError)]
        for a, b in zip(seq, seq[1:]):
            if self._rank(a) != self._rank(b):
                raise Unsupported("approximate lookup on unsorted keys")
            bad = self.compare("<", a, b) if descending else self.compare(">", a, b)
            if bad:
                raise Unsupported("approximate lookup on unsorted keys")

    def truth(self, v):
        """A condition the way IF/NOT read it: TRUE/FALSE, a number, or the text "TRUE"/"FALSE"."""
        if isinstance(v, bool):
            return v
        if isinstance(v, str) and v.strip().upper() in ("TRUE", "FALSE"):
            return v.strip().upper() == "TRUE"
        return self.num(v) != 0

    def logic_values(self, args, sheet):
        """AND/OR arguments: text and blanks inside a range or a cell reference are ignored; typed text must be
        TRUE/FALSE or a number."""
        out = []
        for a in args:
            v = self.ev(a, sheet)
            if isinstance(v, Rng) or a[0] == "ref":
                for x in (v.flat() if isinstance(v, Rng) else [v]):
                    if isinstance(x, XlError):
                        raise _Err(x)
                    if isinstance(x, bool):
                        out.append(x)
                    elif isinstance(x, (int, float)):
                        out.append(x != 0)
            elif v is not None:
                out.append(self.truth(v))
        return out

    def flatten(self, args, sheet, keep_blank=False):
        out = []
        for a in args:
            v = self.ev(a, sheet)
            items = list(v.flat()) if isinstance(v, Rng) else [v]
            for x in items:
                if isinstance(x, XlError):
                    raise _Err(x)
                if x is None and not keep_blank:
                    continue
                out.append(x)
        return out

    def matches(self, crit):
        if isinstance(crit, XlError):
            raise _Err(crit)
        op, rhs = "=", crit
        if isinstance(crit, str):
            m = re.match(r"^(<=|>=|<>|=|<|>)(.*)$", crit)
            if m:
                op, rhs = m.group(1), m.group(2)
            if "~" in rhs or re.match(r"^\s*\d{1,4}[-/.年]\d{1,2}([-/.月]\d{1,2})?", rhs):
                raise Unsupported("criteria with ~ or a date written as text")
            if rhs.strip().upper() in ("TRUE", "FALSE"):
                rhs = rhs.strip().upper() == "TRUE"
            else:
                try:
                    number = text_number(rhs) if rhs.strip() else None
                except Unsupported:
                    raise
                if number is not None:
                    rhs = number
        if isinstance(rhs, str) and ("*" in rhs or "?" in rhs) and op in ("=", "<>"):
            rx = re.compile("^" + re.escape(rhs).replace(r"\*", ".*").replace(r"\?", ".") + "$", re.I)
            return lambda x: (isinstance(x, str) and bool(rx.match(x))) == (op == "=")

        def test(x):
            if isinstance(x, XlError):
                return False
            if x is None:
                return op == "<>" if rhs not in ("",) else op == "="
            if isinstance(rhs, float) and isinstance(x, str):
                return op == "<>"
            if isinstance(rhs, str) and not isinstance(x, str):
                return op == "<>"
            if isinstance(x, bool) != isinstance(rhs, bool):
                return op == "<>"
            return self.compare(op, x, rhs)
        return test

    def cond_agg(self, name, pairs, tot):
        shape = pairs[0][0].shape
        tests = []
        for rng, crit in pairs:
            if rng.shape != shape:
                return XlError("#VALUE!")
            tests.append((list(rng.flat()), self.matches(crit)))
        values = list(tot.flat()) if isinstance(tot, Rng) else []
        hit = [i for i in range(shape[0] * shape[1]) if all(t(items[i]) for items, t in tests)]
        if name in ("COUNTIF", "COUNTIFS"):
            return float(len(hit))
        nums = [values[i] for i in hit if i < len(values) and isinstance(values[i], (int, float)) and not isinstance(values[i], bool)]
        if name in ("SUMIF", "SUMIFS"):
            return math.fsum(nums)
        return XlError("#DIV/0!") if not nums else math.fsum(nums) / len(nums)


_PLAIN_NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?%?$")
_GROUPED_NUMBER = re.compile(r"^[+-]?\d{1,3}(,\d{3})+(\.\d*)?%?$")


def text_number(text):
    """Excel's reading of a text as a number, only for the plain forms: 12, -1.5, .5, 1e3, 1,234.5, 5%.
    Returns None for a text with no digit (Excel: #VALUE!) and raises Unsupported for anything else that holds a
    digit (a date, a time, a currency, 1_000 ...), because Excel may read those and this script does not."""
    t = text.strip()
    if _PLAIN_NUMBER.match(t) or _GROUPED_NUMBER.match(t):
        pct = t.endswith("%")
        return float(t.rstrip("%").replace(",", "")) / (100.0 if pct else 1.0)
    if re.search(r"\d", t) or t.lower() in ("inf", "nan", "infinity"):
        raise Unsupported("text that may be read as a number, date or time")
    return None


class _Err(Exception):
    def __init__(self, err):
        super().__init__(str(err))
        self.err = err


# ───────────────────────────── checks ─────────────────────────────

def cell_name(sheet, r, c):
    return f"{sheet}!{get_column_letter(c)}{r}"


def translate(formula, origin, target):
    try:
        return re.sub(r"\s+", "", Translator(formula, origin=origin).translate_formula(target)).upper()
    except Exception:
        return None


def col_width(ws, col):
    for dim in ws.column_dimensions.values():
        lo, hi = dim.min or 0, dim.max or 0
        if lo <= col <= hi and dim.width:
            return float(dim.width), True
    return float(ws.sheet_format.defaultColWidth or 8.43), False


def shown_length(value, fmt):
    """Rough number of characters Excel needs to show a number or date with this format."""
    fmt = (fmt or "General").split(";")[0]
    if isinstance(value, float) and not math.isfinite(value):
        return 0
    bare = re.sub(r"\[[^\]]*\]|_.|\\.|\"[^\"]*\"", "", fmt)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and re.search(r"[hms]", bare, re.I) and not re.search(r"[0#?]", bare):
        # a time or duration such as [h]:mm: the hours may exceed 24, so count their digits
        hours = len(str(int(abs(value) * 24))) if "[h" in fmt.lower() else 2
        return hours + len(re.sub(r"[hH]+", "", bare)) + 1
    if isinstance(value, (_dt.datetime, _dt.date)):
        f = re.sub(r"\[[^\]]*\]|_.|\\.", "", fmt)
        f = re.sub(r"\"([^\"]*)\"", r"\1", f)
        if not re.search(r"[ymdhs]", f, re.I):
            return 10
        f = re.sub(r"y{3,}", "0000", f, flags=re.I)
        f = re.sub(r"[ymdhs]+", "00", f, flags=re.I)
        return len(f)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return 0
    if fmt == "General":
        return len(str(int(abs(value)))) + (1 if value < 0 else 0)
    pct = "%" in fmt
    v = abs(value) * (100 if pct else 1)
    decimals = len(re.match(r"[0#?]*", fmt.split(".")[1]).group()) if "." in fmt else 0
    body = f"{v:,.{decimals}f}" if "," in fmt else f"{v:.{decimals}f}"
    literal = re.sub(r"[0#?,.%_\\*]", "", re.sub(r"\[[^\]]*\]", "", fmt))
    return len(body) + (1 if value < 0 else 0) + (1 if pct else 0) + min(len(literal.replace('"', "")), 4)


def sum_args(node):
    """For a formula that is just SUM(one 1-D same-sheet range) return that ref text, else None."""
    if node[0] == "func" and node[1] == "SUM" and len(node[2]) == 1 and node[2][0][0] == "ref":
        return node[2][0][1]
    return None


def run_checks(path, want_values=False):
    issues = []   # (level, where, message)

    def add(level, where, msg):
        issues.append((level, where, msg))

    try:
        wb = load_workbook(path)
    except Exception as exc:
        print(f"[错误] 文件打不开: {exc}")
        return 1
    try:
        wbv = load_workbook(path, data_only=True)
    except Exception:
        wbv = None

    names = wb.sheetnames
    with zipfile.ZipFile(path) as zf:
        parts = zf.namelist()
        chart_xml = {n: zf.read(n) for n in parts if re.match(r"xl/charts/chart\d+\.xml$", n)}
        has_external = any(n.startswith("xl/externalLinks/") for n in parts)
        has_pivot = any(n.startswith("xl/pivotTables/") or n.startswith("xl/pivotCache/") for n in parts)
        has_slicer = any(n.startswith("xl/slicers/") or n.startswith("xl/slicerCaches/") for n in parts)
    if has_external:
        add("错误", "文件", "含有指向其他文件的外部链接(公式里的 [1]);对方电脑上没有那个文件,数据会丢或报错。把引用的数值直接粘进来。")

    if has_pivot or has_slicer:
        what = "数据透视表" if has_pivot else "切片器"
        add("注意", "文件", f"文件里有{what}{'和切片器' if has_pivot and has_slicer else ''}。用 openpyxl 打开再保存会把它们丢掉(或变成静态内容);请只改一份副本,或换一种不经过 openpyxl 的改法,并告诉用户。")

    eng = Engine(wb)
    n_cells = len(eng.cells) + len(eng.formulas)
    n_formulas = len(eng.formulas)
    computed, unverified = {}, {}

    if n_cells <= MAX_CELLS_TO_EVALUATE:
        for key in sorted(eng.formulas, key=lambda k: (k[0], k[1], k[2])):
            try:
                computed[key] = eng.value_of(key)
            except Unsupported as exc:
                unverified[key] = str(exc)
            except Exception as exc:  # engine bug: never let it hide the other checks
                unverified[key] = f"engine: {exc.__class__.__name__}"
    else:
        for key in eng.formulas:
            unverified[key] = "too large"

    # errors: cached or computed
    for key, f in eng.formulas.items():
        where = cell_name(*key)
        if "#REF!" in f.upper():
            add("错误", where, f"公式里含 #REF!(引用的单元格或表被删了): {f}")
        if re.search(r"\[\d+\]", f):
            add("错误", where, f"公式引用了其他文件: {f}")
        node = None
        try:
            node = Parser(f).parse()
        except Unsupported:
            pass
        if node is not None:
            for sheet_ref in _refs(node):
                pr = parse_ref(sheet_ref, key[0])
                if pr and pr[0].lower() not in eng.lower_sheets:
                    add("错误", where, f"公式引用了不存在的工作表「{pr[0]}」: {f}")
        v = computed.get(key)
        cv = wbv[key[0]].cell(row=key[1], column=key[2]).value if wbv is not None else None
        if isinstance(cv, str) and cv in ERRORS:
            # a result saved by Excel/WPS/LibreOffice themselves: certain
            add("错误", where, f"文件里保存的计算结果是 {cv}: {f}")
        elif isinstance(v, XlError):
            if not any(i[1] == where for i in issues):
                add("提示", where, f"按本机估算这格会显示 {v}(只是估算,以 Excel/WPS 里的结果为准): {f}")

    # totals that stop short
    for key, f in eng.formulas.items():
        try:
            node = Parser(f).parse()
        except Unsupported:
            continue
        ref = sum_args(node)
        if not ref:
            continue
        pr = parse_ref(ref, key[0])
        if not pr or pr[0] != key[0] or pr[3] is None:
            continue
        _s, r1, c1, r2, c2 = pr
        sheet, r, c = key
        if c1 == c2 == c and r2 < r:
            gap = [rr for rr in range(r2 + 1, r) if _is_data(eng, sheet, rr, c)]
            if gap:
                add("错误", cell_name(*key), f"合计只到第 {r2} 行,下面第 {gap[0]}{'-' + str(gap[-1]) if gap[-1] != gap[0] else ''} 行还有数据没算进去: {f}")
            above = r1 - 1
            if above >= 1 and isinstance(eng.cells.get((sheet, above, c)), (int, float)) and not isinstance(eng.cells.get((sheet, above, c)), bool) and (sheet, above, c) not in eng.formulas:
                if not (1900 <= eng.cells[(sheet, above, c)] <= 2100 and float(eng.cells[(sheet, above, c)]).is_integer()):
                    add("提示", cell_name(*key), f"合计从第 {r1} 行开始,上一行 {get_column_letter(c)}{above} 也是数字,没被算进去;若那是表头(如年份)就没问题,请自己判断: {f}")
        elif r1 == r2 == r and c2 < c:
            gap = [cc for cc in range(c2 + 1, c) if _is_data(eng, sheet, r, cc)]
            if gap:
                add("错误", cell_name(*key), f"合计只到 {get_column_letter(c2)} 列,右边 {get_column_letter(gap[0])}-{get_column_letter(gap[-1])} 列还有数据没算进去: {f}")

    # inconsistent formulas / typed numbers among formulas
    flagged = set()
    pattern_hints = {}   # one hint per row (cells compared up/down) or per column (left/right), not one per cell

    def pattern_hint(key, label, text):
        pattern_hints.setdefault((key[0], label, key[1] if label == "上下" else key[2]), []).append((key, text))

    def follows_other_axis(key, mine, dr):
        """True when the cell agrees with its formula neighbours on the other axis: a whole row (or column) built
        from one formula shape, such as a subtotal or total row between data rows, is not an odd cell per cell."""
        sheet, r, c = key
        here = f"{get_column_letter(c)}{r}"
        steps = ((0, 1), (0, -1)) if dr else ((1, 0), (-1, 0))     # the axis that was not compared
        seen = [(sheet, r + sr, c + sc) for sr, sc in steps if (sheet, r + sr, c + sc) in eng.formulas]
        if not seen:
            return False
        return all(translate(eng.formulas[n], f"{get_column_letter(n[2])}{n[1]}", here) == mine for n in seen)

    for key, f in eng.formulas.items():
        sheet, r, c = key
        here = f"{get_column_letter(c)}{r}"
        for dr, dc, label in ((1, 0, "上下"), (0, 1, "左右")):
            a, b = (sheet, r - dr, c - dc), (sheet, r + dr, c + dc)
            if a in eng.formulas and b in eng.formulas:
                ta = translate(eng.formulas[a], f"{get_column_letter(a[2])}{a[1]}", here)
                tb = translate(eng.formulas[b], f"{get_column_letter(b[2])}{b[1]}", here)
                mine = re.sub(r"\s+", "", f).upper()
                if ta and ta == tb and ta != mine and key not in flagged and not follows_other_axis(key, mine, dr):
                    flagged.add(key)
                    pattern_hint(key, label, f"这格的公式和{label}两格的规律不一样: 这里是 {f},按规律是 {ta};小计行等有意不同的写法是正常的,请自己判断,不要仅凭这条改公式")
    for key, v in eng.cells.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            sheet, r, c = key
            here = f"{get_column_letter(c)}{r}"
            for dr, dc, label in ((1, 0, "上下"), (0, 1, "左右")):
                a, b = (sheet, r - dr, c - dc), (sheet, r + dr, c + dc)
                if a in eng.formulas and b in eng.formulas:
                    ta = translate(eng.formulas[a], f"{get_column_letter(a[2])}{a[1]}", here)
                    tb = translate(eng.formulas[b], f"{get_column_letter(b[2])}{b[1]}", here)
                    if ta and ta == tb:
                        pattern_hint(key, label, f"这格是手填的数字 {v:g},但{label}两格都是公式(按规律是 {ta});若是有意的输入值就没问题,请自己判断")
                        break
    for group in pattern_hints.values():
        first_key, text = group[0]
        if len(group) > 1:
            others = ", ".join(cell_name(*k) for k, _t in group[1:6]) + (" 等" if len(group) > 6 else "")
            text += f"(同一行或同一列另有 {len(group) - 1} 格同样情况: {others};多半是同一个原因,合在这一条里)"
        add("提示", cell_name(*first_key), text)

    # numbers stored as text
    numtext = re.compile(r"^\s*[-+]?[\d,]*\.?\d+%?\s*$")
    for ws in wb.worksheets:
        per_col = {}
        for (s, r, c), v in eng.cells.items():
            if s != ws.title:
                continue
            per_col.setdefault(c, []).append((r, v))
        for c, items in per_col.items():
            nums = sum(1 for _r, v in items if isinstance(v, (int, float)) and not isinstance(v, bool))
            texts = [r for r, v in items if isinstance(v, str) and numtext.match(v)]
            if texts and nums >= 2:
                add("注意", f"{ws.title}!{get_column_letter(c)}{texts[0]}", f"这一列其他格是数字,但有 {len(texts)} 格是文本形式的数字(如第 {texts[0]} 行),SUM 不会计入")

    # too narrow columns
    for ws in wb.worksheets:
        seen = set()
        for row in ws.iter_rows():
            for cell in row:
                v = cell.value
                key = (ws.title, cell.row, cell.column)
                if key in eng.formulas:
                    v = computed.get(key) if not isinstance(computed.get(key), XlError) else None
                if isinstance(v, (int, float, _dt.date)) and not isinstance(v, bool):
                    width, _explicit = col_width(ws, cell.column)
                    need = shown_length(v, cell.number_format)
                    if need > width + 0.01 and (cell.column not in seen):
                        seen.add(cell.column)
                        add("注意", f"{ws.title}!{cell.coordinate}", f"列宽 {width:g} 放不下 {need} 个字符,Excel 会显示 ####,请加宽 {get_column_letter(cell.column)} 列")

    # chart references
    for name, xml in chart_xml.items():
        for m in re.finditer(rb"<(?:c:)?f>([^<]+)</(?:c:)?f>", xml):
            ref = m.group(1).decode("utf-8", "replace").replace("&apos;", "'")
            pr = parse_ref(ref.replace("$", ""), names[0])
            if not pr:
                continue
            s, r1, c1, r2, c2 = pr
            if s not in names:
                add("错误", name.split("/")[-1], f"图表引用了不存在的工作表「{s}」")
                continue
            any_data = any(_is_data(eng, s, r, c, strict=False) for r in range(r1, (r2 or r1) + 1) for c in range(c1, c2 + 1))
            if not any_data:
                add("错误", name.split("/")[-1], f"图表的数据区域 {ref} 里是空的,图会是空白")

    # cached values missing
    if n_formulas and wbv is not None:
        cached = [wbv[k[0]].cell(row=k[1], column=k[2]).value for k in eng.formulas]
        missing = sum(1 for v in cached if v is None)
        # xlsxwriter (and some other writers) store 0 for every formula: that is a placeholder, not a result
        if not missing and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0 for v in cached) \
                and (unverified or any(isinstance(v, (int, float)) and v != 0 for v in computed.values())):
            missing = n_formulas
        if missing and missing >= max(1, n_formulas // 2):
            add("提示", "文件", f"{missing}/{n_formulas} 个公式没有保存真正的计算结果(没有值,或全是占位的 0):Excel/WPS 打开时会自己算;预览面板和部分读取工具在此之前会显示空白。如果系统提示里有 Office Engine(LibreOffice),可以用它重新计算一份;没有的话不用处理,交付时告诉用户用 Excel/WPS 打开后才会显示数值。")

    # report
    order = {"错误": 0, "注意": 1, "提示": 2}
    issues.sort(key=lambda x: order[x[0]])
    print(f"文件: {os.path.basename(path)}  工作表 {len(names)} 个: {', '.join(names)}  公式 {n_formulas} 个")
    shown = 0
    for level, where, msg in issues:
        print(f"[{level}] {where}  {msg}")
        shown += 1
        if shown >= 60:
            print(f"... 还有 {len(issues) - shown} 条未列出")
            break
    if not issues:
        print("没有发现问题。")
    if n_formulas:
        ok = len(computed)
        print(f"估算: {ok}/{n_formulas} 个公式在本地做了估算", end="")
        if unverified:
            funcs = sorted({v for v in unverified.values()})
            print(f";{len(unverified)} 个无法在本地验证(涉及: {', '.join(funcs[:8])})。", end="")
        print("\n这些只是提示,不是 Excel 的计算结果,也没有写进文件;真实数值在 Excel/WPS 打开时才有。不要对用户说「公式已全部验证」。")
        totals = [k for k, f in eng.formulas.items() if k in computed and not isinstance(computed[k], XlError) and re.match(r"^=\s*(SUM|AVERAGE)\(", f, re.I)]
        listing = sorted(computed) if want_values else totals[:15]
        if listing:
            print("公式估算值(仅供对照源数据,不保证和 Excel 一致):" if want_values else "合计类公式估算值(仅供对照源数据,不保证和 Excel 一致):")
            for k in listing[:200]:
                val = computed[k]
                shown_v = f"{val:.10g}" if isinstance(val, float) else str(val)
                print(f"  {cell_name(*k)} = {shown_v}    {eng.formulas[k]}")
    return 0


def _is_data(eng, sheet, r, c, strict=True):
    key = (sheet, r, c)
    v = eng.cells.get(key)
    if key in eng.formulas:
        f = eng.formulas[key].upper()
        # a subtotal or any other summary row (average, count, min, max ...) between the data and the total is not data
        return not (strict and re.match(r"^=\s*(SUM|SUBTOTAL|AVERAGE|AVERAGEA|COUNT|COUNTA|MIN|MAX|MEDIAN|PRODUCT|STDEV\w*|VAR\w*)\(", f))
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return True
    return (not strict) and v is not None


def _refs(node):
    if node[0] == "ref":
        yield node[1]
    elif node[0] == "func":
        for a in node[2]:
            yield from _refs(a)
    elif node[0] == "bin":
        yield from _refs(node[2])
        yield from _refs(node[3])
    elif node[0] in ("un",):
        yield from _refs(node[2])
    elif node[0] == "pct":
        yield from _refs(node[1])


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Check an .xlsx before delivery")
    ap.add_argument("file")
    ap.add_argument("--values", action="store_true", help="list every value this script estimates")
    a = ap.parse_args()
    if not os.path.isfile(a.file):
        print(f"找不到文件: {a.file}")
        return 2
    return run_checks(a.file, a.values)


if __name__ == "__main__":
    sys.exit(main())
