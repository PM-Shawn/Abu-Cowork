#!/usr/bin/env python3
"""Build an official document (公文) laid out to GB/T 9704-2012 from a JSON description.

    python make_gongwen.py spec.json 通知.docx

spec.json (all keys optional except title and body):
{
  "style": "redhead" | "plain",          # redhead = 红头文件 with 发文机关标志; plain = no red head
  "org": "XX有限公司", "org_suffix": "文件",   # 发文机关标志 (redhead only)
  "number": "XX发〔2025〕12号",           # 发文字号 (use 〔〕)
  "signer": "张三",                       # 签发人 (documents sent to a higher level)
  "copy_no": "000001", "secrecy": "秘密★1年", "urgency": "特急",
  "title": "关于XXXX的通知",
  "addressee": "各部门、各分公司：",
  "body": ["第一段……", "一、……", "（一）……", "1. ……", "（1）……", [["列1","列2"],["a","b"]]],
  "attachments": ["XXXX清单"],           # 附件说明 line(s)
  "sign_org": "XX有限公司", "date": "2025年3月5日", "seal": false,
  "note": "（联系人：张三，电话：XXXX）",   # 附注
  "attachment_pages": [{"label": "附件1", "title": "XXXX清单", "body": ["……", [["a","b"]]]}],
  "cc": "各部门", "issuer": "XX有限公司办公室", "issue_date": "2025年3月5日"   # 版记
}

A body item is a paragraph (heading levels are recognised from 一、 （一） 1. （1）) or a list of rows (a table).
Layout: A4, margins 37/35/28/26 mm (版心 156×225 mm), 3号仿宋_GB2312 body, 22 lines of 28 characters (linesAndChars document grid), 2号方正小标宋
title, 黑体/楷体_GB2312/仿宋_GB2312 headings, 4号宋体 page number "— n —" (odd right, even left). The standard font
names are written into the file; office_env.py reports which are installed on this machine.
"""
from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor

import check_docx
import office_env

FANGSONG = "仿宋_GB2312"
XIAOBIAOSONG = "方正小标宋简体"
HEITI = "黑体"
KAITI = "楷体_GB2312"
SONGTI = "宋体"

LINE = 28.95            # pt: 22 lines fill the 225 mm text height
SIZE = 16               # 3号
TEXT_W_PT = 156 / 25.4 * 72     # 版心 width in points


PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers",
             "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
             "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
             "suppressOverlap", "jc", "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle",
             "rPr", "sectPr", "pPrChange"]
RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss",
             "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs",
             "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
             "specVanish", "oMath"]


def put(parent, child, order):
    """Insert child into parent at the position the schema requires (Word rejects wrong element order)."""
    name = child.tag.split("}")[1]
    rank = order.index(name)
    for existing in parent:
        tag = existing.tag.split("}")[1]
        if tag in order and order.index(tag) > rank:
            existing.addprevious(child)
            return child
    parent.append(child)
    return child


def set_fonts(run, name, size=None, bold=None, color=None):
    rpr = run._r.get_or_add_rPr()
    rf = rpr.get_or_add_rFonts()
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rf.set(qn(attr), name)
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        if rf.get(qn(attr)) is not None:
            del rf.attrib[qn(attr)]
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def fmt(p, align=None, line=LINE, before=0, after=0, left=None, right=None, first_chars=None, first_pt=None, hanging_pt=None):
    pf = p.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    pf.line_spacing = Pt(line)
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if align is not None:
        p.alignment = align
    if left is not None:
        pf.left_indent = Pt(left)
    if right is not None:
        pf.right_indent = Pt(right)
    if first_pt is not None:
        pf.first_line_indent = Pt(first_pt)
    if hanging_pt is not None:
        pf.first_line_indent = Pt(-hanging_pt)
    if first_chars:
        pf.first_line_indent = Pt(SIZE * first_chars / 100)
        p._p.pPr.find(qn("w:ind")).set(qn("w:firstLineChars"), str(first_chars))
    return p


def text_width(s, size=SIZE):
    return sum(size if ord(ch) > 0x2E80 or ch in "—…“”‘’" else size * 0.5 for ch in s)


TITLE_WORDS = ["安全", "生产", "工作", "通知", "检查", "年度", "开展", "加强", "管理", "报告", "请示", "意见", "批复", "会议",
               "纪要", "关于", "进一步", "有关", "事项", "实施", "方案", "办法", "规定", "活动", "培训", "人员", "项目", "建设",
               "公司", "部门", "集团", "单位", "组织", "落实", "做好", "召开", "印发", "转发", "报送", "申请", "任命", "表彰"]


