# Abu 教程生成 Skill 方案

> 状态：方案 v4（浏览器方案定稿）
> 日期：2025-03-15

---

## 一、需求概述

用户在操作软件（浏览器 Web 端 / 桌面客户端）时，Abu 能自动录制操作步骤、截图，并生成结构化的使用教程文档。

支持两种模式：
- **手动录制**：用户自己操作，Abu 在后台录制
- **AI 自主操作**：用户下达指令，Abu 自己去操作目标系统并生成手册

---

## 二、场景矩阵与优先级

```
                  手动操作(用户操作)          AI操作(阿布操作)
              ┌──────────────────────┬──────────────────────┐
   Web 端     │  P1: 录制浏览器操作   │  P3: AI操作Web后台    │
   (浏览器)    │  可行度 9/10         │  可行度 8/10          │
              │  工作量 2-3天         │  工作量 1-2天          │
              ├──────────────────────┼──────────────────────┤
   桌面客户端   │  P2: 录制桌面操作     │  P4: AI操作桌面软件   │
              │  可行度 6/10         │  可行度 5/10          │
              │  工作量 6-7天         │  等 Vision 能力提升    │
              └──────────────────────┴──────────────────────┘
```

**推荐实施顺序：P1 → P3 → P2（P4 暂缓）**

---

## 三、架构设计原则：与 Abu 完全解耦

### 3.1 设计目标

整个教程生成功能**不改动 Abu 任何核心代码**，全部通过以下机制实现：
- **Skill**（纯新增文件）：编排流程、指导 LLM 行为
- **abu-browser-bridge 扩展**：教程工具 + 截图存储 + 文档生成
- **Chrome Extension 增强**：录制时实时截图

### 3.2 架构总览

```
┌─────────────────────────────────────────────────────┐
│  Abu 主体（零改动）                                    │
│                                                      │
│  ┌───────────┐  ┌────────────────────────────────┐   │
│  │ Agent Loop │──│ MCP Manager                    │   │
│  │ (不修改)   │  │  └ abu-browser-bridge (扩展)    │   │
│  └───────────┘  └────────────────────────────────┘   │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │ Skills (纯新增文件)                         │      │
│  │  ├ tutorial-recorder  (P1: 手动录制)        │      │
│  │  └ tutorial-autopilot (P3: AI 操作)         │      │
│  └────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│  abu-browser-bridge (Node.js MCP Server)            │
│                                                     │
│  已有工具（不改）          新增教程工具                 │
│  ├ screenshot             ├ tutorial_start           │
│  ├ click / fill / ...     ├ tutorial_save_step       │
│  ├ start_recording        ├ tutorial_set_descriptions│
│  ├ stop_recording ←(内部增强) tutorial_generate_html  │
│  └ ...                    └ tutorial_clear           │
│                                                     │
│  新增模块                                            │
│  └ tutorial/                                         │
│     ├ manager.ts    ← 会话管理、步骤存储               │
│     ├ annotator.ts  ← 截图标注（pngjs 画红圈）         │
│     ├ generator.ts  ← HTML 文档生成                   │
│     └ types.ts      ← 类型定义                        │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│  Chrome Extension                                   │
│                                                     │
│  Background (改动)         Content Script (微调)     │
│  ├ 录制事件时自动截图        ├ 录制事件时通知 background │
│  ├ 截图缓存 Map             └ (加 3-5 行)            │
│  └ stop_recording 时                                 │
│    合并截图到响应                                      │
└────────────────────────────────────────────────────┘
```

### 3.3 为什么教程功能放 bridge 而不是独立 MCP

| 考量 | 放 bridge 里 | 独立 tutorial-mcp |
|------|-------------|------------------|
| 截图数据流 | **进程内直接获取，不出进程** | 需要跨 MCP 通信，base64 搬运问题 |
| 安装体验 | 用户已有 bridge，零额外安装 | 多装一个 MCP server |
| 领域归属 | 教程录制本质是浏览器操作的"录像"，天然同域 | 分离后两边都不完整 |
| Abu 改动 | 零 | 零（但 MCP 间通信有问题） |
| 可复用性 | 绑定 bridge | 理论上更通用（实际因截图问题也绑定） |

