#!/usr/bin/env python3
"""Check a .docx before handing it over, without Word or LibreOffice.

    python check_docx.py report.docx                    # print problems
    python check_docx.py notice.docx --gongwen          # also check against the GB/T 9704 layout
    python check_docx.py report.docx --fix-fonts 微软雅黑   # give every style and run a Chinese font, in place

Checks: leftover placeholders (XXX, TODO, 【请填写】, {{x}}, 此处填写 ...), empty headings and skipped
heading levels, Chinese text with no East Asian font set (Word then picks one you did not choose),
a Chinese font that is not installed on this machine, tables and pictures wider than the text area,
pictures whose file is missing, leftover tracked changes and comments, Letter paper instead of A4,
runs of empty paragraphs used as spacing, default author "python-docx".
Output is a short list: [错误] must fix, [注意] look at it, [提示] for information.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from docx import Document
    from docx.oxml.ns import qn
    from docx.shared import Emu
except ImportError as exc:  # pragma: no cover
    print(f"python-docx is required: {exc}")
    sys.exit(2)

import office_env

CJK = re.compile(r"[㐀-鿿豈-﫿　-〿＀-￯]")
PLACEHOLDERS = [
    (re.compile(r"\b(?:TODO|TBD|FIXME)\b"), "待办标记"),
    (re.compile(r"X{2,}|×{2,}|○{2,}|\bxx{2,}\b"), "XXX 占位符"),
    (re.compile(r"lorem ipsum", re.I), "Lorem ipsum 示例文字"),
    (re.compile(r"\{\{[^}]*\}\}|\$\{[^}]*\}|<<[^>]+>>"), "未替换的模板变量"),
    (re.compile(r"【\s*】|\[\s*\]|（\s*）(?!\S)"), "空的括号"),
    (re.compile(r"【[^】]*(?:请填|填写|待补|待定|示例|此处)[^】]*】|\[[^\]]*(?:请填|填写|待补|Insert|insert|your )[^\]]*\]"), "括号里的填写提示"),
    (re.compile(r"此处(?:填写|输入|添加|插入)|请(?:在此)?(?:填写|输入)|待补充|待填写|点击此处|单击此处"), "填写提示"),
]
FANGSONG = {"仿宋_gb2312", "仿宋", "fangsong", "fangsong_gb2312", "stfangsong", "华文仿宋", "仿宋gb2312"}
HEITI = {"黑体", "simhei", "heiti sc", "stheiti", "华文黑体"}
KAITI = {"楷体_gb2312", "楷体", "kaiti", "kaiti_gb2312", "kaiti sc", "stkaiti", "华文楷体", "楷体gb2312"}


def mm(emu) -> float:
    return emu / 36000.0


# ── style / font resolution ──
_DOC = None     # the Document being checked: header/footer parts have no .document of their own


def _styles_element(para):
    if _DOC is not None:
        return _DOC.styles.element
    return para.part.document.styles.element


_THEME_EA_MEMO = {}


def theme_ea_font(doc):
    """East Asian font the document theme names (Hans script font or the ea slot), else None."""
    key = id(doc)
    if key in _THEME_EA_MEMO:
        return _THEME_EA_MEMO[key]
    face = None
    try:
        for part in doc.part.package.iter_parts():
            if str(part.partname).startswith("/word/theme/") and str(part.partname).endswith(".xml"):
                blob = part.blob.decode("utf-8", "replace")
                minor = re.search(r"<a:minorFont>(.*?)</a:minorFont>", blob, re.S)
                if minor:
                    hans = re.search(r'<a:font script="Hans" typeface="([^"]+)"', minor.group(1))
                    ea = re.search(r'<a:ea typeface="([^"]+)"', minor.group(1))
                    face = hans.group(1) if hans else (ea.group(1) if ea else None)
                break
    except Exception:
        face = None
    _THEME_EA_MEMO[key] = face
    return face


def _rfonts_chain(para, run):
    """Yield rFonts elements from the run up through styles to docDefaults."""
    if run is not None and run._r.rPr is not None and run._r.rPr.rFonts is not None:
        yield run._r.rPr.rFonts
    style = para.style if para is not None else None
    while style is not None:
        rpr = style.element.rPr
        if rpr is not None and rpr.rFonts is not None:
            yield rpr.rFonts
        style = style.base_style
    defaults = _styles_element(para).find(qn("w:docDefaults")) if para is not None else None
    if defaults is not None:
        rpr_default = defaults.find(qn("w:rPrDefault"))
        if rpr_default is not None:
            rpr = rpr_default.find(qn("w:rPr"))
            if rpr is not None and rpr.find(qn("w:rFonts")) is not None:
                yield rpr.find(qn("w:rFonts"))


def east_asia_font(para, run):
    for rf in _rfonts_chain(para, run):
        name = rf.get(qn("w:eastAsia"))
        if name:
            return name
        if rf.get(qn("w:eastAsiaTheme")):
            # the style takes the East Asian font from the theme: that is a font chosen by the template
            return theme_ea_font(_DOC) or "(主题字体)"
    return None


def font_size_pt(para, run):
    if run is not None and run.font.size:
        return run.font.size.pt
    style = para.style
    while style is not None:
        if style.font is not None and style.font.size:
            return style.font.size.pt
        style = style.base_style
    defaults = _styles_element(para).find(qn("w:docDefaults"))
    if defaults is not None:
        sz = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}/{qn('w:sz')}")
        if sz is not None:
            return int(sz.get(qn("w:val"))) / 2.0
    return 10.5


def iter_paragraphs(doc):
    """(paragraph, where) for body, tables, headers and footers."""
    def from_container(container, where):
        for p in container.paragraphs:
            yield p, where
        for t in container.tables:
            for row in t.rows:
                seen = set()
                for cell in row.cells:
                    if id(cell._tc) in seen:
                        continue
                    seen.add(id(cell._tc))
                    yield from from_container(cell, where + "(表格)")
    yield from from_container(doc, "正文")
    for i, sec in enumerate(doc.sections, start=1):
        for label, part in (("页眉", sec.header), ("页脚", sec.footer)):
            if not part.is_linked_to_previous or i == 1:
                yield from from_container(part, label)


def check(path, gongwen=False):
    issues = []

    def add(level, where, msg):
        issues.append((level, where, msg))

    global _DOC
    try:
        doc = Document(path)
    except Exception as exc:
        print(f"[错误] 文件打不开: {exc}")
        return 1, []
    _DOC = doc

    sec0 = doc.sections[0]
    text_w = sec0.page_width - sec0.left_margin - sec0.right_margin
    page_w_in = sec0.page_width / 914400.0
    if abs(page_w_in - 8.5) < 0.05 and not gongwen:
        add("注意", "页面", "纸张是 Letter(21.6×27.9 厘米),国内文档通常用 A4(21×29.7 厘米);用 section.page_width=Cm(21)、page_height=Cm(29.7) 改。")

    paragraphs = list(iter_paragraphs(doc))

    # placeholders
    for p, where in paragraphs:
        text = p.text
        if not text.strip():
            continue
        for rx, label in PLACEHOLDERS:
            m = rx.search(text)
            if m:
                snippet = text.strip()[:30] + ("…" if len(text.strip()) > 30 else "")
                add("错误", where, f"残留{label}「{m.group(0)}」: {snippet}")
                break

    # headings
    last_level = 0
    for p, where in paragraphs:
        if where != "正文":
            continue
        name = (p.style.name or "") if p.style is not None else ""
        m = re.match(r"(?:Heading|标题)\s*(\d)$", name)
        if not m:
            continue
        level = int(m.group(1))
        if not p.text.strip():
            add("错误", where, f"有一个空的{level}级标题(目录里会出现空行)")
        if last_level and level > last_level + 1:
            add("注意", where, f"标题层级从 {last_level} 级直接跳到 {level} 级: {p.text.strip()[:20]}")
        last_level = level

    # Chinese fonts
    missing_ea = 0
    first_missing = ""
    used_ea = {}
    for p, where in paragraphs:
        for run in p.runs:
            if run.text and CJK.search(run.text):
                ea = east_asia_font(p, run)
                if ea is None:
                    missing_ea += 1
                    first_missing = first_missing or run.text.strip()[:12]
                else:
                    used_ea[ea] = used_ea.get(ea, 0) + 1
    if missing_ea:
        add("注意", "字体", f"{missing_ea} 处中文没有指定中文字体(如「{first_missing}」),Word 会自己挑一个字体,可能不是你想要的。"
            "给文档设中文字体: python check_docx.py 文件 --fix-fonts 微软雅黑")
    for name, count in used_ea.items():
        if not name.startswith("(") and not office_env.has_font(name):
            tag = "公文用的标准字体" if name in ("仿宋_GB2312", "方正小标宋简体", "楷体_GB2312") else "字体"
            add("提示", "字体", f"{tag}「{name}」没有装在这台电脑上({count} 处使用);文件里记的仍是这个名字,装了该字体的电脑上显示正常,这台电脑上会显示成替代字体。")

    # tables / pictures wider than the text area
    body = doc.element.body
    grid_w = []
    for ti, tbl in enumerate(doc.tables, start=1):
        cols = tbl._tbl.tblGrid.findall(qn("w:gridCol")) if tbl._tbl.tblGrid is not None else []
        total = sum(int(c.get(qn("w:w"), 0)) for c in cols) * 635  # twips -> EMU
        for tr in tbl._tbl.tr_lst:
            widths = [int(w.get(qn("w:w"), 0)) for w in tr.xpath("./w:tc/w:tcPr/w:tcW[@w:type='dxa']")]
            total = max(total, sum(widths) * 635)
        grid_w.append(total)
        if total and total > text_w * 1.02:
            add("错误", f"表格{ti}", f"表格宽 {mm(total) / 10:.1f} 厘米,超出版心宽 {mm(text_w) / 10:.1f} 厘米,右侧会被裁掉或超出页边。缩小列宽。")
    for ext in body.iter("{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent"):
        cx = int(ext.get("cx", 0))
        if cx > text_w * 1.02:
            add("错误", "图片", f"有图片宽 {mm(cx) / 10:.1f} 厘米,超出版心宽 {mm(text_w) / 10:.1f} 厘米。")
    blip_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    for blip in body.iter(f"{{{blip_ns}}}blip"):
        rid = blip.get(f"{{{rel_ns}}}embed")
        link = blip.get(f"{{{rel_ns}}}link")
        if link:
            add("错误", "图片", "图片是外部链接,不是嵌入的,换电脑后会显示叉。")
        if rid:
            rel = doc.part.rels.get(rid)
            if rel is None or (not rel.is_external and rel.target_part is None):
                add("错误", "图片", f"有图片的文件缺失({rid}),文档里会显示红叉。")

    # tracked changes, comments
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml").decode("utf-8", "replace")
        names = zf.namelist()
    ins, dele = len(re.findall(r"<w:ins\b", xml)), len(re.findall(r"<w:del\b", xml))
    moves = len(re.findall(r"<w:move(?:From|To)\b", xml))
    if ins or dele or moves:
        add("注意", "修订", f"文档里还有未处理的修订(插入 {ins}、删除 {dele}、移动 {moves})。如果不是有意保留,先接受或拒绝。")
    if "word/comments.xml" in names:
        n = len(re.findall(r"<w:comment\b", zipfile.ZipFile(path).read("word/comments.xml").decode("utf-8", "replace")))
        if n:
            add("注意", "批注", f"文档里有 {n} 条批注。如果要发出去,先确认是否保留。")

    # empty paragraph runs
    run = 0
    for p in doc.paragraphs:
        has_obj = bool(p._p.xpath(".//w:drawing | .//w:br | .//w:sectPr | .//w:fldChar | .//w:pict"))
        if not p.text.strip() and not has_obj:
            run += 1
            if run == 3:
                add("提示", "正文", "连续 3 个以上空段落,像是用回车做间距;改用段前/段后间距更稳。")
        else:
            run = 0

    # metadata
    props = doc.core_properties
    if (props.author or "").strip().lower() in ("python-docx", "openpyxl", "python-pptx"):
        add("提示", "属性", "文档作者还是默认的 python-docx;可用 doc.core_properties.author 改成用户或单位名称,并设置 title。")

    if gongwen:
        check_gongwen(doc, paragraphs, add)

    order = {"错误": 0, "注意": 1, "提示": 2}
    issues.sort(key=lambda x: order[x[0]])
    return 0, issues


def check_gongwen(doc, paragraphs, add):
    sec = doc.sections[0]
    page = (mm(sec.page_width), mm(sec.page_height))
    if abs(page[0] - 210) > 1.5 or abs(page[1] - 297) > 1.5:
        add("错误", "公文版式", f"纸张应为 A4(210×297 毫米),现在是 {page[0]:.0f}×{page[1]:.0f}。")
    for label, got, want in (("上边距", mm(sec.top_margin), 37), ("下边距", mm(sec.bottom_margin), 35),
                             ("左边距", mm(sec.left_margin), 28), ("右边距", mm(sec.right_margin), 26)):
        if abs(got - want) > 1.5:
            add("错误", "公文版式", f"{label}应为 {want} 毫米(版心 156×225 毫米),现在是 {got:.1f} 毫米。")
    footer_xml = "".join(s.footer._element.xml for s in doc.sections)
    even_footer_xml = "".join(s.even_page_footer._element.xml for s in doc.sections) if doc.settings.odd_and_even_pages_header_footer else ""
    if "PAGE" not in footer_xml and "PAGE" not in even_footer_xml:
        add("错误", "公文版式", "页脚里没有页码。公文页码用 4 号宋体,格式「— 1 —」,单页码居右、双页码居左。")
    elif not doc.settings.odd_and_even_pages_header_footer:
        add("注意", "公文版式", "没有设置奇偶页不同:公文页码单页码居右空一字、双页码居左空一字。")
    grid = doc.sections[0]._sectPr.find(qn("w:docGrid"))
    if grid is None or grid.get(qn("w:linePitch")) is None:
        add("注意", "公文版式", "没有设置每页 22 行的文档网格,正文行数会和标准不一致。")

    sizes = {}
    for p, where in paragraphs:
        if where != "正文" or not p.text.strip():
            continue
        text = p.text.strip()
        runs = [r for r in p.runs if r.text.strip()]
        if not runs:
            continue
        size = font_size_pt(p, runs[0])
        ea = (east_asia_font(p, runs[0]) or "").lower()
        if len(text) >= 40 and len(runs) > 1 and re.match(r"^\s*(（[一二三四五六七八九十]+）|[一二三四五六七八九十]+、)", runs[0].text):
            # a run-in heading ("（一）做好工作交接。" in its own font, then the body text in the same paragraph):
            # the heading run is judged as a heading, the rest as body text
            heading, runs = runs[0], runs[1:]
            hea = (east_asia_font(p, heading) or "").lower()
            if not runs or runs[0].text.strip() == "":
                continue
            level_one = not heading.text.strip().startswith("（")
            if hea not in (HEITI if level_one else KAITI):
                add("错误", "公文版式", f"{'一' if level_one else '二'}级标题「{heading.text.strip()[:12]}」应为 3 号{'黑体' if level_one else '楷体_GB2312'},现在是「{hea or '未指定'}」。")
            size = font_size_pt(p, runs[0])
            ea = (east_asia_font(p, runs[0]) or "").lower()
            text = "".join(r.text for r in runs).strip()
            if len(text) > 40 and p.alignment != 1:
                if abs(size - 16) > 0.1:
                    add("错误", "公文版式", f"正文「{text[:10]}…」字号应为 3 号(16 磅),现在是 {size:g} 磅。")
                elif ea not in FANGSONG:
                    add("错误", "公文版式", f"正文「{text[:10]}…」应为仿宋_GB2312,现在是「{ea or '未指定'}」。")
            continue
        if re.match(r"^[一二三四五六七八九十]+、", text) and len(text) < 40 and ea not in HEITI:
            add("错误", "公文版式", f"一级标题「{text[:12]}」应为 3 号黑体,现在是「{ea or '未指定'}」。")
        elif re.match(r"^（[一二三四五六七八九十]+）", text) and len(text) < 40 and ea not in KAITI:
            add("错误", "公文版式", f"二级标题「{text[:12]}」应为 3 号楷体_GB2312,现在是「{ea or '未指定'}」。")
        elif len(text) > 40 and p.alignment != 1:      # body text in any alignment (justified included); a centred line is a title
            sizes[size] = sizes.get(size, 0) + 1
            if abs(size - 16) > 0.1:
                add("错误", "公文版式", f"正文「{text[:10]}…」字号应为 3 号(16 磅),现在是 {size:g} 磅。")
            elif ea not in FANGSONG:
                add("错误", "公文版式", f"正文「{text[:10]}…」应为仿宋_GB2312,现在是「{ea or '未指定'}」。")
            indent = p.paragraph_format.first_line_indent
            pPr = p._p.pPr
            chars = pPr.find(qn("w:ind")).get(qn("w:firstLineChars")) if pPr is not None and pPr.find(qn("w:ind")) is not None else None
            if not (chars == "200" or (indent is not None and abs(indent.pt - 32) < 1.5)):
                add("注意", "公文版式", f"正文段落「{text[:10]}…」首行应缩进 2 个字。")
        if re.search(r"\d{4}年0\d月|\d{4}年\d{1,2}月0\d日", text):
            add("错误", "公文版式", f"日期不能带前导零(应写成 2025年3月5日): {text[:20]}")
        if re.search(r"[\[（(【]\d{4}[\]）)】]\s*\d+\s*号", text) and "〔" not in text:
            add("错误", "公文版式", f"发文字号的年份要用六角括号〔〕: {text[:24]}")
    del sizes


def fix_fonts(path, font):
    doc = Document(path)
    count = 0

    def set_rfonts(rpr_owner_rpr):
        nonlocal count
        rf = rpr_owner_rpr.get_or_add_rFonts()
        if not rf.get(qn("w:eastAsia")):
            rf.set(qn("w:eastAsia"), font)
            count += 1
    def chosen(rf):
        """True when the template itself names the East Asian font (directly or through the theme)."""
        return bool(rf.get(qn("w:eastAsia")) or rf.get(qn("w:eastAsiaTheme")))
    defaults = doc.styles.element.find(qn("w:docDefaults"))
    if defaults is not None:
        rpr = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}")
        if rpr is not None:
            rf = rpr.find(qn("w:rFonts"))
            if rf is None:
                from docx.oxml import OxmlElement
                rf = OxmlElement("w:rFonts")
                rpr.insert(0, rf)
            if not chosen(rf):
                rf.set(qn("w:eastAsia"), font)
                count += 1
    for style in doc.styles:
        el = style.element
        if el.rPr is not None and el.rPr.rFonts is not None:
            rf = el.rPr.rFonts
            if not chosen(rf):
                rf.set(qn("w:eastAsia"), font)
                count += 1
    for p, _where in iter_paragraphs(doc):
        for run in p.runs:
            rpr = run._r.rPr
            if rpr is not None and rpr.rFonts is not None and not chosen(rpr.rFonts):
                rpr.rFonts.set(qn("w:eastAsia"), font)
                count += 1
    doc.save(path)
    return count


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Check a .docx before delivery")
    ap.add_argument("file")
    ap.add_argument("--gongwen", action="store_true", help="also check the GB/T 9704 official-document layout")
    ap.add_argument("--fix-fonts", metavar="FONT", help="set this East Asian font on styles and runs that lack one (edits the file)")
    a = ap.parse_args()
    if not os.path.isfile(a.file):
        print(f"找不到文件: {a.file}")
        return 2
    if a.fix_fonts:
        n = fix_fonts(a.file, a.fix_fonts)
        print(f"已给 {n} 处设置中文字体「{a.fix_fonts}」。")
    code, issues = check(a.file, a.gongwen)
    if code:
        return code
    print(f"文件: {os.path.basename(a.file)}")
    for level, where, msg in issues[:60]:
        print(f"[{level}] {where}  {msg}")
    if len(issues) > 60:
        print(f"... 还有 {len(issues) - 60} 条未列出")
    if not issues:
        print("没有发现问题。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
