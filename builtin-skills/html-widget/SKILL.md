---
name: html-widget
description: 生成可交互的 HTML 可视化组件 — 算法动画、数据图表、概念演示、交互式教程等。当用户需要交互式演示、动画解释、数据探索、UI 原型等场景时触发，直接输出 html 代码块，前端会在安全沙箱中渲染为可交互组件。
trigger: 用户要求做图表、可视化、交互式演示、动画演示、数据展示、仪表盘、计数器、计时器、小工具、小游戏、算法可视化、UI 原型/mockup、交互式教程，或任何适合用交互/动画来呈现的内容
do-not-trigger: 能用 mermaid 解决的结构化图表（流程图、ER图、时序图）；能用 infographic 解决的数据海报/信息图；用户明确要求生成代码文件而非演示；纯文字能说清的简单问题
user-invocable: true
disable-auto-invoke: false
argument-hint: <交互组件描述>
tags:
  - 交互
  - interactive
  - 可视化
  - visualization
  - 动画
  - animation
  - widget
  - 演示
  - demo
  - 图表
  - chart
---

你现在帮用户生成 **可交互的 HTML 组件**。直接在回复中输出 ` ```html ` 代码块，前端会在安全沙箱 iframe 中自动渲染为可交互组件。

**重要规则**：
- **不要调用 generate_image 工具**，HTML 代码块就是最终输出
- **不要调用文件写入工具**（write_file 等）把 HTML 保存到本地——这是对话内的临时可视化，不是文件交付物
- **不要用 Artifacts 模式**——直接输出代码块即可
- **不要调用 report_plan / todo_write**——直接输出代码块，不需要规划步骤

## 何时用可视化 vs 写文件

| 用户意图 | 做法 |
|---------|------|
| "看看"、"分析一下"、"展示"、"解释"、"演示" | → 输出 ` ```html ` 代码块（可视化） |
| "导出"、"保存"、"生成报表"、"做个文件"、"发给领导" | → 调用 write_file（文件交付） |
| "分析数据，然后做个报表" | → 先可视化展示关键发现，再写文件 |

## 输出格式

输出 ` ```html ` 代码块，内容为 HTML 片段（**不含** `<!DOCTYPE>`、`<html>`、`<head>`、`<body>` 标签，这些由渲染器自动包裹）。

**必须按此顺序**：`<style>` → HTML 内容 → `<script>`

```html
<style>
  /* 样式在最前——流式渲染时尽早生效 */
</style>

<div id="app">
  <!-- HTML 结构——用户最先看到的内容 -->
</div>

<script>
  // 逻辑在最后——流式完成后才执行
</script>
```

## 尺寸规范

根据内容复杂度选择合适的尺寸：

| 类型 | 高度 | 适用场景 |
|------|------|---------|
| 紧凑型 | ≤150px | 单个指标卡片、迷你图、简单计数器 |
| 标准型 | 150-400px | 单个图表、数据表格、简单交互 |
| 完整型 | 400-700px | 仪表盘、多图表组合、复杂交互 |

- 宽度：始终自适应 100%
- body 已预设 16px 内边距

## 设计规范

> **核心审美原则**：克制、留白、精致。宁可简洁到"少了点什么"，也不要堆砌到"多了点什么"。每个像素都要有存在的理由。

### 配色体系

**必须使用浅色/白色背景**。禁止深色/黑色背景。

**基础色（CSS 变量，已预注入）**：

| 变量 | 用途 | 值 |
|------|------|-----|
| `--abu-primary` | 主色/强调色 | #d97757（暖橙） |
| `--abu-text` | 正文文字 | #29261b（深棕） |
| `--abu-text-muted` | 次要文字/辅助信息 | #888579（暖灰） |
| `--abu-bg` | 页面背景 | #ffffff |
| `--abu-bg-secondary` | 卡片/区块背景 | #f5f3ee（米白） |
| `--abu-border` | 边框/分割线 | #e5e2db（浅驼） |

**数据色板**（图表数据系列，按优先级排列）：

| 序号 | 色值 | 名称 | 适用 |
|------|------|------|------|
| 1 | `#4F46E5` | 靛蓝 | 默认首选、主数据系列 |
| 2 | `#0891B2` | 青色 | 对比系列 |
| 3 | `#10B981` | 翠绿 | 正向指标（增长/完成） |
| 4 | `#F59E0B` | 琥珀 | 警告/中性指标 |
| 5 | `#EF4444` | 赤红 | 负向指标（下降/错误） |
| 6 | `#7C3AED` | 紫色 | 补充系列 |
| 7 | `#EC4899` | 玫红 | 补充系列 |

