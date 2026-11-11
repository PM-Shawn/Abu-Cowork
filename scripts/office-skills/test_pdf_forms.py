"""Tests for builtin-skills/pdf/scripts/pdf_form_inspect.py and pdf_form_fill.py.

Run with the bundled Python (pypdf, pdfplumber, pypdfium2, reportlab, Pillow). Each test builds its own
synthetic PDFs: fillable forms (text, multiline, comb, checkbox with a non-standard on-state, radio group,
dropdown with value/text pairs, nested and shared fields) and flat pages (plain, rotated, offset crop box).
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "builtin-skills", "pdf", "scripts"))
INSPECT = os.path.join(ROOT, "pdf_form_inspect.py")
FILL = os.path.join(ROOT, "pdf_form_fill.py")
sys.path.insert(0, ROOT)


def run(script, *args):
    proc = subprocess.run([sys.executable, "-I", script, *args], capture_output=True, text=True, encoding="utf-8")
    return proc.returncode, proc.stdout + proc.stderr


def make_form(path):
    """A fillable one-page form. Checkbox on-state is '1'; the dropdown stores [value, text] pairs per the PDF spec."""
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(612, 792))
    c.drawString(40, 742, "Name")
    f = c.acroForm
    f.textfield(name="full_name", x=100, y=730, width=200, height=20, fieldFlags="")
    f.textfield(name="notes", x=100, y=600, width=200, height=80, fieldFlags="multiline")
    f.textfield(name="zip", x=100, y=560, width=100, height=20, fieldFlags="", maxlen=5)
    f.checkbox(name="agree", x=100, y=520, size=14, fieldFlags="")
    f.radio(name="sex", value="m", x=100, y=480, size=14, selected=False, fieldFlags="radio")
    f.radio(name="sex", value="f", x=140, y=480, size=14, selected=False, fieldFlags="radio")
    f.choice(name="city", x=100, y=440, width=150, height=20, value="bj", options=["bj", "sh"], fieldFlags="combo")
    f.textfield(name="locked", x=100, y=400, width=100, height=20, fieldFlags="readOnly")
    c.save()
    buf.seek(0)
    writer = PdfWriter(clone_from=PdfReader(buf))
    for ref in writer.pages[0]["/Annots"]:
        a = ref.get_object()
        t = a.get("/T")
        if t == "agree":     # custom on-state name
            for key in ("/N", "/D", "/R"):
                sub = a["/AP"][key]
                if "/Yes" in sub:
                    sub[NameObject("/1")] = sub.raw_get("/Yes")
                    del sub["/Yes"]
        if t == "city":
            a[NameObject("/Opt")] = ArrayObject([ArrayObject([TextStringObject("bj"), TextStringObject("Beijing")]),
                                                 ArrayObject([TextStringObject("sh"), TextStringObject("Shanghai")])])
            a.pop("/V", None)
            a.pop("/I", None)
    with open(path, "wb") as fh:
        writer.write(fh)


def make_nested(path):
    """Fields reached through parents: 'form.last' (named kid of a nameless-parent chain) and 'shared' (one field, two widgets)."""
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject

    w = PdfWriter()
    w.add_blank_page(612, 792)
    page = w.pages[0]

    def widget(rect, **extra):
        d = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
                              NameObject("/Rect"): ArrayObject([NumberObject(v) for v in rect]), NameObject("/F"): NumberObject(4),
                              NameObject("/P"): page.indirect_reference})
        for k, v in extra.items():
            d[NameObject(k)] = v
        return w._add_object(d)

    parent = w._add_object(DictionaryObject({NameObject("/T"): TextStringObject("form")}))
    last = widget((100, 700, 250, 720), **{"/T": TextStringObject("last"), "/FT": NameObject("/Tx"), "/Parent": parent})
    parent.get_object()[NameObject("/Kids")] = ArrayObject([last])
    shared = w._add_object(DictionaryObject({NameObject("/T"): TextStringObject("shared"), NameObject("/FT"): NameObject("/Tx")}))
    s1 = widget((100, 600, 250, 620), **{"/Parent": shared})
    s2 = widget((100, 300, 250, 320), **{"/Parent": shared})
    shared.get_object()[NameObject("/Kids")] = ArrayObject([s1, s2])
    orphan = w._add_object(DictionaryObject({NameObject("/T"): TextStringObject("orphan"), NameObject("/FT"): NameObject("/Tx")}))
    page[NameObject("/Annots")] = ArrayObject([last, s1, s2])
    w._root_object[NameObject("/AcroForm")] = DictionaryObject(
        {NameObject("/Fields"): ArrayObject([parent, shared, orphan])})
    with open(path, "wb") as fh:
        w.write(fh)


def make_flat(path, rotate=0, crop=None, size=(612, 792), label="Name:"):
    """A flat page: a label, an underline, a small checkbox square, in the page's own (unrotated) space."""
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, FloatObject, NameObject
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size)
    c.setFont("Helvetica", 12)
    c.drawString(72, size[1] - 100, label)
    c.line(130, size[1] - 102, 330, size[1] - 102)
    c.rect(72, size[1] - 160, 12, 12)
    c.showPage()
    c.save()
    buf.seek(0)
    w = PdfWriter(clone_from=PdfReader(buf))
    page = w.pages[0]
    if crop:
        page.cropbox.lower_left = (crop[0], crop[1])
        page.cropbox.upper_right = (crop[2], crop[3])
    if rotate:
        page.rotate(rotate)
    with open(path, "wb") as fh:
        w.write(fh)


