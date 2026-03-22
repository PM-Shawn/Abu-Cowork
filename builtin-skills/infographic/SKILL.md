---
name: infographic
description: 生成精美的纯 HTML+CSS 信息图 — 时间线、流程、对比分析、SWOT、金字塔、漏斗、数据卡片、组织架构等。无需外部依赖，在沙箱 iframe 中渲染。适合将结构化信息以海报级视觉效果呈现。
trigger: 用户要求生成信息图、数据海报、数据可视化展示、流程展示、对比分析图、组织架构图、漏斗图、雷达图、词云、路线图(roadmap)、SWOT 分析、四象限图、金字塔图、瀑布图、饼图统计海报，或任何需要精美排版的结构化信息展示
do-not-trigger: 用户要求画流程图/架构图/ER图/序列图等技术图表（用 mermaid-diagram）；用户要求生成照片/插画/艺术画（用 generate_image）；用户要求做数据分析或写代码；需要交互/动画/按钮操作的组件（用 html-widget）
user-invocable: true
disable-auto-invoke: false
argument-hint: <信息图描述>
tags:
  - 信息图
  - infographic
  - 数据可视化
  - 海报
  - visualization
  - poster
---

你现在帮用户生成 **精美的 HTML+CSS 信息图**。直接在回复中输出 ` ```html ` 代码块，前端会在安全沙箱 iframe 中自动渲染。

**重要规则**：
- **不要调用 generate_image 工具**，HTML 代码块就是最终输出
- **不要调用文件写入工具**——这是对话内的可视化展示
- **只输出一个 ` ```html ` 代码块**——一张完整的信息图，不要拆成多个
- **纯 CSS 实现**——不要用 `<script>`、不要引入外部 CDN、不要用 `<canvas>`
- 输出 HTML 片段（**不含** `<!DOCTYPE>`、`<html>`、`<head>`、`<body>`），顺序：`<style>` → HTML 内容

---

## 设计体系

> **核心美学：克制、留白、呼吸感。** 信息图是一张海报，不是一个网页。每个元素都要有存在的理由，宁少勿多。

### 审美原则

1. **做减法**：不加装饰性 emoji/icon，不加渐变背景，不加阴影。需要强调时用色彩和字重，不用堆砌视觉元素
2. **留白即设计**：区块之间 32-48px 间距，内容不要挤在一起。留白是最重要的设计元素
3. **信息层级清晰**：通过字号递减 + 色彩深浅建立 3 层视觉层级——标题 / 正文 / 辅助
4. **色彩克制**：整张图只用 1 种强调色 + 灰度色阶。多数据系列时才启用色板
5. **对齐与网格**：所有元素对齐到 4px 网格，间距只用 4 的倍数

### 配色

**CSS 变量（已预注入 iframe）**：

| 变量 | 值 | 用途 |
|------|-----|------|
| `--abu-primary` | `#d97757` | 唯一强调色——用于编号、标签、线条、高亮 |
| `--abu-text` | `#29261b` | 标题 & 正文 |
| `--abu-text-muted` | `#888579` | 副标题、描述、脚注 |
| `--abu-bg` | `#ffffff` | 页面底色 |
| `--abu-bg-secondary` | `#f5f3ee` | 卡片 / 区块底色 |
| `--abu-border` | `#e5e2db` | 分割线、边框、轨道 |

**数据色板**（仅在多数据系列对比时使用）：
`#4F46E5` · `#0891B2` · `#10B981` · `#F59E0B` · `#EF4444` · `#7C3AED`

**语义色**（仅在明确表达趋势/状态时使用）：
- 正向：`#059669` 文字 + `#ecfdf5` 底
- 负向：`#DC2626` 文字 + `#fef2f2` 底

**禁止**：
- ❌ 深色/黑色背景
- ❌ 大面积饱和色块（只允许小面积点缀：编号圆、标签、进度条）
- ❌ 多于 2 种强调色同时出现
- ❌ 渐变做装饰（唯一例外：头部区域极轻微的 `#f8f6f3 → #fff`）

### 字体

```
font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
```

**只用两种字重**：`400`（正文）和 `600`（标题/数字）。禁用 300/500/700/800。

| 角色 | 字号 | 字重 | 颜色 |
|------|------|------|------|
| 主标题 | 24px | 600 | `--abu-text` |
| 副标题 | 14px | 400 | `--abu-text-muted` |
| 区块标题 | 16-18px | 600 | `--abu-text` |
| 正文 | 13-14px | 400 | `--abu-text` |
| 标签/脚注 | 11-12px | 400/600 | `--abu-text-muted` |
| 大数字（KPI） | 28-36px | 600 | `--abu-text` |
| 步骤编号 | 11px | 600 | `--abu-primary` |

**排版规则**：
- 行高：标题 1.3，正文 1.5-1.6
- 中英文 / 中文与数字之间加半角空格：`GDP 总量 101.4 万亿`
- 数字等宽对齐：`font-variant-numeric: tabular-nums`

### 间距（4px 网格）

所有间距必须是 4 的倍数。禁止 5px、7px、15px 等非标值。

| 用途 | 值 |
|------|-----|
| 元素内微间距 | 4px |
| 紧密行间 | 8px |
| 组内元素 | 12px |
| 卡片内边距 / 段落间 | 16px |
| 卡片间距 | 12-16px |
| 区块间距 | 32-48px |
| 头部上下 padding | 32px |

