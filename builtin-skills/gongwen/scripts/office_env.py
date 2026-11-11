#!/usr/bin/env python3
"""What this machine can do for office files: the installed Chinese fonts, and drawing Chinese text with matplotlib and reportlab.

The same file sits in the scripts folder of the xlsx, docx, pptx and pdf skills; the
copies must stay identical (a unit test compares them), so change all of them together.

Command line:
    python office_env.py              # JSON: Chinese fonts found, platform
    python office_env.py fonts        # one line per Chinese font role and the font chosen for it

From a script:
    sys.path.insert(0, "<this scripts folder>")
    import office_env
    office_env.pick_font("sans")              # "Microsoft YaHei", "PingFang SC", ... or None
    office_env.setup_matplotlib_cjk()         # call before drawing a chart with Chinese text
    office_env.register_reportlab_cjk()       # font name to use with reportlab (PDF with Chinese text)
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sys
import tempfile

# Roles and the fonts that serve them, best first. Names are matched ignoring case and spaces,
# against every family / full / PostScript name found inside the installed font files, so both
# "SimSun" and "宋体" work.
FONT_CHAINS: dict[str, list[str]] = {
    # body text in sans-serif: slides, charts, spreadsheets
    "sans": ["Microsoft YaHei", "微软雅黑", "PingFang SC", "苹方-简", "Heiti SC", "STHeiti", "Hiragino Sans GB",
             "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "DengXian", "等线", "SimHei", "黑体"],
    # body text in Song / serif: reports
    "serif": ["SimSun", "宋体", "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC"],
    "heiti": ["SimHei", "黑体", "Heiti SC", "STHeiti", "Microsoft YaHei", "微软雅黑", "PingFang SC"],
}

_CACHE_VERSION = 3
_fonts_memo: dict[str, tuple[str, int]] | None = None


def _norm(name: str) -> str:
    return re.sub(r"[\s_\-]+", "", name).lower()


def _font_dirs() -> list[str]:
    home = os.path.expanduser("~")
    dirs: list[str] = []
    if sys.platform == "win32":
        windir = os.environ.get("WINDIR", r"C:\Windows")
        dirs += [os.path.join(windir, "Fonts")]
        local = os.environ.get("LOCALAPPDATA")
        if local:
            dirs.append(os.path.join(local, "Microsoft", "Windows", "Fonts"))
        appdata = os.environ.get("APPDATA")
        if appdata:
            dirs.append(os.path.join(appdata, "kingsoft", "office6", "fonts"))
    elif sys.platform == "darwin":
        dirs += ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts",
                 os.path.join(home, "Library", "Fonts"),
                 "/Applications/Microsoft Word.app/Contents/Resources/DFonts",
                 os.path.join(home, "Library", "Group Containers", "UBF8T346G9.Office", "FontCache")]
        # PingFang and other downloadable system fonts live in asset folders
        dirs += glob.glob("/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData")
        dirs += glob.glob("/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*.asset/AssetData")
    else:
        dirs += ["/usr/share/fonts", "/usr/local/share/fonts", os.path.join(home, ".fonts"),
                 os.path.join(home, ".local", "share", "fonts")]
    return [d for d in dirs if os.path.isdir(d)]


def _font_files(dirs: list[str]) -> list[str]:
    found: list[str] = []
    for base in dirs:
        for root, _subdirs, names in os.walk(base):
            if root[len(base):].count(os.sep) > 6:
                continue
            for n in names:
                if n.lower().endswith((".ttf", ".ttc", ".otf", ".otc")):
                    found.append(os.path.join(root, n))
    return sorted(found)


def _names_in(path: str) -> list[tuple[str, int, int]]:
    """(normalised name, face index, rank) for every family / full / PostScript name in a font file.

    rank 0 is the regular weight (or a full / PostScript name, which is exact), rank 1 any other
    weight, so a family name resolves to its Regular face and not to Black or Light."""
    from fontTools.ttLib import TTCollection, TTFont  # bundled with the Python runtime

    out: list[tuple[str, int, int]] = []
    try:
        if path.lower().endswith((".ttc", ".otc")):
            faces = list(TTCollection(path, lazy=True).fonts)
        else:
            faces = [TTFont(path, lazy=True, fontNumber=0)]
    except Exception:
        return out
    for index, face in enumerate(faces):
        try:
            records = face["name"].names
        except Exception:
            continue
        style = ""
        for rec in records:
            if rec.nameID in (2, 17):
                try:
                    style = rec.toUnicode().lower()
                except Exception:
                    pass
        regular = style in ("", "regular", "normal", "book", "常规", "標準体")
        for rec in records:
            if rec.nameID in (1, 4, 6, 16):
                try:
                    text = rec.toUnicode()
                except Exception:
                    continue
                if text:
                    rank = 0 if (rec.nameID in (4, 6) or regular) else 1
                    out.append((_norm(text), index, rank))
    return out


def installed_fonts() -> dict[str, tuple[str, int]]:
    """Map normalised font name -> (file path, face index) for the fonts installed on this machine."""
    global _fonts_memo
    if _fonts_memo is not None:
        return _fonts_memo
    files = _font_files(_font_dirs())
    signature = [_CACHE_VERSION, [[f, int(os.path.getmtime(f))] for f in files if os.path.exists(f)]]
    cache_file = os.path.join(tempfile.gettempdir(), "abu-work", "office-fonts-cache.json")
    try:
        with open(cache_file, encoding="utf-8") as fh:
            cached = json.load(fh)
        if cached.get("signature") == signature:
            _fonts_memo = {k: (v[0], v[1]) for k, v in cached["fonts"].items()}
            return _fonts_memo
    except Exception:
        pass
    table: dict[str, tuple[str, int]] = {}
    ranks: dict[str, int] = {}
    for path in files:
        for key, index, rank in _names_in(path):
            if key not in table or rank < ranks[key]:
                table[key] = (path, index)
                ranks[key] = rank
    _fonts_memo = table
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as fh:
            json.dump({"signature": signature, "fonts": {k: list(v) for k, v in table.items()}}, fh)
    except Exception:
        pass
    return table


def has_font(name: str) -> bool:
    return _norm(name) in installed_fonts()


def font_file(name: str) -> tuple[str, int] | None:
    return installed_fonts().get(_norm(name))


def pick_font(role: str) -> str | None:
    """First font of the role's chain that is installed here, else None."""
    for name in FONT_CHAINS[role]:
        if has_font(name):
            return name
    return None


