#!/usr/bin/env python3
"""Render a PDF to PNG pages and report what each page contains. Uses pypdfium2 + Pillow only.

    python render_pdf.py file.pdf [out_dir] [--dpi 110] [--pages 1-3,7]

Makes picture files of PDF pages (open them with read_file to look at the pages): page_001.png ...
and contact.png (all pages, up to 12 per sheet), then prints one line per page: characters of text, number
of images, and a hint when a page looks scanned (no text, has an image) or empty.
Without out_dir the pictures go to a new folder in the system temp folder, never next to the user's file.
"""
import argparse
import os
import sys


class PageSpecError(ValueError):
    pass


def parse_pages(spec, total):
    if not spec:
        return list(range(total))
    out = []
    for part in spec.split(","):
        part = part.strip()
        try:
            if "-" in part:
                a, b = part.split("-", 1)
                out.extend(range(int(a) - 1, min(int(b), total)))
            elif part:
                out.append(int(part) - 1)
        except ValueError:
            raise PageSpecError(f"页码「{part}」看不懂;写法如 3、1-3 或 1,4,6-8。") from None
    return [p for p in out if 0 <= p < total]


def main():
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out_dir", nargs="?")
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument("--pages")
    a = ap.parse_args()
    try:
        import pypdfium2 as pdfium
        from PIL import Image
    except ImportError as exc:
        print(f"missing library: {exc}")
        return 2
    try:
        doc = pdfium.PdfDocument(a.pdf)
    except Exception as exc:
        print(f"[错误] PDF 打不开(损坏或有密码): {exc}")
        return 1
    try:
        doc.init_forms()    # without this, form fields (filled or not) are not drawn
    except Exception:
        pass
    total = len(doc)
    try:
        pages = parse_pages(a.pages, total)
    except PageSpecError as exc:
        print(f"[错误] {exc}")
        return 2
    if not pages:
        print(f"[错误] 选的页码里没有这个 PDF 的页(共 {total} 页),没有渲染任何页面。")
        return 1
    if a.out_dir:
        out = a.out_dir
        os.makedirs(out, exist_ok=True)
    else:
        import tempfile
        out = tempfile.mkdtemp(prefix="xs-pdf-pages-")
    print(f"{os.path.basename(a.pdf)}: {total} 页, 渲染 {len(pages)} 页 -> {out}")
    thumbs = []
    for i in pages:
        page = doc[i]
        image = page.render(scale=a.dpi / 72).to_pil().convert("RGB")
        name = f"page_{i + 1:03d}.png"
        image.save(os.path.join(out, name))
        tp = page.get_textpage()
        text = tp.get_text_range().strip()
        n_img = len(list(page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE])))
        hint = ""
        if not text and n_img:
            hint = "  扫描页或整页图片,没有可提取的文字(需要识别请告知用户本机没有 OCR)"
        elif not text:
            hint = "  空白页或只有矢量图形"
        print(f"  {name}  {page.get_width():.0f}x{page.get_height():.0f}pt  文字 {len(text)} 字  图片 {n_img}{hint}")
        thumb = image.copy()
        thumb.thumbnail((360, 480))
        thumbs.append(thumb)
        page.close()
    for k in range(0, len(thumbs), 12):
        chunk = thumbs[k:k + 12]
        cols = min(4, len(chunk))
        rows = (len(chunk) + cols - 1) // cols
        cw, ch = 370, 490
        sheet = Image.new("RGB", (cols * cw, rows * ch), (200, 200, 200))
        for j, t in enumerate(chunk):
            sheet.paste(t, ((j % cols) * cw + 5, (j // cols) * ch + 5))
        sheet.save(os.path.join(out, "contact.png" if len(thumbs) <= 12 else f"contact_{k // 12 + 1}.png"))
    doc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
