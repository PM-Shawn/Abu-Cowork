"""Shared helpers for pdf_form_inspect.py and pdf_form_fill.py: opening a PDF, page geometry, and the form-field tree.

Coordinates used by both scripts ("displayed space"): points, origin at the bottom-left corner of the page
as a person sees it (visible box only, /Rotate applied). A box is [left, bottom, right, top]. The
conversion to and from the PDF's own space (crop box offset, /Rotate) lives here and nowhere else.
"""
from __future__ import annotations

import os
import sys

# python -I does not put the script folder on sys.path; the sibling modules (office_env) live there.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


class UserError(Exception):
    """A problem to show to the user in plain words (exit status 2 for the file, 1 for bad entries)."""


def r1(value: float) -> float:
    return round(float(value) + 0.0, 1)


# ---------------------------------------------------------------------------------------------------------
# opening
# ---------------------------------------------------------------------------------------------------------

def open_reader(path: str, password: str | None = None):
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    if not os.path.isfile(path):
        raise UserError(f"{path}: file not found.")
    try:
        reader = PdfReader(path)
    except PdfReadError as exc:
        raise UserError(f"{path}: cannot be read as a PDF ({exc}).") from None
    except Exception as exc:  # truncated or zero-byte files raise assorted errors
        raise UserError(f"{path}: cannot be read as a PDF ({type(exc).__name__}: {exc}).") from None
    if reader.is_encrypted:
        from pypdf import PasswordType
        ok = reader.decrypt(password if password is not None else "")
        if ok == PasswordType.NOT_DECRYPTED:
            if password is None:
                raise UserError(f"{path}: the file is encrypted and needs a password; run again with --password.")
            raise UserError(f"{path}: that password does not open the file.")
    return reader


# ---------------------------------------------------------------------------------------------------------
# page geometry
# ---------------------------------------------------------------------------------------------------------

class PageGeometry:
    """Maps between the PDF's user space of one page and the displayed space described in the module doc."""

    def __init__(self, page):
        media = [float(v) for v in page.mediabox]
        crop = [float(v) for v in page.cropbox]
        # the visible box is the crop box clipped to the media box
        left, bottom = max(crop[0], media[0]), max(crop[1], media[1])
        right, top = min(crop[2], media[2]), min(crop[3], media[3])
        if right <= left or top <= bottom:
            left, bottom, right, top = media
        self.left, self.bottom = left, bottom
        self.media = media
        self.w, self.h = right - left, top - bottom              # visible size before rotation
        try:
            rotation = int(page.get("/Rotate", 0) or 0)
        except Exception:
            rotation = 0
        try:
            inherited = int(page.rotation)
            rotation = inherited
        except Exception:
            pass
        self.rotation = rotation % 360
        if self.rotation not in (0, 90, 180, 270):
            self.rotation = 0
        swap = self.rotation in (90, 270)
        self.width = self.h if swap else self.w                  # displayed size
        self.height = self.w if swap else self.h
        self.origin_offset = (abs(left) > 1e-6) or (abs(bottom) > 1e-6)

    def _forward(self, x, y, left, bottom, w, h):
        x, y = x - left, y - bottom
        if self.rotation == 0:
            return x, y
        if self.rotation == 90:
            return y, w - x
        if self.rotation == 180:
            return w - x, h - y
        return h - y, x

    def to_display(self, x: float, y: float) -> tuple[float, float]:
        return self._forward(x, y, self.left, self.bottom, self.w, self.h)

    def media_frame_offset(self) -> tuple[float, float, float]:
        """For libraries that report positions in the displayed *media box* (pdfplumber): the displayed-space
        position of the visible box's lower-left corner inside that frame, and the frame's displayed height."""
        ml, mb, mr, mt = self.media
        mw, mh = mr - ml, mt - mb
        a = self._forward(self.left, self.bottom, ml, mb, mw, mh)
        b = self._forward(self.left + self.w, self.bottom + self.h, ml, mb, mw, mh)
        frame_h = mw if self.rotation in (90, 270) else mh
        return min(a[0], b[0]), min(a[1], b[1]), frame_h

    def to_page(self, dx: float, dy: float) -> tuple[float, float]:
        if self.rotation == 0:
            x, y = dx, dy
        elif self.rotation == 90:
            x, y = self.w - dy, dx
        elif self.rotation == 180:
            x, y = self.w - dx, self.h - dy
        else:
            x, y = dy, self.h - dx
        return x + self.left, y + self.bottom

    def rect_to_display(self, rect) -> list[float]:
        x0, y0, x1, y1 = (float(v) for v in rect)
        ax, ay = self.to_display(x0, y0)
        bx, by = self.to_display(x1, y1)
        return [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)]

    def overlay_matrix(self) -> tuple[float, float, float, float, float, float]:
        """PDF matrix (a, b, c, d, e, f) that carries a drawing made in displayed space onto this page."""
        l, b, w, h = self.left, self.bottom, self.w, self.h
        if self.rotation == 0:
            return (1, 0, 0, 1, l, b)
        if self.rotation == 90:
            return (0, 1, -1, 0, w + l, b)
        if self.rotation == 180:
            return (-1, 0, 0, -1, w + l, h + b)
        return (0, -1, 1, 0, l, h + b)


# ---------------------------------------------------------------------------------------------------------
# field tree
# ---------------------------------------------------------------------------------------------------------

FF_READONLY = 1
FF_MULTILINE = 1 << 12
FF_PASSWORD = 1 << 13
FF_NO_TOGGLE_OFF = 1 << 14
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18
FF_MULTISELECT = 1 << 21
FF_COMB = 1 << 24