### 圆角

| 元素 | 值 |
|------|-----|
| 小元素（标签、编号） | 4-6px |
| 卡片 | 8-10px |
| 大容器 | 12px |

一张信息图内最多 2 种圆角值。

### 装饰手法（仅用这些，不要发明新的）

- **分割线**：`1px solid var(--abu-border)`，用于步骤之间、头部与正文之间
- **编号圆**：`width: 28px; height: 28px; border-radius: 50%; background: var(--abu-primary); color: #fff; font-size: 13px;`
- **空心圆点**：`border: 2px solid var(--abu-primary); background: #fff;`（时间线节点）
- **实心小圆点**：`width: 5px; height: 5px; border-radius: 50%;`（列表标记）
- **竖线**：`width: 1.5px; background: var(--abu-border);`（时间线轴）
- **左色条**：`border-left: 3px solid var(--abu-primary); padding-left: 12px;`（引用 / 重点段落）
- **浅色标签**：`padding: 2px 8px; border-radius: 4px; font-size: 11px; background: #f0f0ff; color: #4338CA;`
- **进度条**：`height: 6px; border-radius: 3px; background: var(--abu-border);` + 内填充

**禁止**：
- ❌ box-shadow（任何阴影）
- ❌ emoji 作为 icon（不要用 🔍 🎨 💻 🚀 等）
- ❌ border 做卡片轮廓（用背景色区分即可）
- ❌ 多彩渐变
- ❌ text-transform: uppercase（中文信息图不需要）

---

## 页面结构

每张信息图遵循固定骨架：

```html
<style>
  .ig { max-width: 600px; margin: 0 auto; }
  .hd { padding: 32px 0 24px; text-align: center; }
  .hd h1 { font-size: 24px; font-weight: 600; color: var(--abu-text); margin: 0 0 6px; }
  .hd p { font-size: 14px; color: var(--abu-text-muted); margin: 0; }
  /* 正文区块样式 */
  .ft { padding: 20px 0 4px; text-align: center; font-size: 11px; color: var(--abu-text-muted); border-top: 1px solid var(--abu-border); margin-top: 32px; }
</style>

<div class="ig">
  <div class="hd">
    <h1>标题</h1>
    <p>副标题 / 说明</p>
  </div>

  <!-- 正文内容 -->

  <div class="ft">Abu Infographic</div>
</div>
```

- `.ig` 容器：`max-width: 600px; margin: 0 auto;` — 控制最大宽度，居中
- `.hd` 头部：居中标题 + 副标题，简洁干净，不要加背景色或装饰
- `.ft` 页脚：固定文案 `Abu Infographic`，细字灰色，上方一条分割线

---

## 布局类型参考

根据内容结构选择最合适的布局。可以在一张信息图中组合多种布局（如头部 KPI 卡片 + 中部时间线）。

### 时间线
左侧竖线 + 圆点 + 右侧内容。适合：发展历程、版本演进、里程碑。
- 竖线用 `::before` 伪元素，1.5px 宽，`var(--abu-border)` 色
- 节点用空心圆（2px border），首个节点实心
- 每个节点：上方小字标签（日期/阶段，11px，`--abu-primary`）+ 标题 + 描述

### 流程步骤
纵向列表，编号圆 + 标题 + 描述，步骤间用分割线分隔。适合：操作流程、开发流程。
- 编号圆：28px，`--abu-primary` 底白字
- 步骤之间 `border-bottom: 1px solid var(--abu-border)` 分隔

### 卡片网格
2-3 列网格，每格一张浅底卡片。适合：SWOT、特性对比、分类展示。
- 卡片底色用极浅的语义色（`#f0f0ff`、`#edfcf4`、`#fffceb`、`#fef5f5`）
- 卡片标题用对应深色的小标签

### KPI 数据
大数字 + 标签 + 趋势。适合：经营数据、统计概览。
- 3-4 列网格，`var(--abu-bg-secondary)` 底
- 数字 28-36px，`tabular-nums`
- 趋势用 `↑`/`↓` + 语义色标签

### 排名列表
横向行卡片，左侧序号 + 中间内容 + 右侧数值。适合：Top N、榜单。
- 前 1-3 名序号用强调色，其余用 `var(--abu-border)`
- 行间距 8px，行内 padding 14px

### 对比（双栏）
左右两列，各有色彩标题头 + 内容列表。适合：方案对比、Before/After。

### 金字塔 / 漏斗
自上而下宽度递增（或递减），每层一个色条。适合：层级模型、转化漏斗。

### 进度条
横向进度条 + 标签 + 百分比。适合：完成度、占比分布。
- 轨道 6px 高，`var(--abu-border)` 底，填充用 `--abu-primary`

---

## 注意事项

- **只输出一个 `html` 代码块**，所有内容合在一张信息图中
- class 命名用简短有意义的缩写（`.ig` `.hd` `.ft` `.st`），不要用 `.infographic-header-title-wrapper`
- 信息图 vs 技术图表：信息图侧重「精美展示」，技术图表用 mermaid
- 信息图 vs 交互组件：信息图是静态海报，需要交互的用 html-widget
- 内容多时组合使用多种布局，不要一列到底变成纯文本长列表
- 中文排版，变量名 / class 名用英文
