---
name: infographic
description: 使用 AntV Infographic 引擎生成专业信息图 — 列表、流程、层级、对比、关系、图表等 276 种模板。当用户要求制作信息图、数据可视化海报、流程展示、对比分析图、组织架构图、时间线、漏斗图等结构化信息展示时触发。输出 AntV Infographic DSL 语法，前端渲染为 SVG。
trigger: 用户要求生成信息图、数据海报、数据可视化展示、流程展示、对比分析图、组织架构图、漏斗图、雷达图、词云、路线图(roadmap)、SWOT 分析、四象限图、金字塔图、瀑布图、饼图统计海报，或任何需要精美排版的结构化信息展示
do-not-trigger: 用户要求画流程图/架构图/ER图/序列图等技术图表（用 mermaid-diagram）；用户要求生成照片/插画/艺术画（用 generate_image）；用户要求做数据分析或写代码
user-invocable: true
disable-auto-invoke: false
argument-hint: <信息图描述>
tags:
  - 信息图
  - infographic
  - 数据可视化
  - 海报
  - visualization
  - antv
---

你现在帮用户生成 **AntV Infographic 信息图**。

## 输出格式

输出一个 ` ```infographic ` 代码块，使用 AntV Infographic DSL 语法。前端会自动渲染为精美的 SVG 信息图。

**不要调用 generate_image 工具**，代码块就是最终输出。

## DSL 语法规则

```
infographic <模板名>
data
  title 标题文字
  desc 描述文字
  <数据区>
theme
  <主题配置>
design
  <布局配置>
```

- **缩进**：每层 2 个空格
- **键值**：空格分隔（`label 文字`）
- **数组**：用 `-` 开头表示列表项

## 模板速查

### 列表类（List）
适合：步骤说明、特性列表、分点展示

| 模板名 | 效果 |
|--------|------|
| `list-row-simple-horizontal-arrow` | 横向箭头步骤 |
| `list-row-horizontal-icon-arrow` | 带图标横向步骤 |
| `list-column-simple-vertical` | 纵向列表 |
| `list-grid-simple` | 网格布局 |
| `list-pyramid-simple` | 金字塔 |
| `list-waterfall-simple` | 瀑布图 |
| `list-zigzag-simple` | 锯齿形流程 |
| `list-sector-simple` | 扇形布局 |

数据格式：
```
data
  title 标题
  lists
    - label 步骤一
      desc 描述内容
      value 85
      icon rocket
    - label 步骤二
      desc 描述内容
      icon check
```

### 流程/序列类（Sequence）
适合：时间线、路线图、漏斗、流程步骤

| 模板名 | 效果 |
|--------|------|
| `sequence-horizontal-simple` | 横向序列 |
| `sequence-interaction-simple` | 交互式时间线 |
| `sequence-timeline-simple` | 时间线 |
| `sequence-roadmap-simple` | 路线图 |
| `sequence-funnel-simple` | 漏斗图 |
| `sequence-pyramid-simple` | 金字塔 |

数据格式：
```
data
  title 发展路线图
  sequences
    - label 2024 Q1
      desc 产品设计
    - label 2024 Q2
      desc 开发测试
    - label 2024 Q3
      desc 正式发布
  order asc
```

### 层级类（Hierarchy）
适合：组织架构、思维导图、分类树

| 模板名 | 效果 |
|--------|------|
| `hierarchy-tree-simple` | 树形图 |
| `hierarchy-mindmap-simple` | 思维导图 |
| `hierarchy-org-simple` | 组织架构 |

数据格式：
```
data
  title 组织架构
  root
    label 总经理
    children
      - label 技术部
        children
          - label 前端组
          - label 后端组
      - label 产品部
```

### 对比类（Comparison）
适合：方案对比、SWOT 分析、优劣势

| 模板名 | 效果 |
|--------|------|
| `comparison-binary-simple` | 二元对比 |
| `comparison-swot-simple` | SWOT 分析 |
| `comparison-quadrant-simple` | 四象限 |

数据格式：
```
data
  title SWOT 分析
  compares
    - label 优势 Strengths
      children
        - label 技术领先
        - label 团队优秀
    - label 劣势 Weaknesses
      children
        - label 市场覆盖不足
```

### 关系类（Relation）
适合：网络图、流向图、关联关系

| 模板名 | 效果 |
|--------|------|
| `relation-circle-simple` | 环形关系 |
| `relation-network-simple` | 网络图 |
| `relation-dag-simple` | 有向无环图 |

数据格式：
```
data
  title 系统关系
  nodes
    - id A
      label 用户端
    - id B
      label 服务端
  relations
    A -> B
    B -> A
```

### 图表类（Chart）
适合：数据统计、饼图、柱状图、词云

| 模板名 | 效果 |
|--------|------|
| `chart-pie-simple` | 饼图 |
| `chart-bar-simple` | 柱状图 |
| `chart-column-simple` | 条形图 |
| `chart-line-simple` | 折线图 |
| `chart-wordcloud-simple` | 词云 |

数据格式：
```
data
  title 市场份额
  values
    - label 产品A
      value 45
    - label 产品B
      value 30
    - label 产品C
      value 25
```

## 主题配置

```
theme dark
```

或自定义：
```
theme
  colorBg #0b1220
  colorPrimary #ff5a5f
  palette #ff5a5f #1fb6ff #13ce66
  stylize rough
  roughness 0.3
```

常用主题：`default`、`dark`、`tech`

## 完整示例

```infographic
infographic list-row-horizontal-icon-arrow
data
  title 产品开发流程
  desc 从需求到上线的完整链路
  lists
    - label 需求分析
      desc 调研用户需求，确定产品方向
      icon search
    - label 产品设计
      desc UI/UX 设计，原型制作
      icon palette
    - label 开发实现
      desc 前后端编码，接口联调
      icon code
    - label 测试验收
      desc 功能测试，性能测试，UAT
      icon check-circle
    - label 正式上线
      desc 部署发布，监控运营
      icon rocket
theme
  colorPrimary #d97757
  palette #d97757 #e8a87c #f0c9a0 #888579 #29261b
```

## 注意事项

- 模板名使用英文小写 + 连字符格式
- 数据中的文字用中文（用户用中文时）
- icon 字段用英文关键词，引擎会自动匹配图标
- 每个代码块一张信息图
- 优先选择最贴合内容结构的模板类型
- 信息图 vs 技术图表：信息图侧重「精美展示」，技术图表（流程图/ER图/序列图）用 mermaid
