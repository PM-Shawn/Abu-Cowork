---
name: pdf
display-name:
  zh-CN: PDF 处理
description: "Work with PDF files: read text and tables, merge, split, rotate or crop pages, add watermarks, create new PDFs, fill in forms (fields or flat forms, Chinese text included), encrypt or decrypt, and render pages to images for a look. Use it whenever a .pdf is the input or the thing to deliver."
display-description:
  zh-CN: 读取、合并、分割 PDF，提取内容、填写表单和渲染预览
  en-US: Read, merge, split, create, fill in and preview PDF files
license: Apache-2.0
trigger: 用户要求处理 PDF 文件，包括读取、提取文本/表格、合并、拆分、旋转、加水印、创建、填表、加密解密、提取图片。用户提到 .pdf 文件或要求生成 PDF 时触发
do-not-trigger: 用户只是在对话中提到 PDF 一词但不涉及实际 PDF 文件操作
blocked-tools:
  - manage_scheduled_task
  - manage_trigger
  - manage_file_watch
  - delegate_to_agent
  - update_memory
  - todo_write
  - clipboard_read
  - clipboard_write
  - system_notify
  - manage_mcp_server
  - log_task_completion
  - save_agent
  - computer
---

# PDF files

Bundled Python only: pypdf (merge, split, rotate, forms, metadata, encrypt), pdfplumber (text and tables with positions), pypdfium2 (render pages to images), reportlab and fpdf2 (create), Pillow. There is no OCR, no poppler, no qpdf and no pip; do not call them. Scripts are in `${ABU_SKILL_DIR}/scripts/`.

## Look at a PDF

Render the pages to pictures and open them with `read_file`; this also shows the layout of a PDF you just made. It writes into a new temp folder unless you give a folder, so name the folder only when the user wants the picture files:
```
python "${ABU_SKILL_DIR}/scripts/render_pdf.py" in.pdf [out_dir] [--dpi 110] [--pages 1-3]
```
Writes `page_001.png ...` and `contact.png` (all pages on one sheet) and prints text characters and image count per page. A page with images and no text is a scan: the text cannot be extracted here (no OCR); tell the user, and describe it from the page picture if they only need the gist.

## Read text and tables

```python
import pdfplumber
with pdfplumber.open(path) as pdf:
    for n, page in enumerate(pdf.pages, 1):
        print(n, page.extract_text())
        for t in page.extract_tables(): print(t)      # list of rows
```
`pypdf.PdfReader(path).pages[i].extract_text()` is a faster alternative for plain text. Encrypted: `reader.decrypt(password)` if the user gave the password; otherwise say in the reply that the file is protected and cannot be read, and that an unprotected copy or the password would let you continue. Chinese text that comes out garbled or as (cid:123) means the PDF has no usable text map; render the page and read it from the image.

## Merge, split, rotate, crop

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for f in files:
    w.append(f)                       # whole file; w.append(f, pages=(0, 3)) for a range
w.write("merged.pdf")
page = PdfReader(p).pages[0]; page.rotate(90)              # rotate clockwise
page.mediabox.upper_right = (x1, y1)                       # crop (points, origin bottom-left)
w.add_metadata({"/Title": "...", "/Author": "..."}); w.encrypt("pw")    # metadata, password
```
Watermark: build a one-page PDF with reportlab, then `page.merge_page(mark_page)`.

## Create

reportlab (`canvas` for exact placement, `platypus` for flowing text and tables) or fpdf2. Chinese text needs a Chinese font, otherwise it prints as black squares:
```python
import sys; sys.path.insert(0, r"${ABU_SKILL_DIR}/scripts"); import office_env
font = office_env.register_reportlab_cjk()          # "CJK" (embedded) or "STSong-Light" (not embedded)
canvas.setFont(font, 12)                            # or ParagraphStyle(fontName=font, leading=18, wordWrap="CJK")
```
Use `wordWrap="CJK"` in Paragraph styles for Chinese line breaking. A4 is `reportlab.lib.pagesizes.A4`. Never use `<sub>`/`<sup>` Unicode characters with a font that lacks them; use the markup tags. Charts: matplotlib PNG (`office_env.setup_matplotlib_cjk()` first), inserted as an image. Render the result and look at every page.

## Forms

Two scripts do all form work. Both use the same coordinates: points, origin at the bottom-left of the page as it looks on screen (rotation and crop box are handled inside the scripts, never by you), boxes written `[left, bottom, right, top]`.

1. Inspect: `python "${ABU_SKILL_DIR}/scripts/pdf_form_inspect.py" in.pdf info.json` (add `--password PW` for an encrypted file). The summary lists pages and fields; `info.json` has the details. With fields, each has an `id`, `type`, `page`, `rect`, `current_value`, and what it accepts: a checkbox's `on_state` / `off_state` (often "1" or a custom name, not "Yes"), a radio group's buttons with their `export_value`, a dropdown's `options` (value and text), a text field's `max_length` / `multiline`. Fields with no page are listed as unlocatable. Without fields it lists, per page, words with boxes, long horizontal rules (underlines) and small squares (checkbox candidates); a page with no text layer is a scan, so work from the page image.
2. Decide: use only values the user gave. Anything they did not give stays blank, and you say which entries those are in your reply. Do not guess or make values up.
3. Write `values.json`, a list mixing these entries as needed:
   - a field: `{"id": "full_name", "value": "Ada Lovelace"}`; checkbox value is the on or off state name (or true / false); radio value is a button's `export_value`; dropdown value is a listed value or its text; `""` clears.
   - text drawn on the page, for flat forms: `{"page": 1, "box": [130, 690, 330, 706], "text": "Ada", "size": 11, "fit": true, "align": "left", "color": "#000000"}`. The box sits on the line the text belongs to and must be at least as tall as the size. Tick marks for checkboxes without fields: `{"page": 1, "box": [72, 612, 84, 624], "tick": "check"}`.
   Chinese text is detected and drawn with an embedded Chinese font. Boxes of two drawn entries must not overlap.
4. Fill: `python "${ABU_SKILL_DIR}/scripts/pdf_form_fill.py" in.pdf values.json out.pdf`. It checks every entry first and writes nothing if one is wrong; the messages say which entry and list the valid choices, so fix that entry and run again. It never changes the input file. On success it prints what each entry now holds and which fields are still blank.
5. Check: run the inspect script on `out.pdf` and compare values, then `render_pdf.py out.pdf --dpi 110` and open the page images with `read_file`, zooming into every filled region: text inside its line or box, not on top of a label, checkboxes visibly ticked, Chinese characters present, nothing on the wrong page. If a drawn entry is off, change its numbers and run again.

Reading a position off a page image rendered at D dpi: x_pt = pixel_x * 72 / D, y_pt = page_height_pt - pixel_y * 72 / D (the image has its origin at the top-left, the page space at the bottom-left). Take the page height from the inspect output. For a flat form, render the page, find each blank in the image, convert, and compare with the words and rules in `info.json` before writing boxes.

Chinese in a real form field cannot be drawn with the standard form fonts: the value is stored and viewers redraw it, but if the render shows the field blank, put the text in a drawn entry over that field's `rect` and tell the user. Filling a signed PDF invalidates its signature (the script warns). The output file is not password protected even if the input was.

## Word, Excel and PowerPoint to PDF

There is no converter here: rebuild the content with reportlab, or tell the user to export from Word or WPS.