def render(path, page=1, scale=2.0):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(path)
    doc.init_forms()
    img = doc[page - 1].render(scale=scale).to_pil().convert("L")
    doc.close()
    return img


def ink_in(img, box, page_h, scale=2.0, threshold=128):
    """Dark pixels inside a displayed-space box [l, b, r, t] (points, bottom-left origin)."""
    l, b, r, t = box
    crop = img.crop((int(l * scale), int((page_h - t) * scale), int(r * scale), int((page_h - b) * scale)))
    return sum(1 for p in crop.tobytes() if p < threshold)


class Tmp(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.dir = self._d.name

    def tearDown(self):
        self._d.cleanup()

    def p(self, name):
        return os.path.join(self.dir, name)

    def inspect(self, pdf, *extra):
        out = self.p("inspect.json")
        code, text = run(INSPECT, pdf, out, *extra)
        self.assertEqual(code, 0, text)
        with open(out, encoding="utf-8") as fh:
            return json.load(fh)

    def fill(self, pdf, entries, out="out.pdf", *extra):
        vp = self.p("values.json")
        with open(vp, "w", encoding="utf-8") as fh:
            json.dump(entries, fh, ensure_ascii=False)
        code, text = run(FILL, pdf, vp, self.p(out), *extra)
        return code, text


class Inspect(Tmp):
    def test_fillable_form_report(self):
        pdf = self.p("form.pdf")
        make_form(pdf)
        doc = self.inspect(pdf)
        self.assertTrue(doc["has_fields"])
        self.assertNotIn("page_content", doc)
        f = {e["id"]: e for e in doc["fields"]}
        self.assertEqual(f["agree"]["type"], "checkbox")
        self.assertEqual((f["agree"]["on_state"], f["agree"]["off_state"]), ("1", "Off"))
        self.assertEqual(f["sex"]["type"], "radio group")
        self.assertEqual([b["export_value"] for b in f["sex"]["buttons"]], ["m", "f"])
        self.assertEqual(f["city"]["options"], [{"value": "bj", "text": "Beijing"}, {"value": "sh", "text": "Shanghai"}])
        self.assertEqual(f["zip"]["max_length"], 5)
        self.assertTrue(f["notes"]["multiline"])
        self.assertTrue(f["locked"]["read_only"])
        self.assertEqual(f["full_name"]["rect"], [100.0, 730.0, 300.0, 750.0])
        # reading order: top to bottom
        ids = [e["id"] for e in doc["fields"]]
        self.assertEqual(ids[0], "full_name")
        self.assertLess(ids.index("notes"), ids.index("zip"))

    def test_nested_shared_and_unlocatable_fields(self):
        pdf = self.p("nested.pdf")
        make_nested(pdf)
        doc = self.inspect(pdf)
        f = {e["id"]: e for e in doc["fields"]}
        self.assertIn("form.last", f)
        self.assertEqual(len(f["shared"]["widgets"]), 2)
        self.assertTrue(f["orphan"]["unlocatable"])
        self.assertIsNone(f["orphan"]["page"])
        self.assertEqual(doc["fields"][-1]["id"], "orphan")

    def test_flat_page_content_and_scan_note(self):
        pdf = self.p("flat.pdf")
        make_flat(pdf)
        doc = self.inspect(pdf)
        self.assertFalse(doc["has_fields"])
        pc = doc["page_content"][0]
        self.assertTrue(pc["has_text_layer"])
        word = next(w for w in pc["words"] if w["text"] == "Name:")
        self.assertAlmostEqual(word["box"][0], 72, delta=1)
        self.assertAlmostEqual(word["box"][1], 792 - 100 - 3, delta=3)
        self.assertTrue(any(abs(r["y"] - (792 - 102)) < 1 and r["left"] < 135 and r["right"] > 325 for r in pc["rules"]))
        self.assertTrue(any(abs(b["box"][0] - 72) < 1 for b in pc["small_boxes"]))

    def test_rotated_and_offset_pages_report_displayed_space(self):
        for rot in (90, 180, 270):
            pdf = self.p(f"r{rot}.pdf")
            make_flat(pdf, rotate=rot, size=(612, 792))
            doc = self.inspect(pdf)
            page = doc["pages"][0]
            self.assertEqual(page["rotation"], rot)
            if rot in (90, 270):
                self.assertEqual((page["width"], page["height"]), (792.0, 612.0))
            word = next(w for w in doc["page_content"][0]["words"] if w["text"] == "Name:")
            # the word's box must hold the ink of the rendered page
            img = render(pdf)
            ink = ink_in(img, word["box"], page["height"])
            self.assertGreater(ink, 20, f"rotation {rot}: word box {word['box']} holds no ink")
        pdf = self.p("crop.pdf")
        make_flat(pdf, crop=(36, 36, 576, 756))
        doc = self.inspect(pdf)
        self.assertTrue(doc["pages"][0]["box_origin_nonzero"])
        self.assertEqual((doc["pages"][0]["width"], doc["pages"][0]["height"]), (540.0, 720.0))
        word = next(w for w in doc["page_content"][0]["words"] if w["text"] == "Name:")
        self.assertGreater(ink_in(render(pdf), word["box"], 720), 20)
        pdf = self.p("crop90.pdf")
        make_flat(pdf, crop=(36, 36, 576, 756), rotate=90)
        doc = self.inspect(pdf)
        word = next(w for w in doc["page_content"][0]["words"] if w["text"] == "Name:")
        self.assertGreater(ink_in(render(pdf), word["box"], 540), 20)

    def test_encrypted_needs_password(self):
        from pypdf import PdfReader, PdfWriter
        flat = self.p("flat.pdf")
        make_flat(flat)
        w = PdfWriter(clone_from=PdfReader(flat))
        w.encrypt("secret")
        enc = self.p("enc.pdf")
        with open(enc, "wb") as fh:
            w.write(fh)
        code, text = run(INSPECT, enc, self.p("o.json"))
        self.assertEqual(code, 2)
        self.assertIn("--password", text)
        doc = self.inspect(enc, "--password", "secret")
        self.assertTrue(doc["encrypted"])


class Fill(Tmp):
    def setUp(self):
        super().setUp()
        self.form = self.p("form.pdf")
        make_form(self.form)

    def values(self, pdf):
        return {e["id"]: e["current_value"] for e in self.inspect(pdf)["fields"]}

    def test_fill_every_field_kind_and_read_back(self):
        code, text = self.fill(self.form, [
            {"id": "full_name", "value": "Ada Lovelace"}, {"id": "notes", "value": "line one\nline two"},
            {"id": "zip", "value": "94305"}, {"id": "agree", "value": "1"}, {"id": "sex", "value": "f"},
            {"id": "city", "value": "Shanghai"}])
        self.assertEqual(code, 0, text)
        self.assertIn("entry 1 / id full_name: now 'Ada Lovelace'", text)
        v = self.values(self.p("out.pdf"))
        self.assertEqual((v["full_name"], v["zip"], v["agree"], v["sex"], v["city"]), ("Ada Lovelace", "94305", "1", "f", "sh"))
        self.assertEqual(v["notes"], "line one\nline two")
        # the widgets show the state: checkbox and the right radio button are on
        from pypdf import PdfReader
        states = {}
        for ref in PdfReader(self.p("out.pdf")).pages[0]["/Annots"]:
            a = ref.get_object()
            key = a.get("/T") or a["/Parent"].get_object().get("/T")
            states.setdefault(key, []).append(str(a.get("/AS")))
        self.assertEqual(states["agree"], ["/1"])
        self.assertEqual(states["sex"], ["/Off", "/f"])
        self.assertIn("Fields left blank", text)
        # rendered: the typed text produces ink inside the field rectangle
        img = render(self.p("out.pdf"))
        self.assertGreater(ink_in(img, [102, 732, 298, 748], 792), 30)
        self.assertGreater(ink_in(img, [101, 521, 113, 533], 792), 5)   # the ticked checkbox

    def test_bool_checkbox_clear_and_overwrite_only_named(self):
        self.assertEqual(self.fill(self.form, [{"id": "agree", "value": True}, {"id": "full_name", "value": "A"}])[0], 0)
        second = self.p("second.pdf")
        os.replace(self.p("out.pdf"), second)
        code, text = self.fill(second, [{"id": "agree", "value": False}], "third.pdf")
        self.assertEqual(code, 0, text)
        v = self.values(self.p("third.pdf"))
        self.assertEqual((v["agree"], v["full_name"]), ("Off", "A"))
        code, _ = self.fill(second, [{"id": "full_name", "value": ""}], "fourth.pdf")
        self.assertEqual(self.values(self.p("fourth.pdf"))["full_name"], "")

    def test_validation_writes_nothing_and_lists_choices(self):
        entries = [{"id": "city", "value": "Tokyo"}, {"id": "sex", "value": "x"}, {"id": "zip", "value": "123456"},
                   {"id": "locked", "value": "a"}, {"id": "nope", "value": "a"}, {"id": "agree", "value": "Yes"},
                   {"id": "full_name", "value": "a\nb"}, {"id": "full_name", "value": "ok", "page": 2}]
        code, text = self.fill(self.form, entries)
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(self.p("out.pdf")))
        for needle in ("entry 1 / id city", "bj (Beijing)", "entry 2 / id sex", "m, f", "entry 3 / id zip", "at most 5",
                       "entry 4 / id locked", "read-only", "entry 5 / id nope", "entry 6 / id agree", "1, Off",
                       "single-line", "not page 2"):
            self.assertIn(needle, text)

    def test_error_output_is_capped(self):
        code, text = self.fill(self.form, [{"id": f"missing{i}", "value": "x"} for i in range(40)])
        self.assertEqual(code, 1)
        self.assertLessEqual(len(text.strip().splitlines()), 23)
        self.assertIn("more problems", text)

    def test_input_is_never_overwritten(self):
        code, text = self.fill(self.form, [{"id": "full_name", "value": "x"}], self.form)
        self.assertEqual(code, 2)
        self.assertIn("new file", text)

    def test_nested_and_shared_fields(self):
        pdf = self.p("nested.pdf")
        make_nested(pdf)
        code, text = self.fill(pdf, [{"id": "form.last", "value": "Smith"}, {"id": "shared", "value": "same"}])
        self.assertEqual(code, 0, text)
        v = self.values(self.p("out.pdf"))
        self.assertEqual((v["form.last"], v["shared"]), ("Smith", "same"))
        img = render(self.p("out.pdf"))
        self.assertGreater(ink_in(img, [100, 600, 250, 620], 792), 10)
        self.assertGreater(ink_in(img, [100, 300, 250, 320], 792), 10)   # second widget of the shared field

    def test_odd_state_names(self):
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import NameObject
        w = PdfWriter(clone_from=PdfReader(self.form))
        for ref in w.pages[0]["/Annots"]:
            a = ref.get_object()
            if a.get("/T") == "agree":
                for key in ("/N", "/D", "/R"):
                    sub = a["/AP"][key]
                    sub[NameObject("/On/Off#1")] = sub.raw_get("/1")
                    del sub["/1"]
        odd = self.p("odd.pdf")
        with open(odd, "wb") as fh:
            w.write(fh)
        doc = self.inspect(odd)
        on = next(e for e in doc["fields"] if e["id"] == "agree")["on_state"]
        self.assertEqual(on, "On/Off#1")
        code, text = self.fill(odd, [{"id": "agree", "value": "/" + on}])
        self.assertEqual(code, 0, text)
        self.assertEqual(self.values(self.p("out.pdf"))["agree"], "On/Off#1")

    def test_chinese_in_field_sets_value_and_notes(self):
        code, text = self.fill(self.form, [{"id": "full_name", "value": "张三"}])
        self.assertEqual(code, 0, text)
        self.assertIn("non-Latin", text)
        self.assertEqual(self.values(self.p("out.pdf"))["full_name"], "张三")


