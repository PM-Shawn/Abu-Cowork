---
name: gongwen
display-name:
  zh-CN: 公文写作
description: "Write Chinese official documents (公文: 通知, 请示, 报告, 函, 纪要, 批复, 红头文件) and fill company document templates as .docx, laid out to GB/T 9704-2012 (A4, margins, 仿宋/小标宋/黑体/楷体 fonts, page numbers, 版头 and 版记), then check the layout. Use when the user asks for a 公文, a notice, a request or a red-head document, or wants a company template filled in. Not for ordinary Word reports (use docx)."
display-description:
  zh-CN: 按国标格式写通知、请示、报告等公文，或填公司模板
  en-US: Write Chinese official documents (notices, requests, reports) or fill a company template
license: Apache-2.0
trigger: 用户要求写通知、请示、报告、函、纪要、批复、公文、红头文件，或要求按公司/单位的模板出文件
do-not-trigger: 用户要的是普通的 Word 报告、方案、简历或 PDF、表格
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

# 公文 (official documents) as .docx

Bundled Python only (python-docx, lxml). Scripts are in `${ABU_SKILL_DIR}/scripts/`. Write the content in formal, plain Chinese; this skill handles the layout.

## 1. Pick the type and settle the facts

通知 (inform or assign work), 请示 (ask a higher level for a decision, one matter per document, ends with 妥否,请批示), 报告 (report to a higher level, no request), 函 (between units of equal rank), 纪要 (record of a meeting), 批复 (answer to a 请示). Before writing, make sure you have: the issuing unit, who it is addressed to (主送机关), the subject, dates and numbers, contact person. Do not invent 发文字号, names, phone numbers or dates; leave them out and say so in the reply. If the user gave no date, use today's date and say so in your reply; If the issuing unit or the 主送机关 is missing and someone can answer (use the ask_user_question tool if it is offered), ask once for them, in one question. In an unattended run (no one to answer, or the tool is absent) do not ask: leave them out and say so in the reply.

Structure of the text: title "关于……的通知" (no punctuation except 《》), addressee with a full-width colon, body, then signing unit and date. Headings in order: 一、 then （一） then 1. then （1）. Write dates as 2025年3月5日 (not 03/05, and no leading zeros).

## 2. Generate

Write a spec file and run the generator:
```
python "${ABU_SKILL_DIR}/scripts/make_gongwen.py" spec.json 通知.docx
```
`spec.json` keys (only `title` and `body` are required):
- `style`: `"redhead"` (红头: issuing unit in red + red rule + 发文字号) or `"plain"` (no head, for 请示/内部通知 without a red head)
- `org`, `org_suffix` (default 文件), `number` (use 〔2025〕 brackets), `signer` (签发人, for 请示/报告), `copy_no`, `secrecy`, `urgency`
- `title`, `addressee`, `body`: list of paragraphs; a paragraph starting with 一、 （一） 1. （1） is laid out as that heading level; a list of rows (`[["部门","负责人"],["生产部","李四"]]`) becomes a table
- `attachments` (附件 lines under the body), `sign_org`, `date`, `seal` (true leaves room for the seal), `note` (附注)
- `attachment_pages`: `[{"label": "附件1", "title": "...", "body": [...]}]` on their own pages
- `cc` (抄送), `issuer` (印发机关), `issue_date` (印发日期) for the 版记

Layout produced: A4, margins top 37 / bottom 35 / left 28 / right 26 mm, body 3号 (16 pt) 仿宋_GB2312 with 28 characters x 22 lines per page, title 2号 小标宋, headings 黑体 / 楷体_GB2312 / 仿宋_GB2312, page number 4号 宋体 "— 1 —" (odd pages right, even left), the 版记 rules at the foot of the last page. A date and signing unit are kept together with the last lines of text, never alone on a page.

## 3. Fonts

The file names the standard fonts. `python "${ABU_SKILL_DIR}/scripts/office_env.py" fonts` lists the roles installed on this machine. Windows normally has 宋体 and 微软雅黑, and 仿宋, 楷体, 黑体 as optional components; macOS has 宋体-简 (Songti), 黑体-简 and 楷体-简. 仿宋_GB2312 and 方正小标宋 are usually not installed; Word and WPS then substitute (the page still reads correctly, but 28 characters per line and line breaks may shift slightly). Tell the user: for an exact result install 方正小标宋简体 and 仿宋_GB2312 (the organisation normally has them). Do not claim exact conformity; say the layout follows the standard and may differ slightly with substituted fonts.

## 4. Check, fix, recheck

```
python "${ABU_SKILL_DIR}/scripts/check_docx.py" 通知.docx --gongwen
```
Besides the usual docx checks it verifies A4 and the margins, the page number in the footer with odd/even pages, the 22-line grid, heading and body fonts and sizes, first-line indent, dates without leading zeros and 〔〕 in the 发文字号. Fix the spec and regenerate; do not patch the .docx by hand. The check does not render the pages: tell the user the layout was checked structurally and not seen. Do not look for a renderer or write your own.

## 5. Company or unit template

If the user gives a .docx template (letterhead, 红头, form), do not rebuild it with the generator: open it with python-docx, find the placeholders (`{{标题}}`, 【请填写】, 年 月 日, empty table cells), put the new text into the first run of the paragraph or cell so the template's fonts stay, delete leftover runs, save under a new name, and run `check_docx.py` on it (without `--gongwen` unless it follows the national format). Keep headers, footers, logos and sections untouched. Text in a text box or the header: `d.sections[0].header.paragraphs`, and search `w:txbxContent`.

## 6. Tell the user

The path of the file; which fields you left blank or assumed; the font note above; that Word and WPS should be used to open it and the page count and the seal position confirmed before it is issued.
