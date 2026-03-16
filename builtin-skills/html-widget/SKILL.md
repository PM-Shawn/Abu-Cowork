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

### 配色

**必须使用浅色/白色背景**。禁止深色/黑色背景。

| 变量 | 用途 | 值 |
|------|------|-----|
| `var(--abu-primary)` | 主色/强调色 | #d97757 |
| `var(--abu-text)` | 正文文字 | #29261b |
| `var(--abu-text-muted)` | 次要文字 | #888579 |
| `var(--abu-bg)` | 背景色 | #ffffff |
| `var(--abu-bg-secondary)` | 卡片/区块背景 | #f5f3ee |
| `var(--abu-border)` | 边框 | #e5e2db |

**数据色**（图表数据系列用）：
- 蓝 `#4F46E5`、紫 `#7C3AED`、青 `#0891B2`、绿 `#10B981`
- 橙 `#F59E0B`、红 `#EF4444`、粉 `#EC4899`

**配色原则**：白色基底 + 彩色数据。容器/背景保持白色或 `var(--abu-bg-secondary)`，数据用鲜明色彩突出。

### 字体与中文排版

- 字体栈：`system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
- 字重：只用 400（正常）和 600（加粗）
- 正文 14px，小字 12px，标题 18-24px
- 行高 1.6
- **中英文之间加空格**：`GDP 总量` 不是 `GDP总量`
- **数字千分位**：`¥1,234,567` 不是 `¥1234567`
- **日期**：`2024 年 3 月` 或 `2024-03-15`
- **百分比**：`+12.3%`，正数加 `+` 号

### 按钮

基础按钮样式已预设，直接用 `<button>` 即可。强调按钮：

```css
.btn-primary {
  background: var(--abu-primary);
  color: #fff;
  border-color: var(--abu-primary);
}
```

### 禁止

- ❌ 深色/黑色背景
- ❌ 渐变、阴影、blur（流式渲染闪烁）
- ❌ `position: fixed`（iframe 内无效）
- ❌ localStorage / sessionStorage（sandbox 限制）
- ❌ fetch / XHR 网络请求（所有数据内联）
- ❌ ES module import（用 `<script src="">` 引入）

### 可用外部库（CDN）

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
```

可用 CDN：`cdn.jsdelivr.net` / `cdnjs.cloudflare.com` / `unpkg.com`

常用库：Chart.js（简单图表）、ECharts（复杂图表/中文友好）、D3（自定义可视化）、anime.js（动画）

**注意**：外部脚本和内联脚本按顺序执行（渲染器已处理加载顺序）。**不要用 `window.onload` 包裹代码**，直接写即可。

## 场景模板

### 指标卡片（紧凑型）

```html
<style>
  .kpi { display: flex; gap: 12px; }
  .kpi-card { flex: 1; background: var(--abu-bg-secondary); border-radius: 10px; padding: 16px; }
  .kpi-label { font-size: 12px; color: var(--abu-text-muted); margin-bottom: 4px; }
  .kpi-value { font-size: 24px; font-weight: 600; color: var(--abu-text); }
  .kpi-trend { font-size: 12px; margin-top: 4px; }
  .kpi-trend.up { color: #10B981; }
  .kpi-trend.down { color: #EF4444; }
</style>
<div class="kpi">
  <div class="kpi-card">
    <div class="kpi-label">总销售额</div>
    <div class="kpi-value">¥2,847,500</div>
    <div class="kpi-trend up">↑ 12.3% 环比</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">订单量</div>
    <div class="kpi-value">3,842</div>
    <div class="kpi-trend down">↓ 3.1% 环比</div>
  </div>
</div>
```

### 数据图表（标准型）

```html
<style>
  .chart-header { text-align: center; margin-bottom: 16px; }
  .chart-title { font-size: 18px; font-weight: 600; color: var(--abu-text); }
  .chart-subtitle { font-size: 12px; color: var(--abu-text-muted); margin-top: 4px; }
</style>
<div class="chart-header">
  <div class="chart-title">2020-2025 年 GDP 增长趋势</div>
  <div class="chart-subtitle">数据来源：国家统计局 | 单位：万亿元</div>
</div>
<canvas id="chart" style="width:100%;max-height:350px"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
// 直接执行，不要包裹在 window.onload 中
(function() {
  new Chart(document.getElementById('chart'), {
    type: 'bar',
    data: {
      labels: ['2020', '2021', '2022', '2023', '2024', '2025'],
      datasets: [{
        label: 'GDP（万亿元）',
        data: [101.4, 114.9, 121.0, 126.1, 134.9, 140.2],
        backgroundColor: '#4F46E5',
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: false, ticks: { font: { size: 12 } } },
        x: { ticks: { font: { size: 12 } } }
      }
    }
  });
})();
</script>
```

### 交互式演示（标准型）

```html
<style>
  .demo { text-align: center; }
  .stage { position: relative; height: 200px; border: 1px solid var(--abu-border); border-radius: 8px; overflow: hidden; margin: 12px 0; }
  .controls { display: flex; gap: 8px; justify-content: center; }
  .info { font-size: 13px; color: var(--abu-text-muted); margin-top: 8px; }
</style>
<div class="demo">
  <div class="stage" id="stage"></div>
  <div class="controls">
    <button onclick="prev()">◀ 上一步</button>
    <button onclick="next()">下一步 ▶</button>
    <button onclick="autoPlay()">▶ 自动播放</button>
  </div>
  <div class="info" id="info">点击"下一步"开始</div>
</div>
<script>
  // 演示逻辑...
</script>
```

### 仪表盘（完整型）

```html
<style>
  .dashboard { display: grid; gap: 12px; }
  .dashboard-top { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .dashboard-chart { background: var(--abu-bg-secondary); border-radius: 10px; padding: 16px; margin-top: 4px; }
  .kpi-card { background: var(--abu-bg-secondary); border-radius: 10px; padding: 16px; }
  .kpi-label { font-size: 12px; color: var(--abu-text-muted); }
  .kpi-value { font-size: 22px; font-weight: 600; color: var(--abu-text); margin-top: 4px; }
</style>
<div class="dashboard">
  <div class="dashboard-top">
    <!-- 3个 KPI 卡片 -->
  </div>
  <div class="dashboard-chart">
    <canvas id="chart" style="width:100%;height:300px"></canvas>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
// 直接执行，不要包裹在 window.onload 中
(function() {
  // 图表初始化...
})();
</script>
```

## 注意事项

1. **所有数据内联**：直接写在 JS 中，不要 fetch
2. **初始状态有意义**：加载后立即展示内容，不要空白等用户操作
3. **交互反馈**：可点击元素必须有 hover/active 视觉反馈
4. **中文优先**：UI 文字使用中文
5. **简洁代码**：一个组件控制在 200 行以内，不要过度工程化
6. **流式友好**：style 在前，HTML 在中，script 在后——用户先看到结构，最后才激活交互
