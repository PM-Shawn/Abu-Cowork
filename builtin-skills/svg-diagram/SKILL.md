---
name: svg-diagram
description: 用 SVG 生成精美的架构图、流程图、时序图、层级图、对比图等结构化图表。直接输出 ```html 代码块（内含 SVG），前端在沙箱 iframe 中渲染。效果比 Mermaid 更美观、布局更灵活。
trigger: 用户要求画流程图、架构图、序列图、系统架构、技术架构、层级图、部署图、拓扑图、数据流、状态机、对比图、关系图、组织结构图、路线图、思维导图，或任何结构化的图表/可视化需求
do-not-trigger: 用户要求生成照片、插画、艺术画、海报、UI 设计图、Logo（用 generate_image）；用户要求做数据统计海报（用 infographic）；用户要求做交互/动画/按钮操作的组件（用 html-widget）；用户要求数据图表如折线图/柱状图/饼图（用 html-widget + Chart.js）
user-invocable: true
disable-auto-invoke: true
argument-hint: <图表描述>
tags:
  - 图表
  - diagram
  - 流程图
  - 架构图
  - 可视化
  - visualization
  - SVG
---

你现在帮用户生成 **精美的 SVG 图表**。直接在回复中输出 ` ```html ` 代码块（内含 SVG），前端会在安全沙箱 iframe 中自动渲染。

## 核心规则

- **输出 ` ```html ` 代码块**，不要用 ` ```mermaid `
- **不要调用 generate_image 或 write_file 工具**
- **只输出 HTML 片段**（不含 DOCTYPE/html/head/body），格式：`<style>` → `<svg>`
- **先输出图表，再做文字解释**（如有必要）

---

## SVG 画布规范

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 720 H" font-family="system-ui, -apple-system, sans-serif">
```

- 画布宽度固定 **720**，高度 H 按内容计算（最低元素 y + height + 40）
- 所有元素在 x=20..700 范围内
- 背景：浅色/白色，与阿布界面一致

---

## 阿布配色体系

每张图从以下色组中选 **2-3 组**搭配，灰色组做中性元素：

| 色组 | 浅底色 (fill) | 边框色 (stroke) | 强调色 | 深色 (文字) |
|------|-------------|---------------|-------|-----------|
| 靛蓝 | #EBF0FF | #B4C6FC | #6B7FF5 | #2D3A8C |
| 翠绿 | #E8FAF0 | #8FE8BE | #2EBD7F | #145A3A |
| 琥珀 | #FFF8E6 | #F5D97E | #E6A817 | #7A5200 |
| 灰调 | #F5F6F8 | #D4D8E0 | #8B93A1 | #2E3440 |
| 玫红 | #FFF0F1 | #F5B3BA | #E8556D | #8C1B30 |
| 天蓝 | #EDF7FF | #9DD4F5 | #3AA8E0 | #134B73 |

**用色规则**：
- 节点：浅底色填充 + 边框色描边（stroke-width: 1）
- 标题文字：深色
- 副标题/说明文字：强调色
- 连线/箭头：灰调边框色，stroke-width: 1.5
- 不用纯黑 `#000`，不用渐变/阴影/发光

---

## 排版规范

**文字**：
- 标题：15px，font-weight: 600
- 节点标签：13px，font-weight: 500
- 说明文字：11px，font-weight: 400
- 最小字号 11px，不能更小
- 中文内容用中文字体（system-ui 会自动回退）

**形状**：
- 矩形节点：rx="10"（圆角）
- 最小节点宽度：文字字符数 × 8 + 48px
- 最小节点高度：40px
- 节点间距：至少 20px

**箭头标记**（需要时定义一次）：
```xml
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M1 1.5L7.5 5L1 8.5" fill="none" stroke="context-stroke"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
```

---

## 图表类型与布局指南

### 1. 流程图（上→下 或 左→右）

节点用圆角矩形，决策点用菱形或双线框。连线用直线 + 箭头。

```xml
<!-- 节点示例 -->
<rect x="280" y="20" width="160" height="44" rx="10" fill="#EBF0FF" stroke="#B4C6FC"/>
<text x="360" y="47" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">开始处理</text>

<!-- 连线示例 -->
<line x1="360" y1="64" x2="360" y2="100" stroke="#D4D8E0" stroke-width="1.5" marker-end="url(#arrow)"/>
```

**布局规则**：每行最多 4 个节点，行间距 70-80px。

### 2. 架构图（分层堆叠）

水平分层带，每层全宽圆角矩形，层内放子节点。

```xml
<!-- 层容器 -->
<rect x="20" y="20" width="680" height="120" rx="12" fill="#EBF0FF" stroke="#B4C6FC" stroke-dasharray="none"/>
<text x="40" y="48" font-size="11" font-weight="400" fill="#6B7FF5">用户接入层</text>

<!-- 层内节点 -->
<rect x="60" y="58" width="130" height="60" rx="10" fill="#FFFFFF" stroke="#B4C6FC"/>
<text x="125" y="93" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">Web 客户端</text>
```

**布局规则**：层从上到下排列，层间距 16px，最上层是用户侧，最下层是基础设施。不同层用不同色组。

### 3. 时间线（水平轴）