### 3.4 改动范围总结

```
              改 Abu 核心    改 Bridge    改 Extension    新增 Skill
P1 手动录制      ❌            ✅           ✅             ✅
P3 AI 操作       ❌            (复用P1)     ❌             ✅
P2 桌面录制      ❌            ❌           ❌             ✅
                             + Rust 新模块
```

---

## 四、交付产物形态

### 4.1 竞品调研结论

| 产品 | 默认查看方式 | 导出格式 | 截图处理 |
|------|------------|---------|---------|
| Scribe | 在线链接 | PDF / HTML / Markdown | 自动截图 + 红框标注点击位置 |
| Tango | 在线链接 | PDF / HTML / Markdown / 嵌入 | 自动截图 + 箭头/框/模糊 |
| Dubble | 在线链接 | PDF / 嵌入 Notion/Confluence | 同时生成视频 + 图文 SOP |

竞品默认都是在线链接（SaaS 模式）。Abu 是桌面端，无在线托管，需要本地文件方案。

### 4.2 默认输出：HTML 单文件

**选择 HTML 单文件（base64 内嵌截图）作为默认格式，原因：**

- Markdown 本地路径图片粘贴到飞书/Notion 时**图片会丢失**
- base64 内嵌的 Markdown 文件过大，编辑器卡顿
- HTML 单文件：双击浏览器打开可看，复制内容粘贴到飞书图片能跟着走
- 单文件发给同事直接可用，不依赖外部路径

```
默认输出：
  教程名.html              ← HTML 单文件，截图 base64 内嵌 + 点击标注

按需导出（对话触发）：
  "导出 Word" → 复用 docx Skill → 教程名.docx
  "导出 PDF"  → 复用 pdf Skill  → 教程名.pdf
  "导出 Markdown" → 后续版本支持
```

### 4.3 截图标注

**竞品验证：标注是刚需，不是锦上添花。** Scribe/Tango 默认都标注点击位置。

**MVP 标注方案：**
- 点击事件：在截图对应坐标画红色半透明圆圈（r=20, opacity=0.5）
- 不做箭头、不做文字标签
- 实现：`pngjs`（纯 JS，零 native 依赖）
- 标注在 `tutorial_generate_html` 时执行，不影响原始截图存储

---

## 五、abu-browser-bridge 教程模块设计

### 5.1 新增模块结构

```
abu-browser-bridge/src/
├── index.ts           (已有，不改)
├── wsServer.ts        (已有，不改)
├── tools.ts           (已有，新增 5 个教程工具注册)
├── tutorial/          (新增目录)
│   ├── types.ts       ← 数据结构
│   ├── manager.ts     ← 会话管理、步骤存储
│   ├── annotator.ts   ← 截图标注（pngjs 画红圈）
│   └── generator.ts   ← HTML 文档生成
```

### 5.2 数据结构

```typescript
// tutorial/types.ts

interface TutorialStep {
  index: number
  timestamp: number
  action: 'click' | 'type' | 'select' | 'navigate' | 'scroll' | 'custom'
  description?: string               // LLM 生成的步骤描述
  url?: string
  pageTitle?: string
  locator?: string                   // 元素选择器（来自录制数据）
  clickCoordinates?: [number, number] // 用于截图标注
  screenshotFile?: string            // 本地 PNG 文件名（如 step-001.png）
}

interface TutorialSession {
  id: string
  steps: TutorialStep[]
  startTime: number
  storageDir: string                 // 截图临时存储目录
}
```

### 5.3 TutorialManager

