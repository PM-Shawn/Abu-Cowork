---
name: pptx
display-name:
  zh-CN: PPT 演示文稿
description: "Work with PowerPoint files (.pptx, .potx): build a slide deck or presentation, read or pull text out of an existing one, edit or update slides, merge or split decks, and handle templates, layouts, speaker notes and comments. Use it whenever a PowerPoint file is opened, created or changed, or when the user asks for slides or a deck as a .pptx, whatever they plan to do with the result."
display-description:
  zh-CN: 创建、读取和编辑演示文稿（.pptx）
  en-US: Create, read and edit slide decks (.pptx)
license: Apache-2.0
trigger: 用户要求创建、读取、编辑演示文稿（PPT/PPTX/.pptx），提到PPT、幻灯片、演示文稿、演示、presentation、deck、slides、slide，或需要处理任何 .pptx 文件
do-not-trigger: 用户只是讨论演示技巧但不涉及 .pptx 文件操作
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

# PowerPoint decks (.pptx)

Bundled Python only: python-pptx, Pillow, matplotlib, lxml. Do not use pptxgenjs, markitdown, LibreOffice or `pip install`; none of them exist on the user's machine. Scripts are in `${ABU_SKILL_DIR}/scripts/`.

Workflow: build, run `check_pptx.py`, fix, run again, deliver.

## Read

```python
from pptx import Presentation
prs = Presentation(path)
for i, s in enumerate(prs.slides, 1):
    for sh in s.shapes:
        if sh.has_text_frame: print(i, sh.name, sh.text_frame.text)
        if getattr(sh, "has_table", False) and sh.has_table: print([[c.text for c in r.cells] for r in sh.table.rows])
    if s.has_notes_slide: print(s.notes_slide.notes_text_frame.text)
```

## Create

- Size first: `prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)` (16:9). The default template is 4:3 (10 x 7.5 in). Shapes placed outside the page are saved but not visible.
- Use the layouts: `prs.slide_layouts[0]` title, `[1]` title and content, `[5]` title only, `[6]` blank. Fill `slide.shapes.title` and the body placeholder rather than free text boxes, so the outline view works; delete placeholders you do not use (`sp = ph._element; sp.getparent().remove(sp)`), empty ones show "单击此处添加" when edited.
- Plan the deck before coding: one message per slide, the title says the point ("华东区收入同比增长 18%", not "收入"), 3 to 5 bullets of at most ~20 Chinese characters each, 18 pt or larger for body text, 28 to 40 pt for titles. Split content rather than shrinking it. Use the last slide for the conclusion or next steps, not "谢谢".
- Chinese fonts: set the East Asian font on every run, or PowerPoint picks one you did not choose:
  build the deck, then run `check_pptx.py deck.pptx --fix-fonts 微软雅黑`, which sets it on the theme and every run lacking one (a Chinese font the template or theme already names is kept).
- Charts: native (editable) with `pptx.chart.data.CategoryChartData` and `slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, cx, cy, data)`; or a matplotlib PNG for other types (call `office_env.setup_matplotlib_cjk()` first, see the xlsx skill).
- Pictures: `slide.shapes.add_picture(path, left, top, width=...)` giving width or height, not both, so it is not stretched. Check the file exists first.
- Tables: `shapes.add_table(rows, cols, x, y, cx, cy)`; keep to about 6 rows x 5 columns per slide, 14 pt or larger.
- Colors: pick 2 or 3 and reuse them; dark text on a light background, check contrast. Keep the same margins (about 0.6 in) and alignment on every slide.
- Speaker notes: `slide.notes_slide.notes_text_frame.text = "..."` when the user will present.

## Edit an existing deck or template

Open it, find shapes by name or placeholder, change text run by run to keep the formatting (`para.runs[0].text = new`, clear the other runs). To reuse a slide's layout, add a slide from that layout (`prs.slides.add_slide(layout)`) and fill the placeholders; python-pptx cannot duplicate or reorder slides directly (reorder with `prs.slides._sldIdLst`; delete by removing the `sldId` and dropping its relationship). Save under a new name.

## Check before delivering

```
python "${ABU_SKILL_DIR}/scripts/check_pptx.py" deck.pptx
python "${ABU_SKILL_DIR}/scripts/check_pptx.py" deck.pptx --fix-fonts 微软雅黑
```
It reports, per slide: shapes outside the page, overlapping text boxes, empty placeholders, leftover placeholder text, stretched or missing pictures, text under 12 pt, more than 6 paragraphs in a box, tables running past the bottom, slides with no title, Chinese text without a Chinese font, fonts not installed here. "可能溢出" (text may not fit) is an estimate from box size, font size and character count: shorten the text or enlarge the box and run again; the check cannot see the slide, so tell the user the layout was checked structurally and not seen.