**语义色**：
- 成功/增长：`#10B981`，搭配浅底 `#ecfdf5`
- 危险/下降：`#EF4444`，搭配浅底 `#fef2f2`
- 警告：`#F59E0B`，搭配浅底 `#fffbeb`
- 信息：`#4F46E5`，搭配浅底 `#eef2ff`

**配色原则**：
- 白色基底 + 单一强调色。一个组件最多 1 种强调色 + 数据色板
- 大面积只用白/米白/浅灰，色彩只用于数据点、状态标识、CTA 按钮
- 图表背景透明，不要给 chart container 加背景色
- 相邻数据系列色相间距 > 60°，确保色盲友好

### 间距系统（4px 网格）

所有间距使用 4 的倍数：

| token | 值 | 用途 |
|-------|-----|------|
| `--s-1` | 4px | 图标与文字间距、紧凑元素内边距 |
| `--s-2` | 8px | 相关元素间距、小卡片内边距 |
| `--s-3` | 12px | 组内元素间距、按钮组 gap |
| `--s-4` | 16px | 段落间距、卡片内边距（默认） |
| `--s-5` | 20px | 区块间距 |
| `--s-6` | 24px | 大卡片内边距、区块间隔 |
| `--s-8` | 32px | 主要分区间隔 |

用法示例：`padding: 16px`、`gap: 12px`、`margin-bottom: 24px`。不要出现 5px、7px、15px 这种非 4 倍数值。

### 圆角

| 场景 | 值 |
|------|-----|
| 小元素（标签、徽章） | `4px` |
| 按钮、输入框 | `6px` |
| 卡片、面板 | `10px` |
| 大容器、模态框 | `12px` |

统一使用 `border-radius`，不要混用不同的圆角值。一个组件内圆角值最多 2 种。

### 字体与排版

- **字体栈**：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
- **字重**：仅 `400`（正文）和 `600`（标题/强调），禁用 300/500/700/800
- **等宽数字**：数值型内容加 `font-variant-numeric: tabular-nums` 确保对齐

| 层级 | 字号 | 字重 | 行高 | 用途 |
|------|------|------|------|------|
| 大标题 | 24px | 600 | 1.3 | 仪表盘主标题 |
| 标题 | 18px | 600 | 1.4 | 区块标题、图表标题 |
| 小标题 | 15px | 600 | 1.5 | 卡片标题 |
| 正文 | 14px | 400 | 1.6 | 默认正文 |
| 辅助 | 12px | 400 | 1.5 | 标签、图例、脚注、数据来源 |
| 超大数字 | 28-36px | 600 | 1.2 | KPI 核心数值 |

**中文排版规则**：
- 中英文/中文与数字之间加半角空格：`GDP 总量 101.4 万亿`
- 数字千分位：`¥1,234,567`
- 日期格式：`2024 年 3 月` 或 `2024-03-15`
- 百分比：正数加 `+` 号 → `+12.3%`
- 标点用中文全角：`，` `。` `、` `（` `）`

### 组件模式

#### 卡片（Card）

```css
.card {
  background: var(--abu-bg-secondary);
  border-radius: 10px;
  padding: 16px;
}
.card-title {
  font-size: 12px;
  font-weight: 400;
  color: var(--abu-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
```

- 卡片之间 gap `12px`
- 卡片内不要再嵌套卡片（最多一层）
- 卡片标题用辅助字号（12px）+ muted 色，不要用大标题

#### KPI 指标卡

```css
.kpi-value {
  font-size: 28px;
  font-weight: 600;
  color: var(--abu-text);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.kpi-trend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  margin-top: 4px;
  padding: 2px 6px;
  border-radius: 4px;
}
.kpi-trend.up { color: #10B981; background: #ecfdf5; }
.kpi-trend.down { color: #EF4444; background: #fef2f2; }
```

- 趋势指示用 `↑` `↓` 字符 + 语义色背景标签，而不是纯文字
- 数值居左对齐，不要居中

#### 数据表格（Table）

```css
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}
.data-table th {
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--abu-text-muted);
  padding: 8px 12px;
  border-bottom: 2px solid var(--abu-border);
}
.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--abu-border);
  color: var(--abu-text);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: var(--abu-bg-secondary); }
```

- 表头用小字 + 大写 + muted 色，营造层次感
- 数字列右对齐 + `tabular-nums`
- 不要给表格加外边框，只用行分割线

#### 标签页（Tabs）

```css
.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--abu-border);
  margin-bottom: 16px;
}
.tab {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--abu-text-muted);
  border: none;
  background: none;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.tab:hover { color: var(--abu-text); }
.tab.active {
  color: var(--abu-primary);
  border-bottom-color: var(--abu-primary);
  font-weight: 600;
}
```