class Placed(Tmp):
    def test_placed_text_lands_in_the_box_for_every_rotation_and_crop(self):
        cases = [("plain", {}, (612, 792)), ("r90", {"rotate": 90}, (792, 612)), ("r180", {"rotate": 180}, (612, 792)),
                 ("r270", {"rotate": 270}, (792, 612)), ("crop", {"crop": (36, 36, 576, 756)}, (540, 720)),
                 ("crop90", {"crop": (36, 36, 576, 756), "rotate": 90}, (720, 540)), ("a4", {"size": (595, 842)}, (595, 842))]
        for name, kw, (dw, dh) in cases:
            pdf = self.p(f"{name}.pdf")
            make_flat(pdf, **kw)
            box = [dw * 0.3 - 60, dh * 0.3 - 8, dw * 0.3 + 60, dh * 0.3 + 8]
            vp = self.p("v.json")
            with open(vp, "w") as fh:
                json.dump([{"page": 1, "box": box, "text": "HELLO WORLD", "size": 12}], fh)
            out = self.p(f"{name}_out.pdf")
            code, text = run(FILL, pdf, vp, out)
            self.assertEqual(code, 0, f"{name}: {text}")
            before, after = render(pdf), render(out)
            ink_before = ink_in(before, box, dh)
            ink_after = ink_in(after, box, dh)
            self.assertGreater(ink_after - ink_before, 40, f"{name}: no ink at {box}")
            # nothing drawn in the mirrored region (rules out a flipped or rotated placement)
            mirror = [dw - box[2], dh - box[3], dw - box[0], dh - box[1]]
            self.assertLess(ink_in(after, mirror, dh) - ink_in(before, mirror, dh), 5, f"{name}: ink in the mirrored box")

    def test_placed_entries_are_validated(self):
        pdf = self.p("flat.pdf")
        make_flat(pdf)
        entries = [{"page": 1, "box": [100, 100, 200, 120], "text": "A"},
                   {"page": 1, "box": [150, 105, 250, 125], "text": "B"},               # overlaps entry 1
                   {"page": 1, "box": [0, 0, 700, 20], "text": "C"},                     # outside the page
                   {"page": 1, "box": [100, 300, 160, 305], "text": "D", "size": 11},   # too short
                   {"page": 1, "box": [100, 400, 130, 420], "text": "a long piece of text"},   # too wide
                   {"page": 1, "box": [100, 500, 130, 520], "text": "a long piece of text", "fit": True},
                   {"page": 3, "box": [1, 1, 20, 20], "text": "E"}]
        vp = self.p("v.json")
        with open(vp, "w") as fh:
            json.dump(entries, fh)
        code, text = run(FILL, pdf, vp, self.p("o.pdf"))
        self.assertEqual(code, 1)
        for needle in ("entry 2 / entry 1: boxes overlap", "entry 3", "outside the page", "entry 4", "smaller than the font size",
                       "entry 5", "widen the box", "entry 6", "smallest size", "entry 7", "page must be"):
            self.assertIn(needle, text)
        self.assertFalse(os.path.exists(self.p("o.pdf")))

    def test_fit_shrinks_and_align_and_ticks(self):
        pdf = self.p("flat.pdf")
        make_flat(pdf)
        entries = [{"page": 1, "box": [100, 400, 200, 420], "text": "Fits after shrinking ok", "size": 14, "fit": True},
                   {"page": 1, "box": [100, 300, 300, 320], "text": "right", "align": "right", "color": "#cc0000"},
                   {"page": 1, "box": [72, 612, 84, 624], "tick": "check"}]
        code, text = self.fill_ok(pdf, entries)
        self.assertIn("drawn on page 1", text)
        img = render(self.p("out.pdf"))
        self.assertGreater(ink_in(img, [100, 400, 200, 420], 792), 40)
        self.assertGreater(ink_in(img, [220, 300, 300, 320], 792), 15)    # right-aligned: ink on the right half
        self.assertLess(ink_in(img, [100, 300, 180, 320], 792), 3)
        self.assertGreater(ink_in(img, [72, 612, 84, 624], 792) - 0, 8)

    def fill_ok(self, pdf, entries):
        vp = self.p("v.json")
        with open(vp, "w") as fh:
            json.dump(entries, fh)
        code, text = run(FILL, pdf, vp, self.p("out.pdf"))
        self.assertEqual(code, 0, text)
        return code, text

    def test_chinese_placed_text_has_ink_and_file_stays_small(self):
        import office_env
        if office_env.pick_font("sans") is None and office_env.pick_font("serif") is None:
            self.skipTest("no Chinese font on this machine")
        pdf = self.p("flat.pdf")
        make_flat(pdf)
        self.fill_ok(pdf, [{"page": 1, "box": [100, 400, 260, 424], "text": "表单填写测试，你好", "size": 16}])
        self.assertLess(os.path.getsize(self.p("out.pdf")), 400_000)
        self.assertGreater(ink_in(render(self.p("out.pdf")), [100, 400, 260, 424], 792), 60)

    def test_mixed_entries_and_untouched_pages(self):
        from pypdf import PdfReader, PdfWriter
        form = self.p("form.pdf")
        make_form(form)
        w = PdfWriter(clone_from=PdfReader(form))
        w.add_blank_page(612, 792)
        two = self.p("two.pdf")
        with open(two, "wb") as fh:
            w.write(fh)
        code, text = self.fill_ok(two, [{"id": "full_name", "value": "Ada"},
                                        {"page": 2, "box": [100, 100, 220, 120], "text": "Page two"}])
        img2 = render(self.p("out.pdf"), page=2)
        self.assertGreater(ink_in(img2, [100, 100, 220, 120], 792), 30)
        self.assertEqual(len(PdfReader(self.p("out.pdf")).pages), 2)

    def test_encrypted_input_with_password(self):
        from pypdf import PdfReader, PdfWriter
        flat = self.p("flat.pdf")
        make_flat(flat)
        w = PdfWriter(clone_from=PdfReader(flat))
        w.encrypt("pw")
        enc = self.p("enc.pdf")
        with open(enc, "wb") as fh:
            w.write(fh)
        vp = self.p("v.json")
        with open(vp, "w") as fh:
            json.dump([{"page": 1, "box": [100, 400, 200, 420], "text": "x"}], fh)
        code, text = run(FILL, enc, vp, self.p("o.pdf"))
        self.assertEqual(code, 2)
        self.assertIn("password", text)
        code, text = run(FILL, enc, vp, self.p("o.pdf"), "--password", "pw")
        self.assertEqual(code, 0, text)


if __name__ == "__main__":
    unittest.main(verbosity=1)