```typescript
// tutorial/manager.ts

class TutorialManager {
  private session: TutorialSession | null = null

  // --- 会话管理 ---

  start(): string
  // 创建新 session，分配 ID，创建存储目录
  // 存储目录：~/.abu-browser-bridge/tutorials/{sessionId}/

  isActive(): boolean

  clear(): { clearedSteps: number }
  // 清空 session，删除存储目录

  // --- P3 AI 操作模式 ---

  async addStep(params: {
    description: string
    action: string
    screenshotBase64: string          // Bridge 内部调 Extension 截图获得
    url?: string
    pageTitle?: string
    clickCoordinates?: [number, number]
  }): Promise<{ stepIndex: number, totalSteps: number }>
  // 1. 把 base64 解码写入 PNG 文件
  // 2. 创建 TutorialStep 加入 steps[]

  // --- P1 手动录制模式 ---

  cacheRecordingData(
    steps: RecordedStep[],
    screenshots: Map<number, string>  // stepIndex → base64
  ): void
  // 由 stop_recording 的 tool handler 内部调用
  // 把录制数据 + 截图存入 session
  // 截图写入 PNG 文件，RecordedStep 转换为 TutorialStep

  setDescriptions(descriptions: string[]): { updatedSteps: number }
  // LLM 为每步写的描述，按顺序覆盖到 steps[].description

  // --- 文档生成 ---

  getSteps(): TutorialStep[]

  async generateHtml(title: string, outputPath: string): Promise<{
    filePath: string
    stepCount: number
    fileSizeKb: number
  }>
  // 1. 逐步读取截图 PNG
  // 2. 有 clickCoordinates 的做标注（调 annotator）
  // 3. 组装 HTML（调 generator）
  // 4. 写入 outputPath
  // 5. 清理临时存储目录
}
```

### 5.4 截图标注

```typescript
// tutorial/annotator.ts
import { PNG } from 'pngjs'

export function annotateClick(
  pngBuffer: Buffer,
  x: number,
  y: number,
  radius: number = 20,
  color: { r: number, g: number, b: number, a: number } = { r: 230, g: 57, b: 70, a: 128 }
): Buffer {
  const png = PNG.sync.read(pngBuffer)
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        const px = x + dx, py = y + dy
        if (px >= 0 && px < png.width && py >= 0 && py < png.height) {
          const idx = (py * png.width + px) * 4
          // Alpha 混合
          const srcA = color.a / 255
          png.data[idx]     = Math.round(color.r * srcA + png.data[idx] * (1 - srcA))
          png.data[idx + 1] = Math.round(color.g * srcA + png.data[idx + 1] * (1 - srcA))
          png.data[idx + 2] = Math.round(color.b * srcA + png.data[idx + 2] * (1 - srcA))
          png.data[idx + 3] = Math.min(255, png.data[idx + 3] + color.a)
        }
      }
    }
  }
  return PNG.sync.write(png)
}
```

### 5.5 HTML 文档生成

```typescript
// tutorial/generator.ts

export function generateTutorialHtml(params: {
  title: string
  steps: Array<{
    index: number
    description: string
    screenshotBase64: string     // 标注后的截图
    url?: string
  }>
  generatedAt: string
}): string {
  // 返回完整 HTML 字符串
}
```