#### 徽章/标签（Badge）

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
  letter-spacing: 0.3px;
}
.badge-success { color: #10B981; background: #ecfdf5; }
.badge-danger { color: #EF4444; background: #fef2f2; }
.badge-warning { color: #D97706; background: #fffbeb; }
.badge-info { color: #4F46E5; background: #eef2ff; }
```

#### 进度条（Progress Bar）

```css
.progress-track {
  height: 6px;
  background: var(--abu-border);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--abu-primary);
  transition: width 0.4s ease;
}
```

#### 分割线

```css
.divider {
  height: 1px;
  background: var(--abu-border);
  margin: 16px 0;
}
```

### 按钮

基础按钮样式已预设在渲染器中，直接用 `<button>` 即可。

```css
/* 主要操作 */
.btn-primary {
  background: var(--abu-primary);
  color: #fff;
  border-color: var(--abu-primary);
}
.btn-primary:hover { opacity: 0.9; }

/* 次要操作 */
.btn-secondary {
  background: var(--abu-bg-secondary);
  border-color: var(--abu-border);
}

/* 小按钮 */
.btn-sm { padding: 4px 8px; font-size: 12px; }

/* 按钮组 */
.btn-group { display: inline-flex; gap: 8px; }
```

- 按钮文字简洁：2-4 个字（`开始` `重置` `下一步`）
- 一组操作最多 1 个主要按钮，其余用默认样式
- 禁用态：`opacity: 0.5; pointer-events: none`

### 布局模式

#### 网格仪表盘

```css
.grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
```

- KPI 行：3-4 列
- 图表区：1 列（全宽）或 2 列
- 不要超过 4 列

#### Flex 布局

```css
.flex-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}
```

#### 标准页面结构

```
┌─ 标题区（标题 + 副标题/数据来源）──────────────────┐
│                                                      │
├─ KPI 行（3-4 个指标卡片）──────────────────────────┤
│                                                      │
├─ 主图表区（全宽或左右分栏）────────────────────────┤
│                                                      │
├─ 辅助区（表格/列表/补充图表）──────────────────────┤
│                                                      │
└─ 脚注（数据来源、时间戳）──────────────────────────┘
```

### 图表规范

#### Chart.js 标准配置

```javascript
// 全局默认值（在创建图表前设置）
Chart.defaults.font.family = "system-ui, -apple-system, 'PingFang SC', sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.color = '#888579';
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 8;
Chart.defaults.plugins.legend.labels.boxHeight = 8;
Chart.defaults.plugins.legend.labels.padding = 16;

// 推荐配置
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'bottom',           // 图例放底部，不占标题空间
      labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 16 }
    },
    tooltip: {
      backgroundColor: '#29261b',
      titleFont: { size: 13 },
      bodyFont: { size: 12 },
      padding: 10,
      cornerRadius: 6,
      displayColors: true,
    }
  },
  scales: {
    x: {
      grid: { display: false },       // X 轴隐藏网格线
      ticks: { font: { size: 12 } },
      border: { color: '#e5e2db' }
    },
    y: {
      grid: { color: '#f5f3ee' },     // Y 轴用极浅网格线
      ticks: { font: { size: 12 } },
      border: { display: false }
    }
  }
};
```

#### ECharts 标准配置

```javascript
const echartsTheme = {
  backgroundColor: 'transparent',
  textStyle: { fontFamily: "system-ui, -apple-system, 'PingFang SC', sans-serif" },
  title: { textStyle: { fontSize: 16, fontWeight: 600, color: '#29261b' } },
  legend: { bottom: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 12, color: '#888579' } },
  grid: { left: 60, right: 20, top: 40, bottom: 50, containLabel: false },
  xAxis: { axisLine: { lineStyle: { color: '#e5e2db' } }, splitLine: { show: false } },
  yAxis: { axisLine: { show: false }, splitLine: { lineStyle: { color: '#f5f3ee' } } },
  tooltip: {
    backgroundColor: '#29261b', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 },
    padding: [8, 12], extraCssText: 'border-radius: 6px;'
  },
  color: ['#4F46E5', '#0891B2', '#10B981', '#F59E0B', '#EF4444', '#7C3AED', '#EC4899']
};
```

#### 图表设计原则

- **标题在图表外部**用 HTML 写，不用 Chart.js/ECharts 内置标题
- **图例放底部**，用圆点样式，不要用方块
- **网格线极淡**（`#f5f3ee`）或隐藏，不要用深色
- **柱状图**：圆角 `borderRadius: 6`，柱宽适中不要太细
- **折线图**：线宽 `2px`，圆点 `4px`，hover `6px`
- **饼图/环图**：环图优先（更现代），中间显示总计
- **数值格式化**：Y 轴大数字用 `万` `亿` 单位，tooltip 显示完整数字
- **脚注生成时间**：不要硬编码日期，用 `<span class="generated-date"></span>` 占位，JS 中用 `new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')` 动态填充