def _single_face(path: str, index: int) -> str:
    """matplotlib loads face 0 of a font collection. When the face wanted is another one (Noto Sans CJK's
    Simplified Chinese face is not the first of its .ttc, the first is Japanese), save that face as a
    file of its own in the temp folder and use that."""
    if index == 0 or not path.lower().endswith((".ttc", ".otc")):
        return path
    from fontTools.ttLib import TTCollection

    face = TTCollection(path, lazy=False).fonts[index]
    flavor_cff = "CFF " in face or "CFF2" in face
    folder = os.path.join(tempfile.gettempdir(), "abu-work", "fonts")
    os.makedirs(folder, exist_ok=True)
    key = hashlib.md5(f"{path}|{index}|{int(os.path.getmtime(path))}".encode("utf-8")).hexdigest()[:12]
    out = os.path.join(folder, f"{key}-{index}{'.otf' if flavor_cff else '.ttf'}")
    if not os.path.isfile(out):
        face.save(out)
    return out


def setup_matplotlib_cjk(role: str = "sans") -> str | None:
    """Make matplotlib draw Chinese. Returns the font family used, or None (then Chinese text shows as boxes)."""
    import matplotlib
    from matplotlib import font_manager

    matplotlib.rcParams["axes.unicode_minus"] = False
    for name in FONT_CHAINS[role]:
        hit = font_file(name)
        if not hit:
            continue
        try:
            path = _single_face(hit[0], hit[1])
            font_manager.fontManager.addfont(path)
            family = font_manager.FontProperties(fname=path).get_name()
        except Exception:
            continue
        matplotlib.rcParams["font.family"] = "sans-serif"
        matplotlib.rcParams["font.sans-serif"] = [family, "DejaVu Sans"]
        return family
    print("warning: no Chinese font found on this machine; Chinese text in the chart will show as boxes. "
          "Draw the chart without Chinese labels or tell the user.", file=sys.stderr)
    return None


def register_reportlab_cjk(role: str = "sans") -> str:
    """Register a Chinese font with reportlab and return its name for canvas.setFont / ParagraphStyle.

    Uses an installed TrueType font (embedded in the PDF). reportlab cannot read CFF-outline .otf
    fonts; then it falls back to the built-in STSong-Light, which is not embedded: the PDF reader
    draws it, which is fine in Acrobat, WPS and browsers but not guaranteed in minimal viewers."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFError, TTFont

    name = pick_font(role)
    hit = font_file(name) if name else None
    if hit:
        try:
            pdfmetrics.registerFont(TTFont("CJK", hit[0], subfontIndex=hit[1]))
            return "CJK"
        except TTFError:
            pass
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light"


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if len(argv) > 1 and argv[1] == "fonts":
        for role in FONT_CHAINS:
            print(f"{role}: {pick_font(role) or '(none installed)'}")
        return 0
    info = {
        "platform": sys.platform,
        "chinese_fonts": {role: pick_font(role) for role in FONT_CHAINS},
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
