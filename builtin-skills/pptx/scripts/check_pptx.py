#!/usr/bin/env python3
"""Check a .pptx before handing it over, without PowerPoint or LibreOffice.

    python check_pptx.py deck.pptx
    python check_pptx.py deck.pptx --fix-fonts 微软雅黑     # set a Chinese font on the theme and on runs lacking one (edits the file)

Checks per slide: shapes outside the slide, text boxes that overlap each other, text that probably
does not fit its box (estimated from the box size, font size and character count: Chinese characters
are one font-size wide, Latin letters about 0.55), tables that probably run off the bottom, pictures
stretched out of proportion or missing, empty placeholders ("单击此处添加标题" shows in edit view),
leftover placeholder text (XXX, 请填写, Lorem ipsum), text under 12 pt, more than 6 paragraphs in one
box, Chinese text with no Chinese font set, a Chinese font not installed on this machine.
Text fit is an estimate: it says "可能溢出" and never blocks. Output: [错误] / [注意] / [提示].
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
    from pptx.oxml.ns import qn
except ImportError as exc:  # pragma: no cover
    print(f"python-pptx is required: {exc}")
    sys.exit(2)

import office_env

CJK = re.compile(r"[㐀-鿿豈-﫿　-〿＀-￯]")
PLACEHOLDERS = [
    (re.compile(r"\b(?:TODO|TBD|FIXME)\b"), "待办标记"),
    (re.compile(r"X{2,}|×{2,}|○{2,}"), "XXX 占位符"),
    (re.compile(r"lorem ipsum", re.I), "Lorem ipsum 示例文字"),
    (re.compile(r"\{\{[^}]*\}\}"), "未替换的模板变量"),
    (re.compile(r"【[^】]*(?:请填|填写|待补|示例|此处)[^】]*】"), "括号里的填写提示"),
    (re.compile(r"此处(?:填写|输入|添加|插入)|请(?:在此)?(?:填写|输入)|待补充|点击此处|单击此处|Click to (?:add|edit)", re.I), "填写提示"),
]
EMU_IN = 914400
IN_CM = 2.54
SKIP_PLACEHOLDERS = {PP_PLACEHOLDER.SLIDE_NUMBER, PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.DATE}


def cm(emu):
    return emu / EMU_IN * IN_CM


def char_w(ch, size):
    if CJK.match(ch):
        return size
    if ch == " ":
        return size * 0.3
    if ch.isupper() or ch.isdigit():
        return size * 0.6
    return size * 0.52


def inherited_size(shape, slide, level=0):
    """Font size in pt from the placeholder's layout and master, else 18."""
    lvl = f"a:lvl{level + 1}pPr"
    if shape.is_placeholder:
        try:
            idx = shape.placeholder_format.idx
            for ph in slide.slide_layout.placeholders:
                if ph.placeholder_format.idx == idx:
                    el = ph._element.find(f".//{qn('a:lstStyle')}/{qn(lvl)}/{qn('a:defRPr')}")
                    if el is not None and el.get("sz"):
                        return int(el.get("sz")) / 100
            kind = shape.placeholder_format.type
            style = "p:titleStyle" if kind in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE) else (
                "p:bodyStyle" if kind in (PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT, PP_PLACEHOLDER.SUBTITLE) else "p:otherStyle")
            master = slide.slide_layout.slide_master._element
            el = master.find(f".//{qn('p:txStyles')}/{qn(style)}/{qn(lvl)}/{qn('a:defRPr')}")
            if el is not None and el.get("sz"):
                return int(el.get("sz")) / 100
        except Exception:
            pass
    return 18.0


def para_size(shape, slide, para):
    for r in para.runs:
        if r.font.size:
            return r.font.size.pt
    ppr = para._p.find(qn("a:pPr"))
    if ppr is not None:
        end = para._p.find(qn("a:endParaRPr"))
        if end is not None and end.get("sz"):
            return int(end.get("sz")) / 100
    lst = shape._element.find(f".//{qn('a:lstStyle')}/{qn('a:lvl1pPr')}/{qn('a:defRPr')}") if hasattr(shape, "_element") else None
    if lst is not None and lst.get("sz"):
        return int(lst.get("sz")) / 100
    return inherited_size(shape, slide, para.level)