### 动画与交互

- **过渡**：仅 `background`、`color`、`border-color`、`opacity`、`transform`，时长 `0.15s`
- **hover 效果**：卡片 `background` 微调亮度，按钮 `opacity: 0.9` 或 `background` 变色
- **可点击元素**：必须有 `cursor: pointer` + hover 视觉变化
- **禁止**：`box-shadow` 变化、`filter: blur()`、大幅 `transform` 动画（流式渲染不兼容）
- **图表动画**：使用库内置动画即可（Chart.js 默认 1s easing），不要自定义复杂动画

### 禁止清单

- ❌ 深色/黑色背景
- ❌ 渐变（`linear-gradient` / `radial-gradient`）
- ❌ 阴影（`box-shadow`）、模糊（`filter: blur`）
- ❌ `position: fixed`（iframe 内无效）
- ❌ localStorage / sessionStorage（sandbox 限制）
- ❌ fetch / XHR 网络请求（所有数据内联）
- ❌ ES module `import`（用 `<script src="">` 引入）
- ❌ 非 4 倍数间距（5px, 7px, 15px 等）
- ❌ 超过 2 种字重（只能 400 和 600）
- ❌ 纯装饰性元素（无意义的 icon、分隔符、装饰线条）
- ❌ 手写 SVG icon（用 Unicode 字符替代：`↑` `↓` `●` `▶` `◀` `✓` `✕` `→`）

### 可用外部库（CDN）

```html
<!-- 图表 -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>

<!-- 动画 -->
<script src="https://cdn.jsdelivr.net/npm/animejs@3"></script>
```

可用 CDN 前缀：`cdn.jsdelivr.net` / `cdnjs.cloudflare.com` / `unpkg.com` / `esm.sh`

**库选择指南**：
- 简单柱/线/饼图 → **Chart.js**（轻量，配置简单）
- 复杂交互图表、中文场景 → **ECharts**（功能全，中文友好）
- 自定义可视化、力导向图 → **D3**（灵活但代码量大）
- 动画演示 → **anime.js**

**注意**：外部脚本和内联脚本按顺序执行（渲染器已处理加载顺序）。**不要用 `window.onload` 包裹代码**，直接写即可。

## 场景模板

### 指标卡片（紧凑型）

```html
<style>
  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .kpi-card { background: var(--abu-bg-secondary); border-radius: 10px; padding: 16px; }
  .kpi-label { font-size: 11px; font-weight: 400; color: var(--abu-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi-value { font-size: 28px; font-weight: 600; color: var(--abu-text); font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 8px; }
  .kpi-trend { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; margin-top: 8px; padding: 2px 8px; border-radius: 4px; }
  .kpi-trend.up { color: #10B981; background: #ecfdf5; }
  .kpi-trend.down { color: #EF4444; background: #fef2f2; }
</style>
<div class="kpi-row">
  <div class="kpi-card">
    <div class="kpi-label">总销售额</div>
    <div class="kpi-value">¥284.7 万</div>
    <div class="kpi-trend up">↑ 12.3% 环比</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">订单量</div>
    <div class="kpi-value">3,842</div>
    <div class="kpi-trend down">↓ 3.1% 环比</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">客单价</div>
    <div class="kpi-value">¥741</div>
    <div class="kpi-trend up">↑ 5.8% 环比</div>
  </div>
</div>
```

### 数据图表（标准型）

```html
<style>
  .chart-header { margin-bottom: 16px; }
  .chart-title { font-size: 18px; font-weight: 600; color: var(--abu-text); }
  .chart-subtitle { font-size: 12px; color: var(--abu-text-muted); margin-top: 4px; }
  .chart-wrap { position: relative; height: 320px; }
</style>
<div class="chart-header">
  <div class="chart-title">2020–2025 年 GDP 增长趋势</div>
  <div class="chart-subtitle">数据来源：国家统计局 · 单位：万亿元</div>
</div>
<div class="chart-wrap">
  <canvas id="chart"></canvas>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
(function() {
  Chart.defaults.font.family = "system-ui, -apple-system, 'PingFang SC', sans-serif";
  Chart.defaults.color = '#888579';
  new Chart(document.getElementById('chart'), {
    type: 'bar',
    data: {
      labels: ['2020', '2021', '2022', '2023', '2024', '2025'],
      datasets: [{
        label: 'GDP（万亿元）',
        data: [101.4, 114.9, 121.0, 126.1, 134.9, 140.2],
        backgroundColor: '#4F46E5',
        borderRadius: 6,
        maxBarThickness: 48,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#29261b', cornerRadius: 6, padding: 10,
          titleFont: { size: 13 }, bodyFont: { size: 12 }
        }
      },
      scales: {
        x: { grid: { display: false }, border: { color: '#e5e2db' } },
        y: { grid: { color: '#f5f3ee' }, border: { display: false }, beginAtZero: false }
      }
    }
  });
})();
</script>
```

