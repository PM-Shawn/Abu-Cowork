---
name: mermaid-diagram
description: 用 Mermaid 语法生成可视化图表 — 流程图、架构图、序列图、ER 图、甘特图、状态图、思维导图、饼图等结构化图表。当用户要求画图/画架构图/画流程图等结构化可视化需求时触发，直接输出 mermaid 代码块，前端会自动转换为 HTML 并在沙箱 iframe 中渲染。
trigger: 用户要求画流程图、架构图、序列图、ER 图、甘特图、状态图、思维导图、饼图、类图、时间线、关系图、拓扑图、部署图、数据库设计图、系统架构、技术架构、业务流程、数据流、状态机，或任何结构化的图表/可视化需求
do-not-trigger: 用户要求生成照片、插画、艺术画、海报、UI 设计图、Logo、手绘风格图片等需要像素级渲染的视觉内容；用户明确要求用 generate_image 生图
user-invocable: true
disable-auto-invoke: false
argument-hint: <图表描述>
tags:
  - 图表
  - diagram
  - 流程图
  - 架构图
  - mermaid
  - 可视化
  - visualization
---

你现在帮用户生成 **Mermaid 图表**。直接在回复中输出 ` ```mermaid ` 代码块，前端会自动将其转换为 HTML 并在沙箱 iframe 中通过 Mermaid CDN 渲染为 SVG 图表。

**不要调用 generate_image 工具**，Mermaid 代码块就是最终输出。

## 支持的图表类型

根据用户需求选择最合适的类型：

| 需求 | Mermaid 语法 |
|------|-------------|
| 流程图/决策树 | `flowchart TD` 或 `flowchart LR` |
| 序列图/时序图 | `sequenceDiagram` |
| 类图/数据模型 | `classDiagram` |
| 状态图/状态机 | `stateDiagram-v2` |
| ER 图/数据库设计 | `erDiagram` |
| 甘特图/项目排期 | `gantt` |
| 饼图/占比 | `pie` |
| 思维导图 | `mindmap` |
| 时间线 | `timeline` |
| Git 分支图 | `gitGraph` |
| 四象限图 | `quadrantChart` |
| 块图/架构布局 | `block-beta` |

## 输出规范

1. **一个代码块一张图**：每个 ` ```mermaid ` 块只放一张图
2. **中文标签**：节点文字用中文（用户用中文时）
3. **合理布局**：
   - 层级关系用 `TD`（上→下）
   - 流程/时序用 `LR`（左→右）
   - 节点不超过 20 个，超出时分组或简化
4. **节点样式**：
   - 普通步骤：`A[文字]`（方框）
   - 判断/分支：`B{条件?}`（菱形）
   - 开始/结束：`C([文字])`（圆角）
   - 数据库：`D[(数据库)]`（圆柱）
5. **先输出图表，再做文字说明**（如有必要）

## 架构图最佳实践

对于系统架构图，推荐用 `flowchart TD` + `subgraph` 分层：

```
flowchart TD
    subgraph 前端
        A[Web App] --> B[Mobile App]
    end
    subgraph 后端
        C[API Gateway] --> D[业务服务]
        D --> E[数据库]
    end
    前端 --> 后端
```

## 注意事项

- 节点 ID 用英文字母（A, B, C 或有意义的缩写），标签用中文
- 避免特殊字符（`"`, `'`, `(`, `)` 等）出现在节点文字中，会导致语法错误
- 如果用户的需求不适合结构化图表（如照片、插画、艺术画），告知用户并建议使用生图功能