**HTML 模板：**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>{title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { max-width: 900px; margin: 0 auto; padding: 40px 20px;
           font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
           background: #f9fafb; color: #1a1a1a; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    .meta { color: #6b7280; font-size: 14px; margin-bottom: 36px; }
    .step { background: #fff; border-radius: 12px; padding: 24px;
            margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .step-header { display: flex; align-items: flex-start; gap: 14px; }
    .step-num { min-width: 32px; height: 32px; border-radius: 50%;
                background: #e74c3c; color: #fff; display: flex;
                align-items: center; justify-content: center;
                font-weight: 700; font-size: 14px; flex-shrink: 0; }
    .step-desc { font-size: 16px; line-height: 1.6; padding-top: 4px; }
    .step-url { font-size: 12px; color: #9ca3af; margin-top: 4px; }
    .step-img { max-width: 100%; border-radius: 8px; margin-top: 16px;
                border: 1px solid #e5e7eb; }
    footer { text-align: center; color: #9ca3af; font-size: 12px;
             margin-top: 48px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <h1>{title}</h1>
  <p class="meta">生成时间：{generatedAt} · 共 {stepCount} 步</p>

  {steps.map(step => `
  <div class="step">
    <div class="step-header">
      <div class="step-num">${step.index}</div>
      <div>
        <p class="step-desc">${step.description}</p>
        ${step.url ? `<p class="step-url">${step.url}</p>` : ''}
      </div>
    </div>
    ${step.screenshotBase64
      ? `<img class="step-img" src="data:image/png;base64,${step.screenshotBase64}" />`
      : ''}
  </div>
  `).join('')}

  <footer>由 Abu 自动生成</footer>
</body>
</html>
```

### 5.6 新增 MCP 工具（5 个）

在 `tools.ts` 的 `registerTools()` 中新增：

```typescript
// ========== 教程工具 ==========

// 工具 1：开始教程会话
server.tool('tutorial_start', '开始一个新的教程录制会话', {}, async () => {
  const sessionId = tutorialManager.start()
  return formatResult({ session_id: sessionId, message: '教程会话已开始' })
})

// 工具 2：保存一个步骤（P3 AI 操作模式）
server.tool('tutorial_save_step',
  '保存一个教程步骤，自动截取当前页面截图',
  {
    description: z.string().describe('步骤的自然语言描述'),
    action: z.enum(['click','type','select','navigate','scroll','custom']).optional(),
    tab_id: z.number().optional().describe('目标标签页 ID，默认当前标签'),
    click_coordinates: z.tuple([z.number(), z.number()]).optional()
      .describe('点击坐标 [x, y]，用于在截图上标注'),
    auto_screenshot: z.boolean().optional().default(true)
      .describe('是否自动截图，默认 true'),
  },
  async (params) => {
    if (!tutorialManager.isActive()) {
      return formatError('请先调用 tutorial_start 开始教程会话')
    }

    let screenshotBase64: string | undefined
    if (params.auto_screenshot !== false) {
      // Bridge 内部直接调 Extension 截图，不经过 LLM
      const resp = await sendToExtension('screenshot', { tabId: params.tab_id })
      screenshotBase64 = resp.data as string
    }

    // 同时获取当前页面 URL 和标题
    const tabInfo = await sendToExtension('get_tab_info', { tabId: params.tab_id })

    const result = await tutorialManager.addStep({
      description: params.description,
      action: params.action || 'custom',
      screenshotBase64,
      url: tabInfo?.url,
      pageTitle: tabInfo?.title,
      clickCoordinates: params.click_coordinates,
    })

    return formatResult(result)
  }
)

// 工具 3：批量设置步骤描述（P1 手动录制模式）
server.tool('tutorial_set_descriptions',
  '为录制的步骤批量设置描述文字（配合 stop_recording 使用）',
  {
    descriptions: z.array(z.string()).describe('按录制顺序，每步一个描述'),
  },
  async (params) => {
    if (!tutorialManager.isActive()) {
      return formatError('请先调用 tutorial_start 开始教程会话')
    }
    const result = tutorialManager.setDescriptions(params.descriptions)
    return formatResult(result)
  }
)

// 工具 4：生成 HTML 教程文档
server.tool('tutorial_generate_html',
  '将已记录的步骤生成为 HTML 教程文档（截图内嵌，可直接分享）',
  {
    title: z.string().describe('教程标题'),
    output_path: z.string().describe('输出文件路径，如 ./教程名.html'),
  },
  async (params) => {
    if (!tutorialManager.isActive()) {
      return formatError('没有活跃的教程会话')
    }
    const result = await tutorialManager.generateHtml(params.title, params.output_path)
    return formatResult(result)
  }
)

// 工具 5：清空教程会话
server.tool('tutorial_clear', '清空当前教程会话和所有已记录步骤', {},
  async () => {
    const result = tutorialManager.clear()
    return formatResult(result)
  }
)
```

### 5.7 stop_recording 内部增强

**外部行为不变**（LLM 看到的返回值不变），内部静默缓存截图到 TutorialManager：

```typescript
// tools.ts 中现有 stop_recording 的 handler 增强

case 'stop_recording': {
  const response = await sendToExtension('stop_recording', { tabId })
  const { steps, screenshots } = response.data
  // screenshots 是 Extension 新增返回的 Map<stepIndex, base64>

  // 如果有活跃的教程会话，静默缓存录制数据
  if (tutorialManager.isActive() && screenshots) {
    tutorialManager.cacheRecordingData(steps, screenshots)
  }

  // 返回给 LLM 的只有步骤文本（不含截图 base64）
  return formatResult(steps.map(s => ({
    action: s.action,
    locator: s.locator,
    value: s.value,
    url: s.url,
    timestamp: s.timestamp,
  })))
}
```

---

## 六、Chrome Extension 改动

### 6.1 改动目标

录制期间每个事件触发时，Background 实时截图并缓存。stop_recording 时，截图随步骤一起返回给 Bridge。

### 6.2 Content Script 改动（~5 行）

```typescript
// abu-chrome-extension/src/content/index.ts
// 在录制事件 handler 中，每次记录步骤后通知 background

// 现有：recordedSteps.push(step)
// 新增：
chrome.runtime.sendMessage({
  type: 'recording-step-captured',
  stepIndex: recordedSteps.length - 1
})
```

### 6.3 Background Script 改动（~30 行）

```typescript
// abu-chrome-extension/src/background/index.ts

// 新增：录制截图缓存
const recordingScreenshots = new Map<number, string>()  // stepIndex → base64

// 新增：监听 content script 的录制事件通知
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'recording-step-captured' && sender.tab) {
    const stepIndex = msg.stepIndex
    // 实时截图
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
      .then(dataUrl => {
        // dataUrl 格式：data:image/png;base64,iVBOR...
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
        recordingScreenshots.set(stepIndex, base64)
      })
      .catch(() => { /* 截图失败，跳过 */ })
  }
})

// 改动：stop_recording handler 返回时附带截图
// 现有：return { steps: recordedSteps }
// 改为：
const result = {
  steps: recordedSteps,
  screenshots: Object.fromEntries(recordingScreenshots)  // { 0: "base64...", 1: "base64...", ... }
}
recordingScreenshots.clear()  // 清空缓存
return result
```

### 6.4 Shared Types 改动

```typescript
// abu-browser-shared/types.ts 新增

interface StopRecordingResponse {
  steps: RecordedStep[]
  screenshots?: Record<number, string>  // stepIndex → base64 PNG
}
```

---

## 七、P1：手动操作 + Web 浏览器录制

### 7.1 数据流

```
用户: "帮我录制教程"
  ↓
LLM: tutorial_start()                    ← 创建教程会话
     start_recording()                   ← 开始录制
  ↓
用户在浏览器中操作
  ↓ (每次 click/fill/select)
  Content script 记录 step + 通知 background
  Background 截图 → 缓存到 Map
  ↓
用户: "录完了"
  ↓
LLM: stop_recording()                    ← 结束录制
  ↓ (Bridge 内部)
  Extension 返回 { steps, screenshots }
  Bridge 的 stop_recording handler 静默调用
    tutorialManager.cacheRecordingData(steps, screenshots)
  LLM 只收到步骤文本列表（不含截图）
  ↓
LLM: 分析步骤列表，为每步撰写描述
     tutorial_set_descriptions([          ← 批量设置描述
       "打开飞书管理后台",
       "点击左侧「审批」菜单",
       "点击「新建审批流程」按钮",
       ...
     ])
  ↓
LLM: tutorial_generate_html(             ← 生成文档
       title="飞书创建审批流程教程",
       output_path="./飞书审批流程教程.html"
     )
  ↓
Bridge 内部：
  读取缓存的截图 PNG → 标注点击位置 → 组装 HTML → 写文件
  ↓
LLM: "教程已生成，共 8 步。已保存到 ./飞书审批流程教程.html"
```

**LLM 工具调用链（4 次）：**
```
tutorial_start → start_recording → stop_recording → tutorial_set_descriptions → tutorial_generate_html
```

### 7.2 Skill 定义

```yaml
# builtin-skills/tutorial-recorder/SKILL.md
---
name: tutorial-recorder
description: 录制用户浏览器操作并生成使用教程文档
trigger: 用户要求录制教程、生成操作手册、录制操作步骤、帮我记录操作、你看着我操作
do-not-trigger: 用户只是要截图、用户要求AI去操作某个系统
user-invocable: true
context: inline
allowed-tools:
  - abu-browser-bridge__tutorial_start
  - abu-browser-bridge__tutorial_set_descriptions
  - abu-browser-bridge__tutorial_generate_html
  - abu-browser-bridge__tutorial_clear
  - abu-browser-bridge__start_recording
  - abu-browser-bridge__stop_recording
  - abu-browser-bridge__get_tabs
  - abu-browser-bridge__connection_status
  - write_file
tags:
  - tutorial
  - documentation
  - recording
max-turns: 30
---

## 你是教程录制助手

### 前置检查
1. 调用 `connection_status` 确认浏览器插件已连接
2. 如未连接，提示用户安装 Abu Chrome Extension 并刷新页面

### 录制流程
1. 确认用户要录制的内容
2. 调用 `tutorial_start` 创建教程会话
3. 调用 `start_recording` 开始监听
4. 告知用户："已开始录制，请在浏览器中操作，完成后告诉我。"
5. 等待用户说"结束"/"录完了"/"停止录制"
6. 调用 `stop_recording` 获取步骤列表
7. 分析步骤列表，为每步写一句自然语言描述
8. 调用 `tutorial_set_descriptions` 批量设置描述
9. 调用 `tutorial_generate_html` 生成教程文档
10. 告知用户文档已生成，询问是否需要导出 Word/PDF

### 描述撰写规则
- 每步用一句话描述用户做了什么（"点击顶部导航栏的「设置」按钮"）
- 合并连续的无意义操作（多次滚动 → "向下滚动页面"）
- 跳过明显的误操作（点了又立即取消的）
- 敏感信息脱敏：密码描述为"输入密码"，不展示实际值
- 描述数量必须和步骤数量一致
```

### 7.3 工作量评估

| 改动项 | 工作量 | 说明 |
|-------|--------|------|
| Bridge: tutorial/ 模块 | 1.5 天 | manager + annotator + generator |
| Bridge: tools.ts 注册 5 个工具 | 0.5 天 | 含 stop_recording 增强 |
| Bridge: pngjs 依赖 | — | package.json 加依赖 |
| Extension: background 截图缓存 | 0.5 天 | ~30 行 |
| Extension: content script 通知 | — | ~5 行 |
| Shared: 类型扩展 | — | ~10 行 |
| Skill: tutorial-recorder | 0.5 天 | SKILL.md + prompt 调优 |
| 联调测试 | 0.5 天 | 端到端 |
| **合计** | **~4 天** | |

---

## 八、P3：AI 自主操作 + Web 浏览器

### 8.1 数据流

```
用户: "去操作管理后台，写个用户管理手册"
  ↓
LLM: tutorial_start()                    ← 创建教程会话
  ↓
LLM: navigate("admin.example.com")       ← 操作浏览器
     tutorial_save_step(                  ← 保存步骤（Bridge 内部自动截图）
       description="打开管理后台登录页",
       action="navigate"
     )
  ↓
LLM: fill(username) → click(login)
     tutorial_save_step(
       description="输入账号密码并登录系统",
       action="click"
     )
  ↓
LLM: click(用户管理菜单)
     tutorial_save_step(
       description="点击左侧「用户管理」菜单",
       action="click",
       click_coordinates=[120, 350]       ← 可选：标注点击位置
     )
  ↓
     ... 继续操作 + 保存 ...
  ↓
LLM: tutorial_generate_html(
       title="XX系统用户管理手册",
       output_path="./用户管理手册.html"
     )
```

**与 P1 的关键区别：**
- P1 用 `tutorial_set_descriptions` 批量写描述（录制结束后一次性）
- P3 用 `tutorial_save_step` 逐步保存（每步操作后立即记录）
- P3 的 `tutorial_save_step` 内部自动截图（Bridge 进程内调 Extension），LLM 不碰截图数据

### 8.2 Skill 定义

```yaml
# builtin-skills/tutorial-autopilot/SKILL.md
---
name: tutorial-autopilot
description: AI自主操作Web系统并生成操作手册
trigger: 用户要求阿布去操作某个系统并写手册、帮我写个xx的使用教程、你去操作xx后台
do-not-trigger: 用户要自己操作让阿布录制
user-invocable: true
context: inline
allowed-tools:
  - abu-browser-bridge__*
  - write_file
  - read_file
  - http_fetch
tags:
  - tutorial
  - automation
  - documentation
max-turns: 80
---

## 你是教程生成助手

### 前置检查
1. 确认浏览器插件已连接（`connection_status`）
2. 调用 `tutorial_start` 创建教程会话
3. 确认目标系统 URL、登录信息、要覆盖的功能范围

### 操作规范

**每完成一个有意义的操作后，必须调用 `tutorial_save_step` 保存步骤。** 包括：
- 打开新页面
- 点击按钮/菜单
- 填写表单
- 提交/保存操作

**不需要保存的操作：**
- 等待页面加载
- 滚动查看（除非滚动后出现新的关键内容）
- 中间的调试/探索操作

**操作安全：**
- 不要执行不可逆的破坏性操作（删除数据），除非用户明确要求
- 表单填写使用合理的示例数据
- 操作过程中保持与用户沟通，汇报进度
- 遇到不确定的选择，询问用户

### 步骤描述规范
- 一句话描述操作（"点击右上角的「新增用户」按钮"）
- 敏感信息脱敏：密码描述为"输入密码"
- 如果知道点击坐标，传入 click_coordinates 以便截图标注

### 完成后
1. 调用 `tutorial_generate_html` 生成文档
2. 告知用户文档路径和步骤数
3. 询问是否需要导出 Word/PDF 或补充其他功能
```

### 8.3 关键技术细节

**用户中途干预：**
- ✅ 追加指令："还要录 xx 功能" → `userInputQueue` 下一轮注入
- ✅ 纠错："这里不对" → LLM 调整操作，继续 save_step
- ✅ 删错步：当前 MVP 不支持 delete_step，但 LLM 可以先 clear 重来
- ✅ 终止："停" → abort → 已保存的 steps 仍在 Bridge，新会话可 generate_html

**LLM 漏调 save_step 的应对：**
- Skill prompt 粗体强调"**必须**调用 `tutorial_save_step`"
- 漏了个别步骤影响不大，用户可补录
- 可在 generate_html 前让 LLM 回顾："我已记录 N 个步骤，是否有遗漏？"

**Max Turns：**
- 设 `maxTurns: 80`
- 复杂后台 30-50 步操作，每步消耗 2-3 轮（操作 + save_step + 可能的 screenshot 确认）

### 8.4 工作量评估

| 改动项 | 工作量 | 说明 |
|-------|--------|------|
| tutorial-autopilot Skill | 0.5 天 | SKILL.md + prompt |
| Bridge 教程工具（复用 P1） | 0 天 | 已在 P1 开发 |
| 联调测试 | 1 天 | 端到端，含中途干预、长流程测试 |
| **合计** | **~1.5 天** | |

---

## 九、P2：手动操作 + 桌面客户端录制（后续阶段）

### 9.1 技术方案

P2 无法复用 browser-bridge（桌面 App 不在浏览器里），需要独立方案：

- Rust 侧新增 `rdev` crate 做全局键鼠监听
- 截图用已有的 `capture_screen`（xcap）
- 文档生成逻辑可独立实现，或做成独立 MCP server

### 9.2 事件过滤与截图策略

```
┌────────────────────┬────────────────────────────────────┐
│ 事件               │ 截图策略                            │
├────────────────────┼────────────────────────────────────┤
│ 鼠标左键单击        │ 点击后延迟 500ms 截图（等 UI 响应）   │
│ 鼠标右键单击        │ 点击后立即截图（捕获右键菜单）        │
│ 活跃窗口变化        │ 切换后延迟 1s 截图（等窗口渲染）      │
│ 连续键盘输入        │ 停顿 2s 后截图（一次 type 完整记录）  │
│ Enter / Tab        │ 按下后延迟 500ms 截图               │
│ Cmd+S / Ctrl+S     │ 保存后延迟 500ms 截图               │
│ 鼠标滚动（累计）     │ 停止滚动 1s 后截图                  │
│ 鼠标移动            │ 忽略，不截图                        │
└────────────────────┴────────────────────────────────────┘
```

### 9.3 UX 难点

| 问题 | 解决思路 |
|------|---------|
| 阿布窗口挡住操作 | 录制模式下缩为悬浮球或用 tray icon 控制 |
| 无关操作过滤 | 记录窗口标题，对话式删除无关步骤 |
| 录制开始/结束 | 全局快捷键 `Cmd+Shift+R` 或 tray icon |
| macOS 权限 | 需要 Accessibility + Screen Recording 权限（已有检测基础） |

### 9.4 工作量估算：~6 天

---

## 十、P4：AI 操作 + 桌面客户端（暂缓）

- 技术基础已有（`computer` tool），但 Vision 识别桌面 UI 准确度不足
- 等 Claude Vision 提升或 macOS Accessibility API 集成后再评估
- 当前可用 P2（手动录制桌面）替代

---

## 十一、实施路线图

```
Phase 1 — P1 手动录制 Web + 基础设施（4 天）
├── Bridge: tutorial/ 模块（manager + annotator + generator）
├── Bridge: 注册 5 个教程工具 + stop_recording 增强
├── Extension: background 录制截图缓存
├── Extension: content script 事件通知
├── Skill: tutorial-recorder
└── 端到端测试

Phase 2 — P3 AI 操作 Web（1.5 天，累计 5.5 天）
├── Skill: tutorial-autopilot
└── 联调测试（长流程、中途干预）

Phase 3 — P2 手动录制桌面（6 天，累计 11.5 天）
├── Rust: rdev 全局事件监听
├── 智能截图触发策略
├── 悬浮球/tray 录制控制 UI
├── Skill 扩展
└── macOS + Windows 测试
```

**总工作量估算：~11.5 天**

---

## 十二、技术风险与对策

| 风险 | 影响 | 概率 | 对策 |
|------|------|------|------|
| captureVisibleTab 时机不准（页面还在加载） | P1 截图模糊/空白 | 中 | 截图延迟 300-500ms，或 content script 确认 DOM 稳定后再通知 |
| LLM 漏调 tutorial_save_step | P3 步骤不完整 | 中 | Skill prompt 强化 + 生成前让 LLM 回顾确认 |
| 长教程截图文件过多 | 磁盘占用 | 低 | 生成 HTML 后清理临时文件，截图已内嵌到 HTML |
| rdev macOS Accessibility 权限 | P2 无法监听 | 中 | 引导用户授权，已有权限检测基础设施 |
| HTML 单文件过大（50+ 步） | 浏览器打开慢 | 低 | 截图压缩质量（JPEG 80%）或限制最大分辨率 |

---

## 十三、已决策事项

| 问题 | 决策 | 理由 |
|------|------|------|
| 与 Abu 的耦合度 | **完全解耦**，Abu 核心零改动 | 教程功能全在 bridge + extension + skill |
| 教程功能放哪里 | **abu-browser-bridge 内**，不独立 MCP | 避免截图 base64 跨进程搬运 |
| 录制截图方式 | **Background 实时截图 + 缓存**，stop 时批量返回 | 确保截图与操作时刻一致 |
| stop_recording 行为 | **外部不变、内部增强**，静默缓存到 TutorialManager | 不破坏已有 API |
| 截图标注 | **pngjs 纯 JS**，画红色圆圈 | 零 native 依赖，安装可靠 |
| 默认输出格式 | **HTML 单文件**（base64 内嵌截图） | 粘贴到飞书图片不丢失，单文件可分享 |
| 教程编辑 | 对话式（"删掉第 3 步"），MVP 不做 UI | 后续可加 tutorial_delete_step 工具 |
| 多语言 | LLM prompt 参数，零开发成本 | 同一份录制可生成多语言版本 |
| 模板系统 | 不做，prompt 差异化替代 | "写成快速指南"LLM 直接调整格式 |
| 录制回放 | 不做 | P3 天然可重新操作 |