### 交互式演示（标准型）

```html
<style>
  .demo-header { margin-bottom: 16px; }
  .demo-title { font-size: 18px; font-weight: 600; color: var(--abu-text); }
  .demo-desc { font-size: 12px; color: var(--abu-text-muted); margin-top: 4px; }
  .stage { position: relative; height: 240px; border: 1px solid var(--abu-border); border-radius: 10px; overflow: hidden; background: var(--abu-bg-secondary); }
  .controls { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 12px; }
  .info { font-size: 13px; color: var(--abu-text-muted); text-align: center; margin-top: 8px; }
</style>
<div class="demo-header">
  <div class="demo-title">冒泡排序可视化</div>
  <div class="demo-desc">点击"下一步"逐步观察排序过程</div>
</div>
<div class="stage" id="stage"></div>
<div class="controls">
  <button onclick="prev()">◀ 上一步</button>
  <button class="btn-primary" onclick="next()">下一步 ▶</button>
  <button onclick="autoPlay()">自动播放</button>
</div>
<div class="info" id="info">已就绪，共 8 个元素</div>
<script>
  // 演示逻辑...
</script>
```

### 数据表格 + 图表组合（完整型）

```html
<style>
  .page-header { margin-bottom: 20px; }
  .page-title { font-size: 24px; font-weight: 600; color: var(--abu-text); }
  .page-subtitle { font-size: 12px; color: var(--abu-text-muted); margin-top: 4px; }
  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .kpi-card { background: var(--abu-bg-secondary); border-radius: 10px; padding: 16px; }
  .kpi-label { font-size: 11px; color: var(--abu-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi-value { font-size: 28px; font-weight: 600; color: var(--abu-text); font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 8px; }
  .kpi-trend { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; margin-top: 8px; padding: 2px 8px; border-radius: 4px; }
  .kpi-trend.up { color: #10B981; background: #ecfdf5; }
  .kpi-trend.down { color: #EF4444; background: #fef2f2; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 15px; font-weight: 600; color: var(--abu-text); margin-bottom: 12px; }
  .chart-wrap { position: relative; height: 300px; background: var(--abu-bg-secondary); border-radius: 10px; padding: 16px; }
  .data-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
  .data-table th { text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--abu-text-muted); padding: 8px 12px; border-bottom: 2px solid var(--abu-border); }
  .data-table td { padding: 10px 12px; border-bottom: 1px solid var(--abu-border); }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .footnote { font-size: 11px; color: var(--abu-text-muted); margin-top: 16px; }
</style>

<div class="page-header">
  <div class="page-title">Q4 销售分析报告</div>
  <div class="page-subtitle">2024 年 10–12 月 · 数据截至 2024-12-31</div>
</div>

<div class="kpi-row">
  <div class="kpi-card">
    <div class="kpi-label">总营收</div>
    <div class="kpi-value">¥847 万</div>
    <div class="kpi-trend up">↑ 15.2%</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">订单数</div>
    <div class="kpi-value">12,458</div>
    <div class="kpi-trend up">↑ 8.7%</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">客单价</div>
    <div class="kpi-value">¥679</div>
    <div class="kpi-trend down">↓ 2.1%</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">退货率</div>
    <div class="kpi-value">3.2%</div>
    <div class="kpi-trend up">↑ 0.4pp</div>
  </div>
</div>

<div class="section">
  <div class="section-title">月度趋势</div>
  <div class="chart-wrap"><canvas id="chart"></canvas></div>
</div>

<div class="section">
  <div class="section-title">分品类明细</div>
  <table class="data-table">
    <thead><tr><th>品类</th><th class="num">营收</th><th class="num">占比</th><th class="num">同比</th></tr></thead>
    <tbody>
      <tr><td>电子产品</td><td class="num">¥3,240,000</td><td class="num">38.2%</td><td class="num" style="color:#10B981">+22.1%</td></tr>
      <tr><td>家居用品</td><td class="num">¥2,180,000</td><td class="num">25.7%</td><td class="num" style="color:#10B981">+11.5%</td></tr>
      <tr><td>服装配饰</td><td class="num">¥1,850,000</td><td class="num">21.8%</td><td class="num" style="color:#EF4444">-3.2%</td></tr>
      <tr><td>食品饮料</td><td class="num">¥1,200,000</td><td class="num">14.2%</td><td class="num" style="color:#10B981">+8.9%</td></tr>
    </tbody>
  </table>
</div>

<div class="footnote">数据来源：内部销售系统 · 生成时间：<span class="generated-date"></span></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
(function() {
  Chart.defaults.font.family = "system-ui, -apple-system, 'PingFang SC', sans-serif";
  // 动态填充生成日期
  var dateEl = document.querySelector('.generated-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  Chart.defaults.color = '#888579';
  new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels: ['10 月', '11 月', '12 月'],
      datasets: [
        { label: '营收（万元）', data: [265, 278, 304], borderColor: '#4F46E5', backgroundColor: 'rgba(79,70,229,0.08)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6, borderWidth: 2 },
        { label: '订单数（百）', data: [38, 41, 45], borderColor: '#0891B2', backgroundColor: 'transparent', tension: 0.3, pointRadius: 4, pointHoverRadius: 6, borderWidth: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 16 } },
        tooltip: { backgroundColor: '#29261b', cornerRadius: 6, padding: 10 }
      },
      scales: {
        x: { grid: { display: false }, border: { color: '#e5e2db' } },
        y: { grid: { color: '#f5f3ee' }, border: { display: false } }
      }
    }
  });
})();
</script>
```

