---
name: xlsx
display-name:
  zh-CN: Excel 表格
description: "Work with spreadsheet files (.xlsx, .xlsm, .xltx, .csv, .tsv): open, read, correct or extend an existing one, build a new one from scratch or from other data, add formulas, formatting or charts, tidy messy tables, or convert between tabular formats. Use it whenever a spreadsheet is the input or the thing to deliver, including when the user only names a file casually. Not for Word or HTML reports, database pipelines, or Google Sheets API work."
display-description:
  zh-CN: 创建、读取、编辑和整理表格文件（.xlsx、.csv）
  en-US: Create, read, edit and clean up spreadsheets (.xlsx, .csv)
license: Apache-2.0
trigger: 用户要求打开、读取、编辑 Excel/CSV/TSV 文件，创建电子表格，清理表格数据，或处理任何 .xlsx/.xlsm/.csv/.tsv 文件
do-not-trigger: 用户要求生成 Word 文档、HTML 报告、独立 Python 脚本，或 Google Sheets API 集成
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

# Excel workbooks (.xlsx) and CSV

Bundled Python only: openpyxl (read/write, formulas, styles, charts), xlsxwriter (new files with native charts), pandas (tables, grouping, CSV), matplotlib (PNG charts). No spreadsheet program is assumed: files you write have formulas but no real stored values (openpyxl stores none, xlsxwriter stores a 0 placeholder), and nothing here can compute them for real. Scripts are in `${ABU_SKILL_DIR}/scripts/`.

Workflow: build the file, run `check_xlsx.py`, fix, run again, tell the user the path and anything unverified.

## Read and analyse

```python
import pandas as pd
df = pd.read_excel(path, sheet_name=None)      # dict of sheets; header row guessed, check df.head()
df = pd.read_csv(path, encoding="utf-8-sig")   # Chinese CSV from Excel is often gbk: retry with encoding="gbk"
```
`openpyxl.load_workbook(path)` shows formulas; `data_only=True` shows the values Excel last saved. A file written by openpyxl has no saved values (`data_only=True` gives None) and one written by xlsxwriter has a 0 in every formula cell, so the preview panel shows empty cells or zeros until Excel/WPS has calculated them.

## Create

- Put inputs (rates, assumptions) in labelled cells and refer to them; do not bury numbers in formulas. Use formulas for anything derived (totals, ratios) so the user can change inputs, never a Python-computed number typed in.
- Formulas are English function names with commas, in the file: `ws["D2"] = "=B2*C2"`, `"=SUM(D2:D20)"`, cross-sheet `"='Sheet 2'!B5"`.
- Format: header row bold with fill and `freeze_panes`, number formats (`#,##0.00`, `0.0%`, `yyyy-mm-dd`), column widths from the longest content (Chinese characters count double), no merged cells inside data ranges.
- Font: Chinese-capable, `Font(name="Microsoft YaHei")` (it also displays on macOS Excel through substitution) or leave the default.
- Native chart (editable in Excel/WPS): `openpyxl.chart.BarChart / LineChart / PieChart`, `Reference` to the data cells, `ws.add_chart(chart, "H2")`, set a title and axis titles. Chinese text in native charts uses the viewer's font, nothing to configure.
- Picture chart (matplotlib): call `office_env.setup_matplotlib_cjk()` before drawing, otherwise Chinese labels become empty squares.
  ```python
  import sys; sys.path.insert(0, r"${ABU_SKILL_DIR}/scripts"); import office_env
  office_env.setup_matplotlib_cjk(); import matplotlib.pyplot as plt
  ```
  Save with `plt.savefig(p, dpi=150, bbox_inches="tight")`, insert with `openpyxl.drawing.image.Image`. It prefers a native chart when the user wants to edit it; use a picture for chart types Excel cannot draw.
- Writing a DataFrame: `df.to_excel(writer, sheet_name=..., index=False)` then style through `writer.book`.

## Edit an existing workbook

`load_workbook(path)` (not `data_only=True`, or the formulas are lost on save). openpyxl drops pivot tables, slicers and some charts/images it cannot read: if the file has them, say so and edit a copy, or make the change another way. Save under a new name.

## Check before delivering

```
python "${ABU_SKILL_DIR}/scripts/check_xlsx.py" out.xlsx            # problems + summary
python "${ABU_SKILL_DIR}/scripts/check_xlsx.py" out.xlsx --values   # also the values it estimates, to compare with your source data
```
It looks at structure and never changes the file. It finds errors saved in the file (#DIV/0!, #REF!), formulas pointing at missing sheets or cells, totals that stop short of the data, numbers stored as text, too-narrow columns, chart series pointing at empty cells, and pivot tables or slicers (openpyxl drops them when saving: edit a copy and tell the user). Its other findings are hints: a formula that differs from its neighbours, a typed number among formulas, an estimated error. Judge each hint yourself, a subtotal row or a year header is often right as it is; do not change the file only because a hint says so. The values it estimates are a rough cross-check for plain SUM/IF/SUMIF/VLOOKUP formulas against your source data, not Excel's result: never tell the user the formulas are "verified".

Values: a file written by openpyxl has none stored and one written by xlsxwriter has 0 in every formula cell, so the preview panel and `read_file` show empty cells or zeros and Excel/WPS compute them when the file is opened. Nothing here can calculate them, so deliver the file and say plainly: "the numbers appear when you open the file in Excel or WPS; I checked the structure but could not calculate the values here". Do not write values into the formula cells yourself, and do not write your own renderer or preview of the sheet.
