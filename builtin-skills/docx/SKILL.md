---
name: docx
display-name:
  zh-CN: Word 文档
description: "Work with Word files (.docx, .dotx): write new reports, memos, letters and templates with headings, tables, contents pages, page numbers and letterheads; read or restructure the text of an existing file; swap images; run find-and-replace. Use it whenever a Word file is the input or the thing to deliver. It cannot edit tracked changes or comments. Not for PDFs, spreadsheets, Google Docs or unrelated programming."
display-description:
  zh-CN: 创建、读取和编辑 Word 文档（.docx）
  en-US: Create, read and edit Word documents (.docx)
license: Apache-2.0
trigger: 用户要求创建、读取、编辑 Word 文档（.docx），提到 Word 文档、.docx 文件，或要求生成带格式的报告、备忘录、信件等 Word 文件
do-not-trigger: 用户要求处理 PDF、电子表格、Google Docs，或与 Word 文档无关的编码任务
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

# Word documents (.docx)

Use the bundled Python: python-docx for creating and editing, lxml for raw XML. Nothing else is installed and nothing can be installed, so do not use pandoc, docx-js, LibreOffice or `pip install`. Scripts are in `${ABU_SKILL_DIR}/scripts/`.

Workflow: write the document, run the check, fix what it reports, run it again, then tell the user the path.

## Read

```python
from docx import Document
d = Document(path)
for p in d.paragraphs: print(p.style.name, p.text)
for t in d.tables: print([[c.text for c in r.cells] for r in t.rows])
```
Headers, footers and text boxes are not in `d.paragraphs`; read `d.sections[i].header.paragraphs` and search `d.element.body.iter()` for `w:txbxContent` when the text matters. Old `.doc` files cannot be opened: say so in the reply and that saving the file as .docx in Word or WPS lets you work on it.

## Create

- Page: `section.page_width/height` = A4 (21 x 29.7 cm) for Chinese users, margins 2.54 cm unless asked otherwise.
- Use styles (`Heading 1..3`, `List Bullet`, `Table Grid`) instead of manually bold paragraphs, so the outline and navigation work.
- Chinese text needs an East Asian font set explicitly, or Word picks one you did not choose:
  ```python
  from docx.oxml.ns import qn
  style = d.styles["Normal"]; style.font.name = "Microsoft YaHei"; style.font.size = Pt(11)
  style.element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
  ```
  Do the same for each Heading style. Fonts that exist on both Windows and macOS: Microsoft YaHei / PingFang SC (sans), SimSun / Songti SC (serif). `python "${ABU_SKILL_DIR}/scripts/office_env.py" fonts` shows what this machine has. Write the name the reader's machine most likely has (微软雅黑 for Windows readers).
- Pictures: `d.add_picture(path, width=Cm(14))` (set width only, so the proportion is kept; keep width within the text area, 15.9 cm on A4 with default margins). Charts: draw a PNG with matplotlib (see the xlsx skill, `office_env.setup_matplotlib_cjk()`), then insert it.
- Tables: `d.add_table(rows, cols, style="Table Grid")`, set column widths on every cell, mark the first row as header (repeat header: `w:tblHeader` in `trPr`). Numbers right-aligned.
- Page numbers, table of contents and other fields: insert a `w:fldSimple` (`PAGE`, `TOC \o "1-3"`). A TOC shows empty until Word updates fields; say so, or write the contents list as plain text.
- Set `d.core_properties.author` and `title`; the default author is "python-docx".
- Do not leave placeholder text, empty paragraphs used as spacing (use `space_after`), or manual page-break hacks (use `page_break_before`).

## Edit an existing file

Open, change runs and paragraphs in place, save under a new name (never overwrite the original unless asked). Keep formatting by editing `run.text` rather than replacing the paragraph. Text split across several runs: join the paragraph text, find the match, put the new text into the first run and empty the others. Tracked changes and comments are not supported by python-docx; if the file has them, tell the user instead of silently removing them (the check lists them).

## Check before delivering

```
python "${ABU_SKILL_DIR}/scripts/check_docx.py" out.docx
python "${ABU_SKILL_DIR}/scripts/check_docx.py" out.docx --fix-fonts 微软雅黑     # sets the Chinese font where there is none (a font the template chose is kept)
```
It reports leftover placeholders, empty or skipped headings, Chinese text without an East Asian font, fonts not installed here, tables or pictures wider than the page, missing image files, leftover tracked changes, Letter paper, runs of empty paragraphs. Fix every `[错误]`, think about each `[注意]`. It does not render the pages, so tell the user the layout was checked structurally and not seen.