## UI 原型 / Mockup 规范

当用户要求"画个原型"、"做个 mockup"、"设计一个页面"时，生成**高保真静态原型**，模拟真实 App/Web 界面。

### 原型设计原则

- **看起来像真的 App**，不是线框图——用真实文字、真实数据、真实图标
- **固定宽度模拟设备**：手机 `375px`、平板 `768px`、桌面 `1024px`，居中显示
- **所有文字用中文**，数据用逼真的假数据
- **交互仅限视觉反馈**：hover 态、active 态、tab 切换，不做真实业务逻辑
- **多页面支持**：用 JS 切换 `display` 实现页面导航，不要用 iframe 或多个 HTML 文件

### 原型色彩

原型不一定用 Abu 品牌色，根据产品类型选择合适的主色：

| 产品类型 | 推荐主色 | 辅色 |
|---------|---------|------|
| 企业/SaaS | `#4F46E5`（靛蓝） | `#6366F1` |
| 电商 | `#EF4444`（红）或 `#F97316`（橙） | `#FCA5A5` |
| 社交/内容 | `#0EA5E9`（天蓝） | `#38BDF8` |
| 金融 | `#0891B2`（青）或 `#1D4ED8`（深蓝） | `#67E8F9` |
| 健康/生活 | `#10B981`（绿） | `#6EE7B7` |
| 工具/效率 | `#6366F1`（紫）或 `#8B5CF6` | `#A78BFA` |
| 通用/默认 | `#4F46E5` | `#818CF8` |

### 原型组件模式

#### 手机顶部导航栏（Status Bar + Nav）

```css
.phone-frame {
  width: 375px;
  margin: 0 auto;
  background: #fff;
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid var(--abu-border);
}
.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 20px;
  font-size: 12px;
  font-weight: 600;
  color: #1a1a1a;
}
.nav-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 17px;
  font-weight: 600;
}
```

#### 底部标签栏（Tab Bar）

```css
.tab-bar {
  display: flex;
  border-top: 1px solid #f0f0f0;
  background: #fff;
  padding: 6px 0 20px;
}
.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  color: #999;
  cursor: pointer;
}
.tab-item.active { color: var(--app-primary); }
.tab-icon { font-size: 20px; }
```

#### 列表项（List Cell）

```css
.list-cell {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  gap: 12px;
  border-bottom: 1px solid #f5f5f5;
  cursor: pointer;
}
.list-cell:hover { background: #fafafa; }
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: linear-gradient(135deg, #667eea, #764ba2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  flex-shrink: 0;
}
```

#### 卡片/内容块

```css
.content-card {
  margin: 0 16px 12px;
  background: #f8f8f8;
  border-radius: 12px;
  padding: 16px;
}
```

#### 输入框 / 搜索框

```css
.search-bar {
  margin: 8px 16px;
  padding: 10px 12px;
  background: #f5f5f5;
  border-radius: 10px;
  font-size: 14px;
  color: #999;
  display: flex;
  align-items: center;
  gap: 8px;
}
```