def estimate_height(shape, slide, text_frame, width_pt):
    """Estimated height in pt that the text needs inside width_pt."""
    total = 0.0
    for para in text_frame.paragraphs:
        size = para_size(shape, slide, para)
        ppr = para._p.find(qn("a:pPr"))
        marl = int(ppr.get("marL", 0)) / 12700 if ppr is not None else 0
        has_bullet = ppr is not None and ppr.find(qn("a:buChar")) is not None
        usable = max(width_pt - marl - (size if has_bullet and marl == 0 else 0), size)
        width = 0.0
        for r in para.runs:
            s = r.font.size.pt if r.font.size else size
            width += sum(char_w(c, s) for c in r.text)
        lines = max(1, math.ceil(width / usable)) if width else 1
        spacing = 1.2
        if ppr is not None:
            pct = ppr.find(f"{qn('a:lnSpc')}/{qn('a:spcPct')}")
            pts = ppr.find(f"{qn('a:lnSpc')}/{qn('a:spcPts')}")
            if pct is not None:
                spacing = 1.2 * int(pct.get("val")) / 100000
            elif pts is not None:
                spacing = int(pts.get("val")) / 100 / size
            for tag in ("a:spcBef", "a:spcAft"):
                el = ppr.find(f"{qn(tag)}/{qn('a:spcPts')}")
                if el is not None:
                    total += int(el.get("val")) / 100
        total += lines * size * spacing
    return total


def insets(text_frame):
    body = text_frame._txBody.find(qn("a:bodyPr"))
    get = lambda k, d: int(body.get(k, d)) / 12700 if body is not None else d / 12700  # noqa: E731
    return get("lIns", 91440), get("rIns", 91440), get("tIns", 45720), get("bIns", 45720)


def theme_ea_font(prs):
    """East Asian font the deck's theme names (Hans script font or the ea slot), else None."""
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    try:
        master = prs.slide_masters[0]
        blob = master.part.part_related_by(RT.THEME).blob.decode("utf-8", "replace")
    except Exception:
        return None
    minor = re.search(r"<a:minorFont>(.*?)</a:minorFont>", blob, re.S)
    if not minor:
        return None
    hans = re.search(r'<a:font script="Hans" typeface="([^"]+)"', minor.group(1))
    if hans:
        return hans.group(1)
    ea = re.search(r'<a:ea typeface="([^"]+)"', minor.group(1))
    return ea.group(1) if ea else None


def run_face(run, theme_ea):
    """East Asian font of a run: its own, else what the theme names, else None."""
    ea = run._r.find(f"{qn('a:rPr')}/{qn('a:ea')}")
    face = ea.get("typeface") if ea is not None else None
    if face and face.startswith("+"):
        face = theme_ea
    return face or theme_ea


def shape_text(shape):
    return shape.text_frame.text if shape.has_text_frame else ""


def walk(shapes):
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield sh
            yield from walk(sh.shapes)
        else:
            yield sh