class Field:
    """One logical form field (all objects that carry the same full name)."""

    def __init__(self, name: str):
        self.name = name
        self.nodes: list = []        # field dictionaries that hold /V
        self.widgets: list = []      # widget annotation dictionaries
        self.kind = "other"          # text, checkbox, radio, choice, button, signature, other
        self.flags = 0
        self.ft = None

    def attr(self, key):
        """An inheritable attribute: the first value found on a node, a widget, or their parents."""
        for obj in [*self.nodes, *self.widgets]:
            cur, depth = obj, 0
            while cur is not None and depth < 32:
                if key in cur:
                    return cur[key]
                parent = cur.get("/Parent")
                cur = parent.get_object() if parent is not None else None
                depth += 1
        return None


def _is_widget(obj) -> bool:
    return obj.get("/Subtype") == "/Widget" or ("/Rect" in obj and "/Kids" not in obj)


def _inherit(obj, key, inherited):
    return obj[key] if key in obj else inherited.get(key)


def collect_fields(doc) -> tuple[list[Field], dict]:
    """Every field reachable from /AcroForm /Fields, merged by full dotted name. Returns (fields, acroform)."""
    root = getattr(doc, "_root_object", None)
    if root is None:
        root = doc.trailer["/Root"]
    acro = root.get("/AcroForm")
    if acro is None:
        return [], {}
    acro = acro.get_object()
    by_name: dict[str, Field] = {}
    order: list[Field] = []
    seen: set[int] = set()

    def get_field(name: str) -> Field:
        if name not in by_name:
            by_name[name] = Field(name)
            order.append(by_name[name])
        return by_name[name]

    def walk(node_ref, prefix: str, inherited: dict):
        node = node_ref.get_object()
        if node is None or not hasattr(node, "get"):
            return
        key = id(node)
        if key in seen:
            return
        seen.add(key)
        title = node.get("/T")
        name = prefix
        if title is not None:
            name = f"{prefix}.{title}" if prefix else str(title)
        inh = {k: _inherit(node, k, inherited) for k in ("/FT", "/Ff")}
        kids = [k for k in (node.get("/Kids") or [])]
        widget_kids, named_kids = [], []
        for kid in kids:
            kobj = kid.get_object()
            if kobj is None or not hasattr(kobj, "get"):
                continue
            if "/T" in kobj:
                named_kids.append(kid)
            else:
                widget_kids.append(kid)
        for kid in named_kids:
            walk(kid, name, inh)
        has_widgets = bool(widget_kids) or (not kids and _is_widget(node))
        # a node whose children have no names of their own, or which is itself a widget, is a field
        if (has_widgets or ("/FT" in node and not named_kids)) and name:
            field = get_field(name)
            field.nodes.append(node)
            if not kids and _is_widget(node):
                field.widgets.append(node)
            for kid in widget_kids:
                kobj = kid.get_object()
                if "/Kids" in kobj and not _is_widget(kobj):
                    # a nameless intermediate node: its children are the widgets
                    for sub in kobj["/Kids"]:
                        field.widgets.append(sub.get_object())
                else:
                    field.widgets.append(kobj)
            ft = inh.get("/FT")
            if ft is not None and field.ft is None:
                field.ft = str(ft)
                field.flags = int(inh.get("/Ff") or 0)

    for ref in acro.get("/Fields") or []:
        walk(ref, "", {})
    for field in order:
        _classify(field)
    return order, acro


def _classify(field: Field) -> None:
    flags = int(field.attr("/Ff") or 0)
    ft = field.ft or (str(field.attr("/FT")) if field.attr("/FT") is not None else None)
    field.flags = flags
    if ft == "/Tx":
        field.kind = "text"
    elif ft == "/Btn":
        field.kind = "button" if flags & FF_PUSHBUTTON else ("radio" if flags & FF_RADIO else "checkbox")
    elif ft == "/Ch":
        field.kind = "choice"
    elif ft == "/Sig":
        field.kind = "signature"
    else:
        field.kind = "other"


def page_index_of_widgets(doc) -> dict[int, int]:
    """Map id() of each annotation dictionary to its 0-based page, through the pages' /Annots lists."""
    out: dict[int, int] = {}
    for index, page in enumerate(doc.pages):
        annots = page.get("/Annots")
        if annots is None:
            continue
        for ref in annots.get_object():
            obj = ref.get_object()
            if obj is not None:
                out[id(obj)] = index
    return out


def name_of(value) -> str:
    """A PDF name without its leading slash."""
    text = str(value)
    return text[1:] if text.startswith("/") else text


def button_states(widget) -> list[str]:
    """Appearance state names of a checkbox / radio widget (the keys of /AP /N, or /D), 'Off' excluded."""
    ap = widget.get("/AP")
    if ap is None:
        return []
    ap = ap.get_object()
    for key in ("/N", "/D"):
        sub = ap.get(key)
        if sub is None:
            continue
        sub = sub.get_object()
        if hasattr(sub, "keys"):
            names = [name_of(k) for k in sub.keys() if name_of(k) != "Off"]
            if names:
                return names
    return []


def choice_options(field: Field) -> list[tuple[str, str]]:
    """(value, display text) for each option of a dropdown or list; a stored pair is [value, text]."""
    opt = field.attr("/Opt")
    out: list[tuple[str, str]] = []
    if opt is None:
        return out
    for item in opt.get_object():
        item = item.get_object()
        if isinstance(item, list) or (hasattr(item, "__len__") and not isinstance(item, str) and len(item) == 2):
            value, text = item[0].get_object(), item[1].get_object()
            out.append((str(value), str(text)))
        else:
            out.append((str(item), str(item)))
    return out


def current_value(field: Field):
    v = field.attr("/V")
    if v is None:
        return None
    v = v.get_object()
    if isinstance(v, list):
        return [str(x.get_object()) for x in v]
    return name_of(v) if field.kind in ("checkbox", "radio") else str(v)