#### 浮动按钮（FAB）

```css
.fab {
  position: absolute;
  right: 20px;
  bottom: 80px;
  width: 56px;
  height: 56px;
  border-radius: 28px;
  background: var(--app-primary);
  color: #fff;
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: none;
}
```

### 多页面导航模式

多页面原型通过 JS 切换 `display` 实现，所有页面 HTML 共存于 DOM 中，用 `data-page` 属性标识。

**核心架构**：

```css
/* 页面容器 */
.page { display: none; }
.page.active { display: flex; flex-direction: column; }

/* 转场动画（可选） */
.page { opacity: 0; transition: opacity 0.2s ease; }
.page.active { opacity: 1; }
```

```javascript
// 页面切换（全局函数）
function goTo(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  // 更新底部 tab 高亮
  document.querySelectorAll('.tab-item').forEach(t => {
    t.classList.toggle('active', t.dataset.page === pageId);
  });
}
```

**底部 Tab 切换**（主导航）：
- 点击 Tab → `goTo('page-xxx')` → 同时高亮当前 Tab
- Tab Bar 固定在 phone-frame 底部，所有页面共享

**页面内跳转**（子页面/详情页）：
- 列表项点击 → `goTo('page-detail')` → 顶部 nav 显示返回按钮
- 返回按钮 → `goTo('page-xxx')` 回到来源页

**页面结构规范**：
```html
<div class="phone-frame">
  <!-- 所有页面 -->
  <div class="page active" id="page-home">
    <!-- 顶部固定区：status bar + nav -->
    <!-- 中间滚动区：内容 -->
    <!-- 底部固定区：tab bar（主页面有，子页面无） -->
  </div>
  <div class="page" id="page-discover">...</div>
  <div class="page" id="page-profile">...</div>
  <div class="page" id="page-detail">...</div>
</div>
```

**页面布局（每个 page 内部）**：
```css
.page {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  flex-direction: column;
  overflow: hidden;
}
.page-header { flex-shrink: 0; }
.page-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.page-footer { flex-shrink: 0; }
```

**注意**：
- 页面数量控制在 3–5 个，不要太多（代码量会爆）
- 底部 Tab Bar 只在主页面显示（一般 3–5 个 tab），详情页/子页面不显示 Tab Bar
- 首页默认 `class="page active"`，其余页面无 `active`
- 代码量可放宽到 400 行以内（多页面场景）

### 原型模板：多页手机 App

```html
<style>
  :root { --app-primary: #4F46E5; --app-primary-light: #EEF2FF; --app-bg: #f5f5f5; }
  * { box-sizing: border-box; }

  .phone-frame {
    width: 375px; height: 720px; margin: 0 auto;
    background: var(--app-bg); border-radius: 20px;
    overflow: hidden; border: 1px solid #e5e5e5;
    position: relative;
  }

  /* 页面系统 */
  .page { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; flex-direction: column; opacity: 0; transition: opacity 0.2s ease; }
  .page.active { display: flex; opacity: 1; }

  /* 状态栏 */
  .status-bar { display: flex; justify-content: space-between; padding: 10px 20px 6px; font-size: 12px; font-weight: 600; background: #fff; flex-shrink: 0; }

  /* 导航栏 */
  .nav-bar { display: flex; align-items: center; padding: 4px 16px 12px; background: #fff; flex-shrink: 0; }
  .nav-back { font-size: 22px; cursor: pointer; margin-right: 8px; color: var(--app-primary); border: none; background: none; padding: 4px; }
  .nav-title { font-size: 17px; font-weight: 600; flex: 1; }
  .nav-title.large { font-size: 28px; font-weight: 700; }
  .nav-action { font-size: 20px; cursor: pointer; }

  /* 内容区 */
  .page-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }

  /* 底部 Tab Bar */
  .tab-bar { display: flex; background: #fff; border-top: 1px solid #f0f0f0; padding: 6px 0 20px; flex-shrink: 0; }
  .tab-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 10px; color: #999; cursor: pointer; border: none; background: none; padding: 4px; }
  .tab-item.active { color: var(--app-primary); }
  .tab-icon { font-size: 20px; line-height: 1; }
</style>

<div class="phone-frame">
  <!-- ====== 首页 ====== -->
  <div class="page active" id="page-home">
    <div class="status-bar"><span>9:41</span><span>● ● ●</span></div>
    <div class="nav-bar">
      <div class="nav-title large">首页</div>
      <div class="nav-action">🔔</div>
    </div>
    <div class="page-body">
      <!-- 首页内容... -->
    </div>
    <div class="tab-bar">
      <button class="tab-item active" data-page="page-home" onclick="goTo('page-home')">
        <span class="tab-icon">◉</span>首页
      </button>
      <button class="tab-item" data-page="page-discover" onclick="goTo('page-discover')">
        <span class="tab-icon">⌕</span>发现
      </button>
      <button class="tab-item" data-page="page-profile" onclick="goTo('page-profile')">
        <span class="tab-icon">☺</span>我的
      </button>
    </div>
  </div>

  <!-- ====== 发现页 ====== -->
  <div class="page" id="page-discover">
    <div class="status-bar"><span>9:41</span><span>● ● ●</span></div>
    <div class="nav-bar"><div class="nav-title large">发现</div></div>
    <div class="page-body">
      <!-- 发现页内容... -->
    </div>
    <div class="tab-bar">
      <button class="tab-item" data-page="page-home" onclick="goTo('page-home')">
        <span class="tab-icon">◉</span>首页
      </button>
      <button class="tab-item active" data-page="page-discover" onclick="goTo('page-discover')">
        <span class="tab-icon">⌕</span>发现
      </button>
      <button class="tab-item" data-page="page-profile" onclick="goTo('page-profile')">
        <span class="tab-icon">☺</span>我的
      </button>
    </div>
  </div>

  <!-- ====== 详情页（子页面，无 Tab Bar） ====== -->
  <div class="page" id="page-detail">
    <div class="status-bar"><span>9:41</span><span>● ● ●</span></div>
    <div class="nav-bar">
      <button class="nav-back" onclick="goTo('page-home')">‹</button>
      <div class="nav-title">详情</div>
      <div class="nav-action">↗</div>
    </div>
    <div class="page-body">
      <!-- 详情页内容... -->
    </div>
  </div>
</div>

<script>
function goTo(pageId) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById(pageId).classList.add('active');
  document.querySelectorAll('.tab-item').forEach(function(t) {
    t.classList.toggle('active', t.dataset.page === pageId);
  });
}
</script>
```