def balance_title(title, size=22):
    """Split a title that is wider than the text area into lines of similar length, breaking at a sensible point."""
    if "\n" in title or text_width(title, size) <= TEXT_W_PT * 0.9:
        return title
    lines = max(2, -(-int(text_width(title, size)) // int(TEXT_W_PT * 0.9)))
    target = len(title) / lines
    out, start = [], 0
    for k in range(1, lines):
        target = round(len(title) * k / lines)
        for delta in (0, 1, -1, 2, -2, 3, -3, 4, -4):
            cut = target + delta
            if cut <= start or cut >= len(title):
                continue
            inside_word = any(title[i:i + len(w)] == w and i < cut < i + len(w)
                              for w in TITLE_WORDS for i in range(max(0, cut - len(w)), cut))
            inside_latin = title[cut - 1].isascii() and title[cut].isascii() and title[cut].isalnum()
            # no line may start with closing punctuation or end with opening punctuation
            bad_punct = title[cut] in "，。、；：！？）》】”’,.;:!?)" or title[cut - 1] in "（《【“‘("
            if not inside_word and not inside_latin and not bad_punct:
                break
        else:
            cut = target
        out.append(title[start:cut])
        start = cut
    out.append(title[start:])
    return "\n".join(out)


def add(doc, text, font=FANGSONG, size=SIZE, **kw):
    p = doc.add_paragraph()
    fmt(p, **kw)
    if text:
        set_fonts(p.add_run(text), font, size)
    return p


def border(p, side, size, color, space=1):
    ppr = p._p.get_or_add_pPr()
    bdr = ppr.find(qn("w:pBdr"))
    if bdr is None:
        bdr = put(ppr, OxmlElement("w:pBdr"), PPR_ORDER)
    el = OxmlElement(f"w:{side}")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(size))
    el.set(qn("w:space"), str(space))
    el.set(qn("w:color"), color)
    bdr.append(el)


def page_field(p, font, size):
    def run_with(child):
        r = p.add_run()
        set_fonts(r, font, size)
        r._r.append(child)
        return r
    run_with(OxmlElement("w:fldChar")).\
        _r.find(qn("w:fldChar")).set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    run_with(instr)
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    run_with(sep)
    r = p.add_run("1")
    set_fonts(r, font, size)
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run_with(end)


def setup_document():
    doc = Document()
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.PORTRAIT
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.top_margin, sec.bottom_margin = Mm(37), Mm(35)
    sec.left_margin, sec.right_margin = Mm(28), Mm(26)
    sec.header_distance = Mm(15)
    sec.footer_distance = Mm(23)
    sec.gutter = 0
    # 22 lines per page from the line grid; 28 characters per line from a slight character spacing (see below)
    grid = sec._sectPr.find(qn("w:docGrid"))
    if grid is None:
        grid = OxmlElement("w:docGrid")
        sec._sectPr.append(grid)
    # 22 lines from the line grid. The 28 characters per line do NOT come from a negative w:charSpace on a
    # linesAndChars grid: LibreOffice reads that as a two-cell pitch (14 characters per line, title and red head
    # wrap). They come from condensing the body font by 0.25 pt (below): 156 mm / (16 - 0.25 pt) = 28.08 characters,
    # which both Word/WPS and LibreOffice lay out the same way.
    grid.set(qn("w:type"), "lines")
    grid.set(qn("w:linePitch"), str(round(LINE * 20)))
    if grid.get(qn("w:charSpace")) is not None:
        del grid.attrib[qn("w:charSpace")]
    # defaults: the grid is measured from the default font size, so make it 3号 仿宋
    styles = doc.styles.element
    defaults = styles.find(qn("w:docDefaults"))
    rpr = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}")
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.insert(0, rf)
    for attr in list(rf.attrib):
        del rf.attrib[attr]
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rf.set(qn(attr), FANGSONG)
    for tag in ("w:sz", "w:szCs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = OxmlElement(tag)
            rpr.append(el)
        el.set(qn("w:val"), str(SIZE * 2))
    lang = rpr.find(qn("w:lang"))
    if lang is None:
        lang = OxmlElement("w:lang")
        rpr.append(lang)
    lang.set(qn("w:val"), "zh-CN")
    lang.set(qn("w:eastAsia"), "zh-CN")
    normal = doc.styles["Normal"]
    normal.font.size = Pt(SIZE)
    nrf = normal.element.get_or_add_rPr().get_or_add_rFonts()
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        nrf.set(qn(attr), FANGSONG)
    wc = OxmlElement("w:widowControl")
    wc.set(qn("w:val"), "0")
    put(normal.element.get_or_add_pPr(), wc, PPR_ORDER)
    # 156 mm / 28 = 15.79 pt per character but 3号 is 16 pt: condense by 0.25 pt so that 28 characters fit a line
    sp = OxmlElement("w:spacing")
    sp.set(qn("w:val"), "-5")
    put(normal.element.get_or_add_rPr(), sp, RPR_ORDER)
    zoom = doc.settings.element.find(qn("w:zoom"))
    if zoom is not None and zoom.get(qn("w:percent")) is None:
        zoom.set(qn("w:percent"), "100")
    # page numbers: odd pages right, even pages left
    doc.settings.odd_and_even_pages_header_footer = True
    for footer, align, left, right in ((sec.footer, WD_ALIGN_PARAGRAPH.RIGHT, 0, 14), (sec.even_page_footer, WD_ALIGN_PARAGRAPH.LEFT, 14, 0)):
        footer.is_linked_to_previous = False
        p = footer.paragraphs[0]
        fmt(p, align=align, line=14, left=left, right=right)
        set_fonts(p.add_run("— "), SONGTI, 14)
        page_field(p, SONGTI, 14)
        set_fonts(p.add_run(" —"), SONGTI, 14)
    return doc


HEAD1 = re.compile(r"^[一二三四五六七八九十]+、")
HEAD2 = re.compile(r"^（[一二三四五六七八九十]+）")
HEAD3 = re.compile(r"^\d+[\.．、]")
HEAD4 = re.compile(r"^（\d+）")


def body_paragraph(doc, text):
    p = doc.add_paragraph()
    fmt(p, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_chars=200)
    for rx, font in ((HEAD1, HEITI), (HEAD2, KAITI)):
        if rx.match(text):
            cut = text.find("。")
            if 0 < cut < len(text) - 1:     # heading followed by body text in the same paragraph
                set_fonts(p.add_run(text[: cut + 1]), font, SIZE)
                set_fonts(p.add_run(text[cut + 1:]), FANGSONG, SIZE)
            else:
                set_fonts(p.add_run(text), font, SIZE)
            return p
    set_fonts(p.add_run(text), FANGSONG, SIZE)
    return p


def body_table(doc, rows):
    cols = max(len(r) for r in rows)
    tbl = doc.add_table(rows=len(rows), cols=cols)
    tbl.style = "Table Grid"
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = False
    total = round(TEXT_W_PT * 20)
    first = tbl._tbl.tblGrid.findall(qn("w:gridCol"))
    for gc in first:
        gc.set(qn("w:w"), str(total // cols))
    for ri, row in enumerate(rows):
        for ci in range(cols):
            cell = tbl.cell(ri, ci)
            cell.width = Pt(TEXT_W_PT / cols)
            p = cell.paragraphs[0]
            fmt(p, align=WD_ALIGN_PARAGRAPH.CENTER, line=22)
            set_fonts(p.add_run(str(row[ci]) if ci < len(row) else ""), HEITI if ri == 0 else FANGSONG, 14)
    return tbl


def add_body(doc, items):
    last = None
    for i, item in enumerate(items):
        if isinstance(item, list):
            last = body_table(doc, item)
            if i < len(items) - 1:
                add(doc, "", before=0)
        else:
            last = body_paragraph(doc, str(item))
    return last


def keep_with_next(block):
    """block is a paragraph or a table: keep it on the same page as what follows."""
    if hasattr(block, "paragraph_format"):
        block.paragraph_format.keep_with_next = True
    elif block is not None:
        for p in block.rows[-1].cells[0].paragraphs + [q for c in block.rows[-1].cells for q in c.paragraphs]:
            p.paragraph_format.keep_with_next = True


def build(spec, out):
    redhead = spec.get("style", "plain") == "redhead"
    doc = setup_document()
    # first paragraph of the python-docx template is empty on a new Document(); there is none, so nothing to remove
    lines_above = 0
    for key, font in (("copy_no", FANGSONG), ("secrecy", HEITI), ("urgency", HEITI)):
        if spec.get(key):
            add(doc, spec[key], font=font, align=WD_ALIGN_PARAGRAPH.LEFT)
            lines_above += 1
    if redhead:
        org = spec.get("org", "") + spec.get("org_suffix", "文件")
        size = max(22, min(36, int(TEXT_W_PT / max(1, len(org)))))
        p = add(doc, org, font=XIAOBIAOSONG, size=size, align=WD_ALIGN_PARAGRAPH.CENTER,
                line=size * 1.2, before=max(0, 35 / 25.4 * 72 - lines_above * LINE))
        for r in p.runs:
            r.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)
        if spec.get("number") or spec.get("signer"):
            number = spec.get("number", "")
            if spec.get("signer"):
                # upward document: number left (indent 1字), 签发人 right on the same line
                p = add(doc, "", before=2 * LINE, align=WD_ALIGN_PARAGRAPH.LEFT, left=SIZE)
                set_fonts(p.add_run(number), FANGSONG, SIZE)
                tabs = p.paragraph_format.tab_stops
                tabs.add_tab_stop(Pt(TEXT_W_PT - SIZE), WD_TAB_ALIGNMENT.RIGHT)
                set_fonts(p.add_run("\t签发人："), FANGSONG, SIZE)
                set_fonts(p.add_run(spec["signer"]), KAITI, SIZE)
            else:
                p = add(doc, number, before=2 * LINE, align=WD_ALIGN_PARAGRAPH.CENTER)
        else:
            p = add(doc, "", before=LINE, align=WD_ALIGN_PARAGRAPH.CENTER)
        border(p, "bottom", 8, "FF0000", space=8)   # 版头分隔线, about 4 mm under the number
        title_before = 2 * LINE
    else:
        title_before = 0 if not lines_above else LINE
    title = spec["title"] if isinstance(spec["title"], str) else "\n".join(spec["title"])
    title = balance_title(title)
    p = add(doc, "", font=XIAOBIAOSONG, size=22, align=WD_ALIGN_PARAGRAPH.CENTER, line=35, before=title_before)
    for i, part in enumerate(title.split("\n")):
        if i:
            p.add_run().add_break()
        set_fonts(p.add_run(part), XIAOBIAOSONG, 22)
    if spec.get("addressee"):
        add(doc, spec["addressee"], before=LINE, align=WD_ALIGN_PARAGRAPH.LEFT)
    else:
        add(doc, "", align=WD_ALIGN_PARAGRAPH.LEFT)      # no addressee: one blank line between title and text
    last_block = add_body(doc, spec["body"])
    if spec.get("sign_org") or spec.get("date") or spec.get("attachments"):
        keep_with_next(last_block)   # the last lines of text go with the signature
    if spec.get("attachments"):
        items = spec["attachments"]
        for i, name in enumerate(items):
            label = "附件：" if i == 0 else ""
            numbered = f"{i + 1}.{name}" if len(items) > 1 else name
            p = add(doc, "", before=LINE if i == 0 else 0, align=WD_ALIGN_PARAGRAPH.LEFT)
            # "附件：" starts 2 characters in; wrapped lines line up with the first character of the name
            p.paragraph_format.left_indent = Pt(5 * SIZE)
            p.paragraph_format.first_line_indent = Pt(-3 * SIZE) if i == 0 else Pt(0)
            set_fonts(p.add_run(label + numbered), FANGSONG, SIZE)
            if spec.get("sign_org") or spec.get("date"):
                p.paragraph_format.keep_with_next = True
    if spec.get("sign_org") or spec.get("date"):
        org = spec.get("sign_org", "")
        date = spec.get("date", "")
        w_org, w_date = text_width(org), text_width(date)
        if spec.get("seal"):
            date_start = TEXT_W_PT - 4 * SIZE - w_date
            org_start = max(0, date_start + w_date / 2 - w_org / 2)
        else:
            # 7.3.5.2: the date starts two characters to the right of the signing unit's first character
            org_start = TEXT_W_PT - 2 * SIZE - w_org
            date_start = org_start + 2 * SIZE
            if date_start + w_date > TEXT_W_PT - 2 * SIZE:      # date longer than the unit: keep the 2-character offset
                date_start = TEXT_W_PT - 2 * SIZE - w_date      # and move the unit to the left instead
                org_start = date_start - 2 * SIZE
        if org:
            p = add(doc, org, before=LINE if not spec.get("seal") else 2 * LINE, align=WD_ALIGN_PARAGRAPH.LEFT, left=max(0, org_start))
            p.paragraph_format.keep_with_next = True
        if date:
            p = add(doc, date, align=WD_ALIGN_PARAGRAPH.LEFT, left=max(0, date_start))
            p.paragraph_format.keep_with_next = bool(spec.get("note"))
    if spec.get("note"):
        add(doc, spec["note"], align=WD_ALIGN_PARAGRAPH.LEFT, left=2 * SIZE)
    for page in spec.get("attachment_pages", []):
        pb = doc.add_paragraph()
        fmt(pb)
        pb.add_run().add_break(WD_BREAK.PAGE)
        add(doc, page.get("label", "附件"), font=HEITI, align=WD_ALIGN_PARAGRAPH.LEFT)
        add(doc, "", align=WD_ALIGN_PARAGRAPH.LEFT)
        add(doc, page.get("title", ""), font=XIAOBIAOSONG, size=22, align=WD_ALIGN_PARAGRAPH.CENTER, line=35)
        add(doc, "", align=WD_ALIGN_PARAGRAPH.LEFT)
        add_body(doc, page.get("body", []))
    if spec.get("cc") or spec.get("issuer"):
        rows = []
        if spec.get("cc"):
            rows.append(("cc", "抄送：" + spec["cc"].rstrip("。.") + "。"))
        if spec.get("issuer"):
            rows.append(("issuer", spec["issuer"]))
        tbl = doc.add_table(rows=len(rows), cols=1)
        tblPr = tbl._tbl.tblPr
        pos = OxmlElement("w:tblpPr")   # floats to the bottom edge of the text area on the last page
        for k, v in (("w:leftFromText", "0"), ("w:rightFromText", "0"), ("w:vertAnchor", "margin"),
                     ("w:horzAnchor", "margin"), ("w:tblpXSpec", "left"), ("w:tblpYSpec", "bottom")):
            pos.set(qn(k), v)
        tblPr.insert(1 if tblPr.find(qn("w:tblStyle")) is not None else 0, pos)
        tbl.autofit = False
        total = round(TEXT_W_PT * 20)
        for gc in tbl._tbl.tblGrid.findall(qn("w:gridCol")):
            gc.set(qn("w:w"), str(total))
        for i, (kind, text) in enumerate(rows):
            cell = tbl.cell(i, 0)
            cell.width = Pt(TEXT_W_PT)
            tcPr = cell._tc.get_or_add_tcPr()
            borders = OxmlElement("w:tcBorders")
            top = OxmlElement("w:top")
            top.set(qn("w:val"), "single")
            top.set(qn("w:sz"), "6" if i else "8")         # 0.25 mm between rows, 0.35 mm at the top
            top.set(qn("w:color"), "000000")
            borders.append(top)
            left = OxmlElement("w:left")
            left.set(qn("w:val"), "nil")
            borders.append(left)
            if i == len(rows) - 1:
                bottom = OxmlElement("w:bottom")
                bottom.set(qn("w:val"), "single")
                bottom.set(qn("w:sz"), "8")
                bottom.set(qn("w:color"), "000000")
                borders.append(bottom)
            right = OxmlElement("w:right")
            right.set(qn("w:val"), "nil")
            borders.append(right)
            tcPr.append(borders)
            p = cell.paragraphs[0]
            fmt(p, line=24, left=14, right=14)
            if kind == "cc":
                set_fonts(p.add_run(text), FANGSONG, 14)
            else:
                p.paragraph_format.tab_stops.add_tab_stop(Pt(TEXT_W_PT - 28), WD_TAB_ALIGNMENT.RIGHT)
                set_fonts(p.add_run(text), FANGSONG, 14)
                if spec.get("issue_date"):
                    set_fonts(p.add_run("\t" + spec["issue_date"] + "印发"), FANGSONG, 14)
    doc.core_properties.title = title.replace("\n", "")
    doc.core_properties.author = spec.get("sign_org") or spec.get("org") or ""
    doc.save(out)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        spec = json.load(fh)
    if not spec.get("title") or not spec.get("body"):
        print("spec 里必须有 title 和 body")
        return 2
    build(spec, sys.argv[2])
    print(f"已生成 {sys.argv[2]}")
    code, issues = check_docx.check(sys.argv[2], gongwen=True)
    if issues:
        for level, where, msg in issues:
            print(f"[{level}] {where}  {msg}")
    else:
        print("自检:没有发现问题。")
    return code



if __name__ == "__main__":
    sys.exit(main())