水平主轴 + 事件节点交错上下排列。

```xml
<!-- 主轴 -->
<line x1="40" y1="140" x2="680" y2="140" stroke="#D4D8E0" stroke-width="2"/>

<!-- 事件点 -->
<circle cx="140" cy="140" r="6" fill="#6B7FF5" stroke="#FFFFFF" stroke-width="2"/>
<text x="140" y="120" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">v1.0 发布</text>
<text x="140" y="165" text-anchor="middle" font-size="11" fill="#8B93A1">2024.03</text>
```

**布局规则**：事件标签奇数在上、偶数在下，防止重叠。

### 4. 层级图 / 组织架构（树形）

根节点居上居中，子节点向下展开，用竖线连接。

**布局规则**：同层节点等间距分布，父→子用垂直线 + 水平线连接（L 形或 T 形）。

### 5. 循环图 / 反馈环

3-5 个节点环形排列，曲线箭头连接。

```xml
<path d="M x1 y1 Q cx cy x2 y2" fill="none" stroke="#D4D8E0" stroke-width="1.5" marker-end="url(#arrow)"/>
```

### 6. 对比图 / 矩阵

左右两栏或 2×2 矩阵，十字轴线分隔，每个象限不同底色。

### 7. 关系图 / 拓扑

节点自由布局，连线表达关系，用不同颜色或虚线/实线区分关系类型。

---

## 质量检查清单

输出前自检：
1. ✅ viewBox 高度 = 最低元素底部 + 40
2. ✅ 所有文字可读（≥11px）
3. ✅ 用了 2-3 组配色，不杂乱
4. ✅ 节点间距足够，不拥挤
5. ✅ 箭头方向正确
6. ✅ 没有元素超出 viewBox 范围
7. ✅ 中文标签用中文

---

## 完整示例：三层系统架构

```html
<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 720 340" font-family="system-ui, -apple-system, sans-serif">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M1 1.5L7.5 5L1 8.5" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>

  <!-- 接入层 -->
  <rect x="20" y="16" width="680" height="80" rx="12" fill="#EDF7FF" stroke="#9DD4F5"/>
  <text x="40" y="38" font-size="11" fill="#3AA8E0" font-weight="400">接入层</text>
  <rect x="60" y="46" width="140" height="38" rx="10" fill="#fff" stroke="#9DD4F5"/>
  <text x="130" y="70" text-anchor="middle" font-size="13" font-weight="500" fill="#134B73">Web 应用</text>
  <rect x="220" y="46" width="140" height="38" rx="10" fill="#fff" stroke="#9DD4F5"/>
  <text x="290" y="70" text-anchor="middle" font-size="13" font-weight="500" fill="#134B73">移动端</text>
  <rect x="380" y="46" width="140" height="38" rx="10" fill="#fff" stroke="#9DD4F5"/>
  <text x="450" y="70" text-anchor="middle" font-size="13" font-weight="500" fill="#134B73">API 网关</text>

  <!-- 连线 -->
  <line x1="360" y1="96" x2="360" y2="126" stroke="#D4D8E0" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- 服务层 -->
  <rect x="20" y="126" width="680" height="80" rx="12" fill="#EBF0FF" stroke="#B4C6FC"/>
  <text x="40" y="148" font-size="11" fill="#6B7FF5" font-weight="400">服务层</text>
  <rect x="80" y="156" width="120" height="38" rx="10" fill="#fff" stroke="#B4C6FC"/>
  <text x="140" y="180" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">用户服务</text>
  <rect x="220" y="156" width="120" height="38" rx="10" fill="#fff" stroke="#B4C6FC"/>
  <text x="280" y="180" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">订单服务</text>
  <rect x="360" y="156" width="120" height="38" rx="10" fill="#fff" stroke="#B4C6FC"/>
  <text x="420" y="180" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">消息服务</text>
  <rect x="500" y="156" width="120" height="38" rx="10" fill="#fff" stroke="#B4C6FC"/>
  <text x="560" y="180" text-anchor="middle" font-size="13" font-weight="500" fill="#2D3A8C">推荐服务</text>

  <!-- 连线 -->
  <line x1="360" y1="206" x2="360" y2="236" stroke="#D4D8E0" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- 数据层 -->
  <rect x="20" y="236" width="680" height="80" rx="12" fill="#E8FAF0" stroke="#8FE8BE"/>
  <text x="40" y="258" font-size="11" fill="#2EBD7F" font-weight="400">数据层</text>
  <rect x="120" y="266" width="130" height="38" rx="10" fill="#fff" stroke="#8FE8BE"/>
  <text x="185" y="290" text-anchor="middle" font-size="13" font-weight="500" fill="#145A3A">PostgreSQL</text>
  <rect x="290" y="266" width="130" height="38" rx="10" fill="#fff" stroke="#8FE8BE"/>
  <text x="355" y="290" text-anchor="middle" font-size="13" font-weight="500" fill="#145A3A">Redis</text>
  <rect x="460" y="266" width="130" height="38" rx="10" fill="#fff" stroke="#8FE8BE"/>
  <text x="525" y="290" text-anchor="middle" font-size="13" font-weight="500" fill="#145A3A">Kafka</text>
</svg>
```