### 原型模板：单页手机 App

```html
<style>
  :root { --app-primary: #4F46E5; --app-primary-light: #EEF2FF; }
  .phone-frame { width: 375px; margin: 0 auto; background: #fff; border-radius: 20px; overflow: hidden; border: 1px solid #e5e5e5; position: relative; min-height: 680px; }
  .status-bar { display: flex; justify-content: space-between; padding: 10px 20px 6px; font-size: 12px; font-weight: 600; }
  .nav-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 16px 12px; }
  .nav-title { font-size: 28px; font-weight: 700; }
  .nav-action { font-size: 20px; cursor: pointer; }
</style>

<div class="phone-frame">
  <div class="status-bar">
    <span>9:41</span>
    <span>● ● ●</span>
  </div>
  <div class="nav-bar">
    <div class="nav-title">标题</div>
    <div class="nav-action">⊕</div>
  </div>
  <!-- 页面内容 -->
</div>
```

### 原型中的图标

不用引入图标库，使用 Unicode/Emoji 字符模拟：

| 场景 | 字符 |
|------|------|
| 首页 | ◉ |
| 搜索 | ⌕ |
| 消息 | ✉ |
| 我的 | ☺ |
| 设置 | ⚙ |
| 返回 | ‹ |
| 更多 | ⋯ |
| 添加 | ⊕ |
| 关闭 | ✕ |
| 勾选 | ✓ |
| 收藏 | ☆ / ★ |
| 分享 | ↗ |
| 通知 | 🔔 |
| 图片 | 🏞 |
| 购物车 | 🛒 |
| 点赞 | ♡ / ♥ |

### 原型注意事项

- **原型中允许使用渐变和阴影**（与普通 widget 不同），因为原型不需要流式预览效果
- 头像用渐变色块 + 首字母替代真实图片
- 图片占位用纯色矩形 + emoji 图标（如 `🏞`）
- 内容文字用逼真但虚构的数据，不要用 "Lorem ipsum" 或 "测试文字"
- 底部留出安全区域（`padding-bottom: 20px`）模拟 iPhone Home Indicator

## 注意事项

1. **所有数据内联**：直接写在 JS 中，不要 fetch
2. **初始状态有意义**：加载后立即展示内容，不要空白等用户操作
3. **交互反馈**：可点击元素必须有 hover/active 视觉反馈
4. **中文优先**：UI 文字使用中文
5. **简洁代码**：普通组件控制在 200 行以内，多页面原型可放宽到 400 行，不要过度工程化
6. **流式友好**：style 在前，HTML 在中，script 在后——用户先看到结构，最后才激活交互
