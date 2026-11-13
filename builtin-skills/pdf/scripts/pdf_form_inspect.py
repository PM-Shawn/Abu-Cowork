#!/usr/bin/env python3
"""Describe a PDF so a form can be filled: page geometry, form fields, or (for flat PDFs) text, rules and boxes.

    python pdf_form_inspect.py in.pdf out.json [--password PW] [--content]

Writes one JSON document to out.json and prints a short summary. Every coordinate is in points in
"displayed space": origin at the bottom-left of the page as a person sees it (crop box and /Rotate already
applied), boxes as [left, bottom, right, top]. pdf_form_fill.py takes the same space, so no conversion is needed.
--content adds the page text/rules/boxes listing even when the PDF has fields.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_form_common import (FF_COMB, FF_COMBO, FF_MULTILINE, FF_MULTISELECT, FF_PASSWORD, FF_READONLY,  # noqa: E402
                             PageGeometry, UserError, button_states, choice_options, collect_fields,
                             current_value, name_of, open_reader, page_index_of_widgets, r1)

COORDS = ("points; origin at the bottom-left of the page as displayed (after crop box and rotation); "
          "boxes are [left, bottom, right, top]")
KIND_LABEL = {"text": "text", "checkbox": "checkbox", "radio": "radio group", "choice": "dropdown/list",
              "button": "push button", "signature": "signature", "other": "other"}
MAX_ITEMS = 400


def describe_fields(reader, geoms):
    fields, acro = collect_fields(reader)
    where = page_index_of_widgets(reader)
    out = []
    for f in fields:
        widgets = []
        for w in f.widgets:
            idx = where.get(id(w))
            if idx is None and w.get("/P") is not None:
                try:
                    idx = next((i for i, p in enumerate(reader.pages) if p.indirect_reference == w["/P"].indirect_reference), None)
                except Exception:
                    idx = None
            rect = w.get("/Rect")
            if idx is None or rect is None:
                continue
            box = [r1(v) for v in geoms[idx].rect_to_display(rect)]
            widgets.append({"page": idx + 1, "rect": box, "_w": w})
        entry = {"id": f.name, "type": KIND_LABEL[f.kind], "fillable": f.kind in ("text", "checkbox", "radio", "choice"),
                 "page": widgets[0]["page"] if widgets else None, "rect": widgets[0]["rect"] if widgets else None,
                 "current_value": current_value(f)}
        if not widgets:
            entry["unlocatable"] = True
            entry["note"] = "no widget on any page: it has no position and cannot be seen; use a placed-text entry if it matters"
        elif len(widgets) > 1 and f.kind != "radio":
            entry["widgets"] = [{"page": x["page"], "rect": x["rect"]} for x in widgets]
        flags = f.flags
        if flags & FF_READONLY:
            entry["read_only"] = True
            entry["fillable"] = False
        if f.kind == "text":
            entry["multiline"] = bool(flags & FF_MULTILINE)
            entry["password"] = bool(flags & FF_PASSWORD)
            maxlen = f.attr("/MaxLen")
            if maxlen is not None:
                entry["max_length"] = int(maxlen)
            if flags & FF_COMB:
                entry["comb"] = True
        elif f.kind == "checkbox":
            states = []
            for w in f.widgets:
                states += [s for s in button_states(w) if s not in states]
            entry["on_state"] = states[0] if states else None
            entry["off_state"] = "Off"
            if len(states) > 1:
                entry["other_on_states"] = states[1:]
            if not states:
                entry["note"] = "no appearance stream names an on-state; true will use 'Yes'"
        elif f.kind == "radio":
            buttons = []
            for x in widgets:
                st = button_states(x["_w"])
                buttons.append({"export_value": st[0] if st else None, "page": x["page"], "rect": x["rect"]})
            entry["buttons"] = buttons
        elif f.kind == "choice":
            entry["options"] = [{"value": v, "text": t} for v, t in choice_options(f)]
            entry["combo"] = bool(flags & FF_COMBO)
            entry["multi_select"] = bool(flags & FF_MULTISELECT)
        out.append(entry)

    def key(e):
        if e["page"] is None:
            return (10 ** 6, 0, 0, e["id"])
        r = e["rect"]
        return (e["page"], -round((r[1] + r[3]) / 2 / 6), r[0], e["id"])
    out.sort(key=key)
    return out, acro


def page_content(path, password, geoms):
    import pdfplumber

    pages = []
    with pdfplumber.open(path, password=password or "") as pdf:
        for i, page in enumerate(pdf.pages):
            g = geoms[i]
            # pdfplumber reports the displayed media box with a top-left origin; shift it to the visible box
            cx, cy, frame_h = g.media_frame_offset()

            def conv(x0, top, x1, bottom):
                return [r1(x0 - cx), r1(frame_h - bottom - cy), r1(x1 - cx), r1(frame_h - top - cy)]
            words = page.extract_words(keep_blank_chars=False, use_text_flow=False)
            rules, seen = [], set()
            edges = [e for e in page.edges if e["orientation"] == "h" and (e["x1"] - e["x0"]) >= 20]
            for e in edges:
                b = conv(e["x0"], e["top"], e["x1"], e["top"])
                k = (round(b[0]), round(b[1]), round(b[2]))
                if k not in seen:
                    seen.add(k)
                    rules.append({"left": b[0], "right": b[2], "y": b[1]})
            boxes = []
            for rc in page.rects:
                w, h = rc["x1"] - rc["x0"], rc["bottom"] - rc["top"]
                if 4 <= w <= 30 and 4 <= h <= 30 and 0.7 <= w / h <= 1.43:
                    boxes.append({"box": conv(rc["x0"], rc["top"], rc["x1"], rc["bottom"])})
            rules.sort(key=lambda r: (-r["y"], r["left"]))
            boxes.sort(key=lambda r: (-r["box"][3], r["box"][0]))
            entry = {"page": i + 1, "has_text_layer": bool(page.chars), "images": len(page.images),
                     "words": [{"text": w["text"][::-1] if g.rotation in (180, 270) else w["text"], "box": conv(w["x0"], w["top"], w["x1"], w["bottom"])} for w in words[:MAX_ITEMS * 5]],
                     "rules": rules[:MAX_ITEMS], "small_boxes": boxes[:MAX_ITEMS]}
            if not entry["has_text_layer"]:
                entry["note"] = ("no text layer (scanned page): work from the rendered page image only; "
                                 "pixel = point * dpi / 72, y flipped")
            pages.append(entry)
    return pages


def main(argv=None) -> int:
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("out_json")
    ap.add_argument("--password")
    ap.add_argument("--content", action="store_true")
    a = ap.parse_args(argv)
    try:
        reader = open_reader(a.pdf, a.password)
        geoms = [PageGeometry(p) for p in reader.pages]
        fields, acro = describe_fields(reader, geoms)
        for e in fields:
            for w in e.get("widgets", []):
                w.pop("_w", None)
        warnings = []
        signed = any(e["type"] == "signature" and e["current_value"] for e in fields)
        if signed:
            warnings.append("the file carries a digital signature; filling it will invalidate the signature")
        if "/XFA" in acro:
            warnings.append("the form also has XFA data; only the AcroForm fields listed here are filled" if fields
                            else "XFA-only form: there are no AcroForm fields to fill; use placed-text entries")
        doc = {"file": os.path.basename(a.pdf), "encrypted": bool(reader.is_encrypted), "signed": signed,
               "xfa": "/XFA" in acro, "warnings": warnings, "coordinate_system": COORDS,
               "pages": [{"page": i + 1, "width": r1(g.width), "height": r1(g.height), "rotation": g.rotation,
                          "box_origin_nonzero": g.origin_offset} for i, g in enumerate(geoms)],
               "has_fields": bool(fields), "fields": fields}
        if not fields or a.content:
            doc["page_content"] = page_content(a.pdf, a.password, geoms)
        with open(a.out_json, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1)
    except UserError as exc:
        print(f"error: {exc}")
        return 2
    print(f"{doc['file']}: {len(geoms)} page(s); coordinates: {COORDS}")
    for p in doc["pages"]:
        print(f"  page {p['page']}: {p['width']} x {p['height']} pt, rotation {p['rotation']}"
              + (", page box origin not (0,0)" if p["box_origin_nonzero"] else ""))
    for w in warnings:
        print(f"WARNING: {w}")
    if fields:
        print(f"{len(fields)} form field(s):")
        for e in fields[:60]:
            where = f"page {e['page']}" if e["page"] else "no page (unlocatable)"
            extra = "" if e["fillable"] else "  [not fillable]"
            print(f"  {e['id']}  {e['type']}  {where}  value={e['current_value']!r}{extra}")
        if len(fields) > 60:
            print(f"  ... {len(fields) - 60} more in the JSON")
    else:
        print("No form fields: place text with entries that have page + box (see pdf_form_fill.py).")
        for pc in doc["page_content"]:
            print(f"  page {pc['page']}: {len(pc['words'])} words, {len(pc['rules'])} rules, "
                  f"{len(pc['small_boxes'])} small boxes" + ("; NO TEXT LAYER (scan)" if not pc["has_text_layer"] else ""))
    print(f"Details written to {a.out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
