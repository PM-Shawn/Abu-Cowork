#!/usr/bin/env python3
"""Fill a PDF form: set AcroForm field values and/or draw text on the page.

    python pdf_form_fill.py in.pdf values.json out.pdf [--password PW]

values.json is a list. Each entry is one of
  field entry   {"id": "<id from pdf_form_inspect.py>", "value": ..., "page": 1 (optional)}
                text -> string; checkbox -> its on_state / off_state name (or true / false);
                radio -> one of the buttons' export_value; dropdown/list -> a listed value (or its display text);
                "" clears the field.
  placed text   {"page": 1, "box": [left, bottom, right, top], "text": "...", "size": 11 (default),
                 "fit": true (shrink to the box width, floor 6 pt), "align": "left|center|right",
                 "color": "#rrggbb"}
  tick mark     {"page": 1, "box": [...], "tick": "check" | "cross"}
Boxes are in the displayed-page point space that pdf_form_inspect.py reports (origin bottom-left, rotation and
crop box already applied). Placed text is ordinary page content. Everything is validated first; if any entry is
invalid nothing is written and the exit status is 1. The output is a new file; the input is never changed.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_form_common import (FF_COMB, FF_COMBO, FF_EDIT, FF_MULTILINE, FF_MULTISELECT, FF_PASSWORD, FF_READONLY,  # noqa: E402
                             PageGeometry, UserError, button_states, choice_options, collect_fields,
                             current_value, name_of, open_reader, page_index_of_widgets, r1)

MAX_ERROR_LINES = 20
MIN_FIT_SIZE = 6.0
EDGE_TOLERANCE = 0.5
COLORS = {"black": "#000000", "blue": "#0000cc", "red": "#cc0000", "green": "#006600", "white": "#ffffff"}


def latin(text: str) -> bool:
    try:
        text.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


# ---------------------------------------------------------------------------------------------------------
# placed text
# ---------------------------------------------------------------------------------------------------------

_cjk_font: list = []   # [name] once looked up; [None, reason] when unavailable


def cjk_font():
    if not _cjk_font:
        import office_env
        if office_env.pick_font("sans") is None and office_env.pick_font("serif") is None:
            _cjk_font.extend([None, "no Chinese font is installed on this machine, so Chinese text cannot be drawn"])
        else:
            _cjk_font.append(office_env.register_reportlab_cjk())
    return _cjk_font[0], (_cjk_font[1] if len(_cjk_font) > 1 else None)


def font_for(text: str):
    """(font name, error). Latin text uses Helvetica; anything else needs the embedded CJK font."""
    if latin(text):
        return "Helvetica", None
    name, why = cjk_font()
    if name is None:
        return None, why
    if name == "CJK":
        from reportlab.pdfbase import pdfmetrics
        cmap = getattr(pdfmetrics.getFont("CJK").face, "charToGlyph", {})
        missing = sorted({c for c in text if ord(c) > 32 and ord(c) not in cmap})
        if missing:
            return None, f"the Chinese font has no glyph for {''.join(missing[:8])!r}"
    return name, None


def parse_color(value):
    from reportlab.lib.colors import Color
    if value is None:
        return Color(0, 0, 0)
    if isinstance(value, str):
        value = COLORS.get(value.lower(), value)
        m = re.fullmatch(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})", value)
        if not m:
            raise ValueError("color must be like \"#1a2b3c\" or black/blue/red/green/white")
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return Color(*(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)))
    if isinstance(value, list) and len(value) == 3 and all(isinstance(v, (int, float)) for v in value):
        scale = 255 if max(value) > 1 else 1
        return Color(*(v / scale for v in value))
    raise ValueError("color must be like \"#1a2b3c\"")


def overlap(a, b) -> bool:
    return min(a[2], b[2]) - max(a[0], b[0]) > 0.01 and min(a[3], b[3]) - max(a[1], b[1]) > 0.01


def check_placed(n, entry, geoms, errs):
    """Validate a placed-text or tick entry. Returns a dict ready for drawing, or None."""
    label = f"entry {n}"
    page = entry.get("page")
    if not isinstance(page, int) or isinstance(page, bool) or not 1 <= page <= len(geoms):
        errs.append(f"{label}: page must be a number from 1 to {len(geoms)}")
        return None
    g = geoms[page - 1]
    box = entry.get("box")
    if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in box)):
        errs.append(f"{label} (page {page}): box must be [left, bottom, right, top] in points")
        return None
    l, b, r, t = (float(v) for v in box)
    if r <= l or t <= b:
        errs.append(f"{label} (page {page}): box {box} must have right > left and top > bottom")
        return None
    if l < -EDGE_TOLERANCE or b < -EDGE_TOLERANCE or r > g.width + EDGE_TOLERANCE or t > g.height + EDGE_TOLERANCE:
        errs.append(f"{label} (page {page}): box {box} is outside the page ({r1(g.width)} x {r1(g.height)} pt displayed)")
        return None
    try:
        color = parse_color(entry.get("color", entry.get("colour")))
    except ValueError as exc:
        errs.append(f"{label}: {exc}")
        return None
    out = {"n": n, "page": page, "box": [l, b, r, t], "color": color}
    tick = entry.get("tick")
    if tick is not None:
        if tick not in ("check", "cross"):
            errs.append(f"{label}: tick must be \"check\" or \"cross\"")
            return None
        out["tick"] = tick
        return out
    text = entry.get("text")
    if not isinstance(text, str) or text == "":
        errs.append(f"{label}: placed text needs a non-empty \"text\" (or a \"tick\")")
        return None
    if "\n" in text:
        errs.append(f"{label}: placed text is one line; split it into one entry per line, each with its own box")
        return None
    size = entry.get("size", 11)
    if not isinstance(size, (int, float)) or isinstance(size, bool) or size <= 0:
        errs.append(f"{label}: size must be a positive number")
        return None
    size = float(size)
    align = entry.get("align", "left")
    if align not in ("left", "center", "right"):
        errs.append(f"{label}: align must be left, center or right")
        return None
    font, why = font_for(text)
    if font is None:
        errs.append(f"{label}: {why}")
        return None
    from reportlab.pdfbase import pdfmetrics
    width = r - l
    tw = pdfmetrics.stringWidth(text, font, size)
    if tw > width:
        if entry.get("fit"):
            while size > MIN_FIT_SIZE and pdfmetrics.stringWidth(text, font, size) > width:
                size = max(MIN_FIT_SIZE, size - 0.25)
            tw = pdfmetrics.stringWidth(text, font, size)
            if tw > width + 0.01:
                errs.append(f"{label} (page {page}): text needs {r1(tw)} pt at the smallest size ({MIN_FIT_SIZE:g} pt) "
                            f"but the box is {r1(width)} pt wide; widen the box or shorten the text")
                return None
        else:
            errs.append(f"{label} (page {page}): text is {r1(tw)} pt wide at size {size:g}, box is {r1(width)} pt; "
                        f"widen the box, lower \"size\" or set \"fit\": true")
            return None
    if (t - b) + 1e-6 < size:
        errs.append(f"{label} (page {page}): box is {r1(t - b)} pt high, smaller than the font size {size:g}")
        return None
    out.update(text=text, size=size, align=align, font=font, width=tw)
    return out


def draw_overlay(page_entries, g):
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(g.width, g.height))
    for e in page_entries:
        l, b, r, t = e["box"]
        c.setFillColor(e["color"])
        c.setStrokeColor(e["color"])
        if "tick" in e:
            side = min(r - l, t - b) * 0.72
            cx, cy = (l + r) / 2, (b + t) / 2
            c.setLineWidth(max(0.8, side * 0.14))
            c.setLineCap(1)
            c.setLineJoin(1)
            p = c.beginPath()
            if e["tick"] == "check":
                p.moveTo(cx - side * 0.45, cy - side * 0.02)
                p.lineTo(cx - side * 0.12, cy - side * 0.4)
                p.lineTo(cx + side * 0.5, cy + side * 0.42)
            else:
                p.moveTo(cx - side / 2, cy - side / 2)
                p.lineTo(cx + side / 2, cy + side / 2)
                p.moveTo(cx - side / 2, cy + side / 2)
                p.lineTo(cx + side / 2, cy - side / 2)
            c.drawPath(p, stroke=1, fill=0)
            continue
        size = e["size"]
        if e["align"] == "left":
            x = l
        elif e["align"] == "center":
            x = (l + r) / 2 - e["width"] / 2
        else:
            x = r - e["width"]
        h = t - b
        if e["font"] == "Helvetica":
            y = b + (h - size * 0.72) / 2
        else:
            y = b + (h - size) / 2 + size * 0.12
        c.setFont(e["font"], size)
        c.drawString(x, y, e["text"])
    c.showPage()
    c.save()
    buf.seek(0)
    return buf


# ---------------------------------------------------------------------------------------------------------
# field entries: validation
# ---------------------------------------------------------------------------------------------------------

def _choices(items, limit=12):
    items = list(items)
    shown = ", ".join(items[:limit])
    return shown + (f", ... ({len(items)} in all)" if len(items) > limit else "")


def check_field(n, entry, field, pages_of_field, errs):
    """Validate one field entry against its field. Returns an action tuple or None."""
    label = f"entry {n} / id {field.name}"
    if "value" not in entry:
        errs.append(f"{label}: no \"value\"")
        return None
    page = entry.get("page")
    if page is not None and page not in pages_of_field:
        errs.append(f"{label}: the field is on page {', '.join(str(p) for p in sorted(pages_of_field)) or '(none)'}, not page {page}")
        return None
    if field.kind not in ("text", "checkbox", "radio", "choice"):
        errs.append(f"{label}: a {field.kind} field cannot be filled; use a placed-text entry if text must appear there")
        return None
    if field.flags & FF_READONLY:
        errs.append(f"{label}: the field is read-only")
        return None
    value = entry["value"]
    if field.kind == "text":
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        if not isinstance(value, str):
            errs.append(f"{label}: value must be a string")
            return None
        if "\n" in value.replace("\r\n", "\n") and not field.flags & FF_MULTILINE:
            errs.append(f"{label}: the field is single-line; remove the line breaks")
            return None
        maxlen = field.attr("/MaxLen")
        if maxlen is not None and int(maxlen) > 0 and len(value) > int(maxlen):
            errs.append(f"{label}: {len(value)} characters but the field holds at most {int(maxlen)}"
                        + ("; it is a comb field with one cell per character" if field.flags & FF_COMB else ""))
            return None
        return ("text", value.replace("\r\n", "\n"))
    if field.kind == "checkbox":
        states = []
        for w in field.widgets:
            states += [s for s in button_states(w) if s not in states]
        on = states[0] if states else "Yes"
        if value is True:
            return ("check", on)
        if value is False:
            return ("check", "Off")
        if isinstance(value, str):
            v = name_of(value)
            if v == "Off" or v == "":
                return ("check", "Off")
            if v in states or (not states and v == "Yes"):
                return ("check", v)
        errs.append(f"{label}: {value!r} is not a state of this checkbox; valid choices: {_choices([*(states or ['Yes']), 'Off'])} (or true / false)")
        return None
    if field.kind == "radio":
        exports = []
        for w in field.widgets:
            exports += [s for s in button_states(w) if s not in exports]
        if value == "" or value is None:
            return ("radio", "Off")
        v = name_of(value) if isinstance(value, str) else None
        if v == "Off":
            return ("radio", "Off")
        if v in exports:
            return ("radio", v)
        errs.append(f"{label}: {value!r} is not a button of this radio group; valid choices: {_choices(exports) or '(none found)'}")
        return None
    # choice
    options = choice_options(field)
    multi = bool(field.flags & FF_MULTISELECT)
    values = value if isinstance(value, list) else [value]
    if isinstance(value, list) and not multi:
        errs.append(f"{label}: this is not a multi-select field; give one value")
        return None
    resolved = []
    for item in values:
        if not isinstance(item, str):
            errs.append(f"{label}: value must be a string")
            return None
        if item == "":
            continue
        by_value = [v for v, _ in options if v == item]
        by_text = [v for v, t in options if t == item]
        if by_value:
            resolved.append(by_value[0])
        elif len(set(by_text)) == 1:
            resolved.append(by_text[0])
        elif len(set(by_text)) > 1:
            errs.append(f"{label}: display text {item!r} matches several options; use one of the values: {_choices(v for v, _ in options)}")
            return None
        elif field.flags & FF_COMBO and field.flags & FF_EDIT:
            resolved.append(item)    # an editable dropdown accepts free text
        else:
            shown = [v if v == t else f"{v} ({t})" for v, t in options]
            errs.append(f"{label}: {item!r} is not an allowed value; valid choices: {_choices(shown) or '(the field lists no options)'}")
            return None
    return ("choice", resolved if multi else (resolved[0] if resolved else ""))


# ---------------------------------------------------------------------------------------------------------
# field entries: applying
# ---------------------------------------------------------------------------------------------------------

def _pdf_literal(text: str) -> bytes:
    raw = text.encode("cp1252")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


def _color_ops(arr, stroke=False):
    vals = [float(x) for x in arr]
    op = {1: "g", 3: "rg", 4: "k"}.get(len(vals))
    if op is None:
        return ""
    if stroke:
        op = op.upper()
    return " ".join(f"{v:.3f}" for v in vals) + " " + op + " "


def _wrap(text, font, size, width):
    from reportlab.pdfbase import pdfmetrics
    lines = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split(" "):
            trial = word if not cur else cur + " " + word
            if cur and pdfmetrics.stringWidth(trial, font, size) > width:
                lines.append(cur)
                cur = word
            else:
                cur = trial
        lines.append(cur)
    return lines


def build_appearance(writer, acro, field, widget, shown, selected_texts=None):
    """Replace the widget's normal appearance with one that shows `shown` (text and dropdown fields).
    Returns a warning string or None."""
    from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
                               NumberObject)
    from reportlab.pdfbase import pdfmetrics

    x0, y0, x1, y1 = (float(v) for v in widget["/Rect"])
    w, h = abs(x1 - x0), abs(y1 - y0)
    da = str(field.attr("/DA") or acro.get("/DA") or "/Helv 0 Tf 0 g")
    m = re.search(r"/(\S+)\s+([\d.]+)\s+Tf", da)
    fname, size = (m.group(1), float(m.group(2))) if m else ("Helv", 0.0)
    colour = (da[:m.start()] + da[m.end():]).strip() if m else "0 g"
    colour = (colour + " ") if colour else "0 g "
    q = int(field.attr("/Q") or acro.get("/Q") or 0)
    mk = widget.get("/MK")
    mk = mk.get_object() if mk is not None else {}
    bs = widget.get("/BS")
    bs = bs.get_object() if bs is not None else {}
    bw = float(bs.get("/W", 1)) if mk.get("/BC") is not None else 0.0
    parts = []
    if mk.get("/BG") is not None:
        parts.append(f"q {_color_ops(mk['/BG'])}0 0 {w:.2f} {h:.2f} re f Q")
    if mk.get("/BC") is not None and bw > 0:
        parts.append(f"q {bw:.2f} w {_color_ops(mk['/BC'], True)}")
        if str(bs.get("/S", "/S")) == "/U":
            parts.append(f"0 {bw / 2:.2f} m {w:.2f} {bw / 2:.2f} l S Q")
        else:
            parts.append(f"{bw / 2:.2f} {bw / 2:.2f} {w - bw:.2f} {h - bw:.2f} re S Q")
    warning = None
    flags = field.flags
    is_list = field.kind == "choice" and not flags & FF_COMBO
    multiline = field.kind == "text" and bool(flags & FF_MULTILINE)
    text = shown
    if field.kind == "text" and flags & FF_PASSWORD:
        text = "*" * len(text)
    metric = "Helvetica"
    body = []
    if is_list:
        size = size or 12.0
        row = size * 1.2
        texts = [t for _, t in choice_options(field)]
        y = h - bw
        for t in texts:
            if y - row < 0:
                break
            if t in (selected_texts or []):
                body.append(f"q 0.6 0.75 0.85 rg {bw:.2f} {y - row:.2f} {w - 2 * bw:.2f} {row:.2f} re f Q")
            body.append(f"BT {colour}/{fname} {size:g} Tf 1 0 0 1 {2 + bw:.2f} {y - row + size * 0.28:.2f} Tm {_pdf_literal(t).decode('latin-1')} Tj ET")
            y -= row
    elif multiline:
        size = size or 12.0
        lines = _wrap(text, metric, size, w - 4 - 2 * bw)
        lead = size * 1.15
        y = h - bw - 2 - size * 0.9
        for line in lines:
            tw = pdfmetrics.stringWidth(line, metric, size)
            x = 2 + bw if q == 0 else ((w - tw) / 2 if q == 1 else w - 2 - bw - tw)
            body.append(f"BT {colour}/{fname} {size:g} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm {_pdf_literal(line).decode('latin-1')} Tj ET")
            y -= lead
        if y + lead < 0:
            warning = "text is longer than the box and is cut off in the field"
    else:
        if not size:
            size = min(12.0, max(4.0, (h - 2 * bw) * 0.78))
            while size > 4 and pdfmetrics.stringWidth(text, metric, size) > w - 4 - 2 * bw:
                size -= 0.5
        tw = pdfmetrics.stringWidth(text, metric, size)
        if tw > w - 4 - 2 * bw:
            warning = "text is wider than the field and is cut off"
        y = (h - size) / 2 + size * 0.22
        maxlen = field.attr("/MaxLen")
        if flags & FF_COMB and maxlen and int(maxlen) > 0 and field.kind == "text":
            cell = w / int(maxlen)
            for i, ch in enumerate(text[:int(maxlen)]):
                cw = pdfmetrics.stringWidth(ch, metric, size)
                body.append(f"BT {colour}/{fname} {size:g} Tf 1 0 0 1 {cell * i + (cell - cw) / 2:.2f} {y:.2f} Tm {_pdf_literal(ch).decode('latin-1')} Tj ET")
        else:
            x = 2 + bw if q == 0 else ((w - tw) / 2 if q == 1 else w - 2 - bw - tw)
            body.append(f"BT {colour}/{fname} {size:g} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm {_pdf_literal(text).decode('latin-1')} Tj ET")
    if body:
        parts.append(f"/Tx BMC q {bw + 0.5:.2f} {bw + 0.5:.2f} {w - 2 * bw - 1:.2f} {h - 2 * bw - 1:.2f} re W n " + " ".join(body) + " Q EMC")
    stream = DecodedStreamObject()
    stream.set_data("\n".join(parts).encode("latin-1"))
    # font resource: the form's own font if it has one under this name, else plain Helvetica
    font_ref = None
    dr = acro.get("/DR")
    if dr is not None and dr.get_object().get("/Font") is not None:
        fonts = dr.get_object()["/Font"].get_object()
        if fname in fonts or "/" + fname in fonts:
            font_ref = fonts.raw_get(fname if fname in fonts else "/" + fname)
    if font_ref is None:
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                                 NameObject("/BaseFont"): NameObject("/Helvetica"),
                                 NameObject("/Encoding"): NameObject("/WinAnsiEncoding")})
        font_ref = writer._add_object(font)
    stream.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
                   NameObject("/BBox"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(w), FloatObject(h)]),
                   NameObject("/Resources"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/" + fname): font_ref})})})
    ref = writer._add_object(stream)
    ap = widget.get("/AP")
    ap = ap.get_object() if ap is not None else DictionaryObject()
    ap[NameObject("/N")] = ref
    widget[NameObject("/AP")] = ap
    return warning


def apply_field(writer, acro, field, action, notes):
    from pypdf.generic import ArrayObject, BooleanObject, NameObject, NumberObject, TextStringObject

    kind, val = action
    targets = [*field.nodes, *[w for w in field.widgets if "/V" in w]]
    if kind == "text" or kind == "choice":
        vals = val if isinstance(val, list) else [val]
        if kind == "choice" and isinstance(val, list):
            v_obj = ArrayObject([TextStringObject(x) for x in val])
        else:
            v_obj = TextStringObject(val)
        for t in targets:
            t[NameObject("/V")] = v_obj
            if kind == "choice" and "/I" in t:
                del t["/I"]
        if kind == "choice":
            opts = choice_options(field)
            idx = sorted(i for i, (v, _) in enumerate(opts) if v in vals)
            if idx:
                for t in targets:
                    t[NameObject("/I")] = ArrayObject([NumberObject(i) for i in idx])
            shown = ", ".join(next((t for v, t in opts if v == x), x) for x in vals)
            selected = [next((t for v, t in opts if v == x), x) for x in vals]
        else:
            shown, selected = val, None
        if not latin(shown):
            acro[NameObject("/NeedAppearances")] = BooleanObject(True)
            notes.append(f"{field.name}: contains non-Latin text; form fonts cannot draw it, so the appearance is left to the "
                         f"viewer. Render to check; if it shows blank, use a placed-text entry over the field rectangle")
            return
        for w in field.widgets:
            warn = build_appearance(writer, acro, field, w, shown, selected)
            if warn:
                notes.append(f"{field.name}: {warn}")
        return
    if kind == "check":
        for t in targets:
            t[NameObject("/V")] = NameObject("/" + val)
        for w in field.widgets:
            states = button_states(w)
            w[NameObject("/AS")] = NameObject("/" + (val if (val == "Off" or val in states or not states) else "Off"))
        return
    if kind == "radio":
        for t in targets:
            t[NameObject("/V")] = NameObject("/" + val)
        for w in field.widgets:
            w[NameObject("/AS")] = NameObject("/" + (val if val in button_states(w) else "Off"))


# ---------------------------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------------------------

def report_errors(errs):
    for line in errs[:MAX_ERROR_LINES]:
        print(line)
    if len(errs) > MAX_ERROR_LINES:
        print(f"... and {len(errs) - MAX_ERROR_LINES} more problems")
    print("Nothing was written; fix the entries above and run again.")


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("values_json")
    ap.add_argument("out_pdf")
    ap.add_argument("--password")
    a = ap.parse_args(argv)
    try:
        if os.path.abspath(a.pdf) == os.path.abspath(a.out_pdf) or (os.path.exists(a.out_pdf) and os.path.samefile(a.pdf, a.out_pdf)):
            raise UserError("the output must be a new file, not the input PDF.")
        try:
            with open(a.values_json, encoding="utf-8") as fh:
                entries = json.load(fh)
        except (OSError, ValueError) as exc:
            raise UserError(f"{a.values_json}: cannot read the values file as JSON ({exc}).") from None
        if not isinstance(entries, list) or not entries:
            raise UserError(f"{a.values_json}: must be a non-empty JSON list of entries.")
        reader = open_reader(a.pdf, a.password)
        geoms = [PageGeometry(p) for p in reader.pages]
        fields, acro = collect_fields(reader)
        by_name = {f.name: f for f in fields}
        where = page_index_of_widgets(reader)
        errs: list[str] = []
        plan = []        # (n, kind, payload)
        placed_by_page: dict[int, list] = {}
        for n, entry in enumerate(entries, 1):
            if not isinstance(entry, dict):
                errs.append(f"entry {n}: must be an object")
                continue
            has_id = "id" in entry
            has_box = "box" in entry or "tick" in entry or "text" in entry
            if has_id and has_box:
                errs.append(f"entry {n}: has both \"id\" and placed-text keys; use one entry kind")
                continue
            if has_id:
                field = by_name.get(entry["id"]) if isinstance(entry["id"], str) else None
                if field is None:
                    errs.append(f"entry {n} / id {entry['id']}: no such field; ids in this file: "
                                f"{_choices(by_name) or '(the PDF has no form fields)'}")
                    continue
                pages = {where[id(w)] + 1 for w in field.widgets if id(w) in where}
                action = check_field(n, entry, field, pages, errs)
                if action:
                    plan.append((n, "field", (field, action)))
            else:
                placed = check_placed(n, entry, geoms, errs)
                if placed:
                    for other in placed_by_page.get(placed["page"], []):
                        if overlap(other["box"], placed["box"]):
                            errs.append(f"entry {n} / entry {other['n']}: boxes overlap on page {placed['page']}")
                    placed_by_page.setdefault(placed["page"], []).append(placed)
                    plan.append((n, "placed", placed))
        if errs:
            report_errors(errs)
            return 1

        from pypdf import PdfWriter, Transformation
        from pypdf.generic import NameObject
        writer = PdfWriter(clone_from=reader)
        wfields, wacro = collect_fields(writer)
        wby = {f.name: f for f in wfields}
        notes: list[str] = []
        if wacro is not None and wacro != {} and any(f.kind == "signature" and current_value(f) for f in wfields):
            notes.append("the file is digitally signed; this change invalidates the signature")
        for n, kind, payload in plan:
            if kind == "field":
                apply_field(writer, wacro, wby[payload[0].name], payload[1], notes)
        for page_no, items in placed_by_page.items():
            g = geoms[page_no - 1]
            overlay = open_overlay(draw_overlay(items, g))
            writer.pages[page_no - 1].merge_transformed_page(overlay, Transformation(ctm=g.overlay_matrix()))
        with open(a.out_pdf, "wb") as fh:
            writer.write(fh)
    except UserError as exc:
        print(f"error: {exc}")
        return 2

    # read the output back and say what each entry now holds
    out_reader = open_reader(a.out_pdf)
    out_fields = {f.name: f for f in collect_fields(out_reader)[0]}
    print(f"Wrote {a.out_pdf}")
    for n, kind, payload in plan:
        if kind == "field":
            now = current_value(out_fields[payload[0].name])
            print(f"entry {n} / id {payload[0].name}: now {now!r}")
        elif "tick" in payload:
            print(f"entry {n}: {payload['tick']} mark drawn on page {payload['page']} at box {[r1(v) for v in payload['box']]}")
        else:
            print(f"entry {n}: drawn on page {payload['page']} at box {[r1(v) for v in payload['box']]} "
                  f"(size {payload['size']:g}, font {payload['font']})")
    for note in notes:
        print(f"NOTE: {note}")
    if a.password is not None or reader.is_encrypted:
        print("NOTE: the output is not password protected.")
    untouched = [f.name for f in fields if f.kind in ("text", "checkbox", "radio", "choice")
                 and f.name not in {p[0].name for _, k, p in plan if k == "field"} and not current_value(f)]
    if untouched:
        print(f"Fields left blank ({len(untouched)}): {_choices(untouched, 25)}")
    return 0


def open_overlay(buf):
    from pypdf import PdfReader
    return PdfReader(buf).pages[0]


if __name__ == "__main__":
    sys.exit(main())