def check(path):
    issues = []

    def add(level, where, msg):
        issues.append((level, where, msg))

    try:
        prs = Presentation(path)
    except Exception as exc:
        print(f"[错误] 文件打不开: {exc}")
        return 1, []
    sw, sh_ = prs.slide_width, prs.slide_height
    theme_ea = theme_ea_font(prs)
    tol = int(0.08 * EMU_IN)
    missing_ea, first_missing, used_ea = 0, "", {}

    for n, slide in enumerate(prs.slides, start=1):
        where = f"第{n}页"
        has_title = False
        boxes = []
        for shape in walk(slide.shapes):
            name = shape.name or shape.shape_type
            try:
                l, t, w, h = shape.left, shape.top, shape.width, shape.height
            except Exception:
                continue
            if None in (l, t, w, h):
                continue
            if shape.is_placeholder and shape.placeholder_format.type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE) and shape_text(shape).strip():
                has_title = True
            # off the slide
            if l < -tol or t < -tol or l + w > sw + tol or t + h > sh_ + tol:
                if not (w >= sw * 0.98 and h >= sh_ * 0.98):  # full-bleed background pictures may overhang a little
                    add("错误", where, f"「{name}」超出页面: 位置 ({cm(l):.1f},{cm(t):.1f}) 厘米,大小 {cm(w):.1f}×{cm(h):.1f} 厘米,页面 {cm(sw):.1f}×{cm(sh_):.1f}")
            # pictures
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    iw, ih = shape.image.size
                    cw = iw * (1 - shape.crop_left - shape.crop_right)
                    ch = ih * (1 - shape.crop_top - shape.crop_bottom)
                    if cw > 0 and ch > 0 and h > 0:
                        diff = abs((w / h) / (cw / ch) - 1)
                        if diff > 0.08:
                            add("注意", where, f"图片「{name}」被拉伸变形(显示比例 {w / h:.2f},原图 {cw / ch:.2f});按原比例只设宽或只设高。")
                except Exception:
                    add("错误", where, f"图片「{name}」的文件缺失或损坏,放映时会显示红叉。")
            # placeholders
            if shape.is_placeholder and shape.placeholder_format.type not in SKIP_PLACEHOLDERS:
                # a filled picture/chart/table placeholder is a p:pic / p:graphicFrame; only an unfilled one is a p:sp
                empty = (shape.has_text_frame and not shape.text_frame.text.strip()) or (
                    not shape.has_text_frame and shape._element.tag == qn("p:sp"))
                if empty:
                    add("错误", where, f"占位符「{name}」是空的(编辑时显示「单击此处添加…」),填上内容或删掉这个框。")
            if shape.has_text_frame and shape.text_frame.text.strip():
                text = shape.text_frame.text
                for rx, label in PLACEHOLDERS:
                    m = rx.search(text)
                    if m:
                        add("错误", where, f"「{name}」有残留{label}「{m.group(0)}」")
                        break
                tf = shape.text_frame
                # fonts / sizes
                small = []
                for para in tf.paragraphs:
                    for run in para.runs:
                        if run.text and CJK.search(run.text):
                            face = run_face(run, theme_ea)
                            if not face:
                                missing_ea += 1
                                first_missing = first_missing or run.text.strip()[:10]
                            else:
                                used_ea[face] = used_ea.get(face, 0) + 1
                        if run.font.size and run.font.size.pt < 12 and run.text.strip() and not (shape.is_placeholder and shape.placeholder_format.type in SKIP_PLACEHOLDERS):
                            small.append(run.font.size.pt)
                if small:
                    add("注意", where, f"「{name}」有 {min(small):g} 磅的小字,投影或打印时看不清;正文建议 14 磅以上。")
                paras = [p for p in tf.paragraphs if p.text.strip()]
                if len(paras) > 6 and not (shape.is_placeholder and shape.placeholder_format.type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE)):
                    add("提示", where, f"「{name}」里有 {len(paras)} 段文字,一页放太多,考虑拆页或精简。")
                # overflow estimate
                body = tf._txBody.find(qn("a:bodyPr"))
                wrap_none = body is not None and body.get("wrap") == "none"
                autofit_shape = body is not None and body.find(qn("a:spAutoFit")) is not None
                text_h = None
                if not wrap_none:
                    li, ri, ti, bi = insets(tf)
                    width_pt, height_pt = w / 12700 - li - ri, h / 12700 - ti - bi
                    need = estimate_height(shape, slide, tf, width_pt)
                    text_h = need
                    if autofit_shape:
                        # the box grows with its text when edited, but the file keeps the stored height:
                        # PowerPoint/WPS draw the text running past it until someone edits it
                        bottom = t + int((need + ti + bi) * 12700)
                        if bottom > sh_ + tol:
                            add("注意", where, f"「{name}」文字估算会向下延伸到约 {cm(bottom):.1f} 厘米,超出页面底部 {cm(sh_):.1f} 厘米,很可能被裁掉(按字数估的)。缩减文字、加宽框或调小字号。")
                        elif height_pt > 0 and need > height_pt * 1.1:
                            add("提示", where, f"「{name}」文字可能放不下: 估算需要约 {need / 28.35:.1f} 厘米高,框只有 {height_pt / 28.35:.1f} 厘米(框设了随文字变大,但文件里保存的高度没变,可能压到下面的内容)。")
                    elif height_pt > 0 and need > height_pt * 1.1:
                        shrink = body is not None and body.find(qn("a:normAutofit")) is not None
                        msg = f"「{name}」文字可能放不下: 估算需要约 {need / 28.35:.1f} 厘米高,框只有 {height_pt / 28.35:.1f} 厘米(这是按字数估的,请缩减文字、加大框或调小字号后再看)"
                        add("提示" if shrink else "注意", where, msg + ("。框设了自动缩小,PowerPoint 里编辑时会缩字。" if shrink else "。"))
                anchor = body.get("anchor", "t") if body is not None else "t"
                boxes.append((shape, l, t, w, h, name, text_h, anchor))
            # tables
            if shape.has_table if hasattr(shape, "has_table") else False:
                tbl = shape.table
                total = 0.0
                cols = [c.width / 12700 for c in tbl.columns]
                for ri, row in enumerate(tbl.rows):
                    need_row = row.height / 12700
                    for ci, cell in enumerate(row.cells):
                        if cell.is_spanned:
                            continue
                        est = estimate_height(shape, slide, cell.text_frame, max(cols[ci] - 14.4, 10)) + 7.2
                        need_row = max(need_row, est)
                    total += need_row
                if shape.top + total * 12700 > sh_ + tol:
                    add("注意", where, f"表格「{name}」按字数估算约 {total / 28.35:.1f} 厘米高,从 {cm(shape.top):.1f} 厘米起会超出页面底部 {cm(sh_):.1f} 厘米;减行数、减字号或拆成两页。")
                for row in tbl.rows:
                    for cell in row.cells:
                        for para in cell.text_frame.paragraphs:
                            for run in para.runs:
                                if run.text and CJK.search(run.text):
                                    face = run_face(run, theme_ea)
                                    if not face:
                                        missing_ea += 1
                                        first_missing = first_missing or run.text.strip()[:10]
                                    else:
                                        used_ea[face] = used_ea.get(face, 0) + 1
                for rx, label in PLACEHOLDERS:
                    for row in tbl.rows:
                        for cell in row.cells:
                            m = rx.search(cell.text_frame.text)
                            if m:
                                add("错误", where, f"表格「{name}」里有残留{label}「{m.group(0)}」")
                boxes.append((shape, l, t, w, h, name, None, "t"))
        # overlap between text boxes: certain only when the estimated text areas of the two boxes overlap;
        # a badge or label laid over a card or a coloured panel is normal and only gets a hint
        def text_area(bx):
            _sh, l_, t_, w_, h_, _n, text_h_, anchor_ = bx
            if text_h_ is None:
                return (l_, t_, w_, h_)
            th = min(int(text_h_ * 12700), h_)
            top = t_ if anchor_ == "t" else (t_ + (h_ - th) // 2 if anchor_ == "ctr" else t_ + h_ - th)
            return (l_, top, w_, th)

        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                ix = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
                iy = min(a[2] + a[4], b[2] + b[4]) - max(a[2], b[2])
                if ix > 0 and iy > 0:
                    inter = ix * iy
                    small_area = min(a[3] * a[4], b[3] * b[4])
                    if small_area and inter / small_area > 0.2:
                        ta, tb = text_area(a), text_area(b)
                        tx = min(ta[0] + ta[2], tb[0] + tb[2]) - max(ta[0], tb[0])
                        ty = min(ta[1] + ta[3], tb[1] + tb[3]) - max(ta[1], tb[1])
                        t_small = min(ta[2] * ta[3], tb[2] * tb[3])
                        if tx > 0 and ty > 0 and t_small and tx * ty / t_small > 0.2:
                            add("错误", where, f"「{a[5]}」和「{b[5]}」的文字区域互相重叠(估算重叠面积占较小者的 {tx * ty / t_small:.0%}),文字会叠在一起。")
                        else:
                            add("提示", where, f"「{a[5]}」和「{b[5]}」的框有重叠,但文字区域估算没有叠在一起;角标、标签压在卡片上是正常做法,看一眼确认即可。")
        if not has_title:
            add("提示", where, "这一页没有标题(大纲视图和导航里会显示为空)。")

    if missing_ea:
        add("注意", "字体", f"{missing_ea} 处中文没有指定中文字体(如「{first_missing}」),PowerPoint 会按系统挑字体。"
            "统一设置: python check_pptx.py 文件 --fix-fonts 微软雅黑")
    for face, count in used_ea.items():
        if not office_env.has_font(face):
            add("提示", "字体", f"中文字体「{face}」没有装在这台电脑上({count} 处使用);装了该字体的电脑上显示正常,这台电脑上会显示成替代字体。")

    order = {"错误": 0, "注意": 1, "提示": 2}
    issues.sort(key=lambda x: order[x[0]])
    return 0, issues, len(prs.slides)


def fix_fonts(path, font):
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    prs = Presentation(path)
    count = 0
    ea_after = {"ln", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "effectLst", "effectDag",
                "highlight", "uLnTx", "uLn", "uFillTx", "uFill", "latin"}

    theme_font = theme_ea_font(prs)

    def fix_run(r):
        nonlocal count
        if theme_font and (r._r.find(f"{qn('a:rPr')}/{qn('a:ea')}") is None):
            return              # the template's theme already names a Chinese font: keep it
        rpr = r._r.get_or_add_rPr()
        ea = rpr.find(qn("a:ea"))
        if ea is not None:
            if not ea.get("typeface"):
                ea.set("typeface", font)
                count += 1
            return
        from lxml import etree
        el = etree.SubElement(rpr, qn("a:ea"))
        el.set("typeface", font)
        rpr.remove(el)
        pos = 0
        for i, child in enumerate(rpr):
            if etree.QName(child).localname in ea_after:
                pos = i + 1
        rpr.insert(pos, el)
        count += 1

    def fix_frame(tf):
        for para in tf.paragraphs:
            for r in para.runs:
                if r.text and CJK.search(r.text):
                    fix_run(r)

    for slide in prs.slides:
        for shape in walk(slide.shapes):
            if shape.has_text_frame:
                fix_frame(shape.text_frame)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        fix_frame(cell.text_frame)
    # theme fonts: placeholders and new text boxes inherit from here
    for master in prs.slide_masters:
        theme = master.part.part_related_by(RT.THEME)
        blob = theme.blob.decode("utf-8")
        has_hans = re.search(r'<a:font script="Hans" typeface="[^"]+"', blob) is not None
        new = blob if has_hans else re.sub(r'<a:ea typeface=""\s*/>', f'<a:ea typeface="{font}"/>', blob)
        if new != blob:
            theme._blob = new.encode("utf-8")
            count += 1
    prs.save(path)
    return count


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Check a .pptx before delivery")
    ap.add_argument("file")
    ap.add_argument("--fix-fonts", metavar="FONT", help="set this Chinese font on the theme and on runs lacking one (edits the file)")
    a = ap.parse_args()
    if not os.path.isfile(a.file):
        print(f"找不到文件: {a.file}")
        return 2
    if a.fix_fonts:
        print(f"已设置中文字体「{a.fix_fonts}」({fix_fonts(a.file, a.fix_fonts)} 处)。")
    res = check(a.file)
    if res[0]:
        return res[0]
    _code, issues, slides = res
    print(f"文件: {os.path.basename(a.file)}  共 {slides} 页")
    for level, where, msg in issues[:60]:
        print(f"[{level}] {where}  {msg}")
    if len(issues) > 60:
        print(f"... 还有 {len(issues) - 60} 条未列出")
    if not issues:
        print("没有发现问题。")
    print("文字是否放得下是按字数估算的,不等于 PowerPoint/WPS 里的实际效果。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
