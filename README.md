<div align="center">

**中文** | [English](README_EN.md)

<img src="website/assets/abu-avatar.png" width="120" height="120" style="border-radius: 24px" />

# Abu (阿布)

**你的 AI 桌面办公搭子 — 交给阿布就行啦**

本地运行的 AI 桌面办公助手，灵感来自 Claude Code 的 Cowork 模式。
你说需求，阿布干活 — 读文件、跑命令、写文档、做报表，全在本地完成。

[![Release](https://img.shields.io/github/v/release/PM-Shawn/Abu-Cowork?style=flat-square)](https://github.com/PM-Shawn/Abu-Cowork/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)

[下载安装](#-下载安装) · [快速开始](#-快速开始) · [功能介绍](#-功能介绍) · [使用指南](docs/User-Guide.md) · [从源码构建](#-从源码构建)

</div>

---

## 为什么选择 Abu？

| 特性 | Abu | 普通 AI 聊天 | 传统自动化工具 |
|------|-----|-------------|---------------|
| 自主规划并执行复杂任务 | :white_check_mark: | :x: | :x: |
| 读写本地文件、执行命令 | :white_check_mark: | :x: | :white_check_mark: |
| 自然语言交互 | :white_check_mark: | :white_check_mark: | :x: |
| 28 个内置技能 + 自进化（阿布自己攒新技能） | :white_check_mark: | :x: | :x: |
| 多对话按项目聚合（Projects） | :white_check_mark: | :x: | :x: |
| 定时任务 & 事件触发 | :white_check_mark: | :x: | :white_check_mark: |
| IM 机器人（飞书/钉钉/企微/Slack） | :white_check_mark: | :x: | 部分 |
| 多 Agent 后台并行 | :white_check_mark: | :x: | :x: |
| 浏览器 & 电脑操控 | :white_check_mark: | :x: | 部分 |
| 数据 100% 本地，隐私安全 | :white_check_mark: | :x: | :white_check_mark: |

---

## 最近更新

- **v0.15** — **性格系统（Soul）**：主动度三档预设（寡言 / 伙伴 / 管家）+ `SOUL.md` 自定义语气称呼；**内容安全扫描**：扫 agent / skill / 记忆里的 prompt 注入与危险指令（120+ 类）
- **v0.13.12** — **诊断面板**：AI 服务 / 数据&权限 / MCP / 技能 / 网络 / 应用 一键自检，遇到问题一键导出诊断包
- **v0.13** — **自进化 Skills**、**Projects 多对话聚合**、**通知中心**、**Todo 跨重启**

> 完整 changelog 见 [Releases](https://github.com/PM-Shawn/Abu-Cowork/releases)。

## 产品预览

> 简洁直观的界面，强大灵活的能力

<table>
<tr>
<td align="center" width="50%"><b>欢迎页</b><br/>自然语言输入，对话即指令<br/><br/><img src="website/assets/screenshot-welcome.png" width="100%" /></td>
<td align="center" width="50%"><b>任务执行</b><br/>自主规划步骤，调用工具完成复杂任务<br/><br/><img src="website/assets/screenshot-execution.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>权限控制</b><br/>文件访问需用户授权，安全可控<br/><br/><img src="website/assets/screenshot-permission.png" width="100%" /></td>
<td align="center"><b>IM 频道对话</b><br/>在飞书/钉钉中 @阿布 即可交互<br/><br/><img src="website/assets/screenshot-im-chat.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Skill 技能</b><br/>28 个内置技能，支持自定义扩展 + 自进化<br/><br/><img src="website/assets/screenshot-skills.png" width="100%" /></td>
<td align="center"><b>MCP 连接器</b><br/>一键接入 Playwright、GitHub 等外部工具<br/><br/><img src="website/assets/screenshot-mcp.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>定时任务</b><br/>Cron 定时执行，让阿布每天自动工作<br/><br/><img src="website/assets/screenshot-schedule-create.png" width="100%" /></td>
<td align="center"><b>触发器 / 值班</b><br/>HTTP、文件变更、IM 消息等事件自动触发<br/><br/><img src="website/assets/screenshot-triggers.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>AI 服务管理</b><br/>多厂商 Provider 管理，健康检查，一键切换<br/><br/><img src="website/assets/screenshot-settings-ai.png" width="100%" /></td>
<td align="center"><b>IM 频道配置</b><br/>连接飞书、钉钉、企微等 IM 平台<br/><br/><img src="website/assets/screenshot-settings-im.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>个人记忆</b><br/>记住你的偏好和工作习惯<br/><br/><img src="website/assets/screenshot-memory.png" width="100%" /></td>
<td align="center"><b>安全沙箱</b><br/>Seatbelt 沙箱 + 网络隔离，保护隐私<br/><br/><img src="website/assets/screenshot-security.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>性格设置（Soul）</b><br/>主动度三档预设 + SOUL.md 自定义语气、称呼、回复风格<br/><br/><img src="website/assets/screenshot-soul.png" width="100%" /></td>
<td align="center"><b>诊断面板</b><br/>AI 服务 / MCP / 技能 / 网络 / 应用 一键自检 + 诊断包导出<br/><br/><img src="website/assets/screenshot-diagnostic.png" width="100%" /></td>
</tr>
<tr>
<td align="center" colspan="2"><b>内容安全扫描</b><br/>三档权限模式（标准 / 自动 / 严格）+ 扫描 agent / skill / 记忆里的 prompt 注入与危险指令<br/><br/><img src="website/assets/screenshot-security-scan.png" width="60%" /></td>
</tr>
</table>

## 功能介绍

### 核心能力

- **Agent 自主执行** — 不只是聊天，能自主规划、调用工具、读写文件、执行命令，完成复杂任务
- **性格系统（Soul）** — 三档主动度预设（寡言 / 伙伴 / 管家）控制阿布何时主动出手；`SOUL.md` 自定义语气、称呼、回复风格、边界
- **自进化 Skills** — 跑完一段复杂流程后，阿布会主动提议"这套要不要固化成技能"，一键生成草稿 → 你审阅 → 采纳上架；下次直接叫技能名字调用，不用重讲
- **智能通知系统** — 菜单栏未读数 / sidebar 小红点 / 系统通知 三条兜底通道自动选择；全屏 / 勿扰时通知暂存进 inbox，回主窗口通过 badge 感知；打扰记录可审计半年
- **Projects 管理** — 工作区可升级成 Project，同一方向的对话自动聚合，每个项目独立配置图标、默认模型、技能集、MCP
- **多 Agent 后台并行** — 支持同时运行多个后台 Agent（最多 5 个），各自独立执行任务，进度实时可见
- **桌宠模式** — 透明圆形浮窗常驻桌面，跨 Spaces 跟随，随手呼出对话不抢焦点
- **对话分享 / 导出** — 一键把对话导出成 JSON 分享给同事；自动脱敏 API Key 与本地路径
- **28 个内置技能** — PDF/PPTX/DOCX/Excel 生成、前端设计、画布设计、算法艺术、Mermaid/SVG/信息图、Web Artifacts、Chrome 自动化（Abu-Browser）、深度研究、Agent 自我反思（reflect）、工作流自动化等，一键安装，支持自定义
- **MCP 工具协议** — 通过 Model Context Protocol 连接数据库、搜索引擎、GitHub 等外部服务
- **浏览器自动化** — 内置 Browser Bridge + Chrome 扩展，实现网页元素操作、表单填写、截图、JS 执行
- **电脑操控** — 通过截屏 + 键鼠控制完成桌面级任务，内置敏感应用拦截、危险按键拦截、5 分钟超时熔断等多重防护
- **HTTP Fetch** — 内置安全网关：URL 长度校验、凭据嵌入拦截、云元数据端点拦截、10 MB 下载上限、60 秒超时，避免裸 curl 的盲区

### AI 服务与模型

- **12+ 云端厂商** — Anthropic Claude、OpenAI、DeepSeek、通义千问(百炼)、豆包(火山引擎)、Moonshot、智谱、MiniMax、SiliconFlow、七牛、OpenRouter 等
- **本地模型** — Ollama 零配置接入，自动发现本地模型
- **自定义接入** — 支持任意 OpenAI 兼容 / Anthropic 兼容 API 端点
- **Provider 管理** — 添加、编辑、删除、排序，连接健康检查 + 延迟检测
- **模型选择器** — 对话中实时切换模型，能力徽章一目了然（视觉、工具调用、联网搜索、深度思考、图片生成、长上下文）
- **收藏与历史** — 常用模型一键收藏，最近使用快速切换
- **图像生成** — 内置 DALL-E 2 / DALL-E 3 接入，也支持任意自定义图片生成端点

### 联网搜索

- **多搜索引擎** — 支持 Bing、Brave、Tavily、SearXNG（自托管免 API Key）
- **独立配置** — 搜索引擎与主 AI 服务解耦，独立管理

### 自动化与触发器

- **定时任务** — Cron 表达式定时执行（如每天早上 9 点发 AI 日报）；app 关着期间错过的执行，下次启动会按时间顺序补跑
- **触发器系统** — 支持多种事件源自动触发 Agent 执行：
  - **文件监听** — 监控文件创建/修改/删除，支持 glob 模式匹配
  - **HTTP Webhook** — 自动生成 POST 端点，接收外部系统回调
  - **IM 消息** — 收到特定消息时触发任务
  - **Cron 定时** — 按时间计划周期执行
- **触发器权限模型** — 四级能力等级（只读 → 安全工具 → 完整权限 → 自定义白名单），精细控制自动任务的操作范围

### IM 频道集成

让阿布成为你的团队机器人 — 在 IM 中 @阿布 即可对话：

- **支持平台** — D-Chat、飞书、钉钉、企业微信、Slack
- **会话管理** — 自动按用户/群/线程隔离对话，超时自动归档，支持"继续上次"恢复
- **安全控制** — 用户白名单、工作空间路径限制、能力等级管控
- **响应模式** — 仅 @提及响应 或 全部消息响应

### 记忆与上下文

- **三层记忆体系（Memdir 文件化架构）**：
  - **个人记忆** — `~/.abu/memory/` 多文件目录，跨项目生效，自动按主题分文件存储，`MEMORY.md` 作为索引注入对话
  - **项目记忆** — `~/.abu/projects/<工作区>/memory/` 自动按工作区隔离，每条记忆为独立 `.md` 文件，便于阅读、搜索和回收
  - **历史升级自动迁移** — 老版本的 `~/.abu/agents/abu/memory.md` 和 `{workspace}/.abu/MEMORY.md` 启动时自动迁移到新结构
- **项目规则**（手写）：
  - `~/.abu/ABU.md` — 用户级规则（跨项目）
  - `{workspace}/.abu/ABU.md` — 项目级规则
  - `{workspace}/.abu/rules/*.md` — 模块化规则（按字母序加载，最多 20 个文件）
- **Projects 聚合** — 工作区可升级成 Project，同一文件夹下的对话自动归到一起，老对话启动时自动回填 projectId；每个项目可独立配置默认模型、技能集、MCP 连接器
- **会话记忆** — 大体积工具输出自动落盘，会话内保留紧凑摘要，防止上下文爆炸
- **Todo 跨重启** — 对话里的 todo_write 计划持久化到本地磁盘，重启续聊直接接着用
- **自动压缩** — 对话过长时智能压缩历史消息，保留关键上下文

### 安全与隐私

- **三档权限模式** — 标准（危险操作和新目录写入需要确认）/ 自动（只确认自动化任务，写入仍需确认）/ 严格（所有工具操作都要确认）
- **内容安全扫描** — 扫描 agent 写入的 skill / 记忆，拦截危险指令、prompt 注入、硬件指令等 120+ 类风险
- **OS 沙箱** — macOS Seatbelt (`sandbox-exec`) / Windows PowerShell ConstrainedLanguage，隔离 shell 命令的文件访问范围
- **网络隔离** — 本地代理 + 域名白名单 + 私有网络访问开关，可控制每条请求的目标
- **路径与命令双重校验** — 敏感目录（系统目录、SSH 密钥等）默认拦截；危险命令（`rm -rf /` 等）静态识别
- **电脑操控防护** — 敏感应用黑名单（钥匙串/系统设置/微信/Slack 等 15+）、危险按键拦截（Cmd+Q、Cmd+Tab、Force Quit 等）、会话级窗口隐藏、5 分钟超时熔断
- **API Key 加密存储** — Windows DPAPI / macOS AES-256-GCM（硬件 UUID 派生），不再明文写 localStorage
- **本地优先** — 数据存在本地，API Key 存在本地，不经过第三方服务器
- **跨平台** — 支持 macOS (Apple Silicon / Intel) 和 Windows

### 诊断与排障

- **一键自检** — 设置 → 诊断面板，逐项检查 AI 服务连接、数据&权限、MCP、技能、网络、应用环境
- **诊断包导出** — 出问题时一键打包日志、配置、版本信息（自动脱敏 API Key 和路径），方便发给作者排障

> 详细功能说明请查看 [使用指南](docs/User-Guide.md)

## 下载安装

前往 [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases) 下载最新版本：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `Abu_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Abu_x.x.x_x64.dmg` |
| Windows | `Abu_x.x.x_x64-setup.exe` |

> **macOS 用户注意**：首次打开如提示"已损坏"，需执行 `xattr -cr /Applications/Abu.app`，详见 [安装指南](docs/Installation-Guide.md)。

## 快速开始

### 1. 配置 AI 服务

打开 Abu → 设置 → **AI 服务管理**：

- **最快上手**：选择一个 API 厂商（如 DeepSeek、Anthropic），填入 API Key，点击验证
- **本地模型**：安装 [Ollama](https://ollama.com)，Abu 自动发现本地模型，无需 API Key
- **自定义接入**：填入任意 OpenAI 兼容 API 的 Base URL 和 Key

### 2. 开始对话

回到主界面，用模型选择器选择你想用的模型，然后开始对话。

**试试这些指令：**

```
帮我整理下桌面的文件，按类型分类放好
```
```
把这个 PDF 里的表格提取出来，生成 Excel
```
```
每天早上 9 点帮我搜索最新的 AI 新闻，生成日报
```
```
用前端技能帮我做一个产品 landing page
```
```
帮我做一份本周的工作周报 PPT
```

### 3. 进阶玩法

- **安装技能**：设置 → 自定义 → 技能商店，按需安装 PDF、PPT、前端设计等技能
- **连接 MCP**：设置 → MCP 连接器，一键接入 GitHub、Playwright 等外部工具
- **配置定时任务**：让阿布每天自动搜新闻、跑数据、发报告
- **连接 IM**：设置 → IM 频道，让团队在飞书/钉钉里直接 @阿布

> 更多使用场景请查看 [使用指南](docs/User-Guide.md)

## 内置技能一览（共 28 个）

| 类别 | 技能 |
|------|------|
| 文档生成 | PDF、PPTX、DOCX、XLSX |
| 设计创作 | 前端设计 (frontend-design)、画布设计 (canvas-design)、算法艺术 (algorithmic-art)、SVG 图表 (svg-diagram)、Mermaid 图表 (mermaid-diagram)、信息图 (infographic)、Slack GIF (slack-gif-creator)、HTML 小组件 (html-widget) |
| 浏览器自动化 | **Abu-Browser**（Chrome 桥接，自动安装扩展，操控真实浏览器） |
| 开发工具 | Claude API、MCP Server 构建 (mcp-builder)、Web Artifacts (web-artifacts-builder)、Web 应用测试 (webapp-testing) |
| 内容写作 | 文档协作 (doc-coauthoring)、品牌规范 (brand-guidelines)、内部通讯 (internal-comms) |
| 自动化 | 定时任务 (schedule)、触发器 (trigger)、告警 SOP (alert-sop) |
| 项目管理 | 技能创建器 (skill-creator)、项目初始化 (init)、Agent 创建 (create-agent) |
| Agent 反思 | 自省技能 (reflect) — agent 跑完任务后回溯沉淀 |
| 主题 | 主题工厂 (theme-factory)（10+ 预设主题，应用到任何产出物） |

> 除了内置技能，阿布还支持**自进化 Skills** — 在你跑完多轮复杂流程后主动提议"固化成技能"，自己攒出专属于你工作流的能力库。详见 [使用指南 · Skill 技能系统](docs/User-Guide.md#skill-技能系统)。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.0 (Rust + Web) |
| 前端 | React 19 + TypeScript (strict) + TailwindCSS v4 + Vite |
| LLM 适配 | 双协议适配器 (Anthropic / OpenAI-compatible) |
| 状态管理 | Zustand + Immer + Persist |
| 工具协议 | MCP (`@modelcontextprotocol/sdk`) |
| 联网搜索 | Bing / Brave / Tavily / SearXNG |
| 安全沙箱 | macOS Seatbelt + 路径/命令双重校验 |
| UI 组件 | Radix UI + Lucide Icons + shadcn 风格 |
| 测试 | Vitest + happy-dom（覆盖核心 store / agent / skill / memdir 等模块） |
| 评测 | 自带 OpenAI 协议工具调用评测器（`npm run eval:tool-selection`） |

## 从源码构建

### 前置要求

- Node.js >= 18
- Rust >= 1.75（[安装 Rust](https://rustup.rs/)）
- Tauri 2.0 系统依赖（[参考文档](https://v2.tauri.app/start/prerequisites/)）

### 开发

```bash
# 克隆仓库
git clone https://github.com/PM-Shawn/Abu-Cowork.git
cd Abu-Cowork

# 安装依赖
npm install

# 启动桌面应用（dev 隔离配置，与正式安装的 Abu 完全隔离）
npm run tauri:dev

# 仅启动前端（不需要 Rust）
npm run dev
```

### 构建

```bash
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 测试

```bash
npm test              # 运行测试
npm run test:watch    # 监听模式
npm run test:coverage # 覆盖率报告
npm run lint          # ESLint 检查
```

## 项目结构

```
src/
├── components/       # React UI 组件
│   ├── chat/         # 对话界面、消息气泡、模型选择器
│   ├── sidebar/      # 侧边栏导航（含 Recents 折叠搜索）
│   ├── panel/        # 右侧详情面板（工作区、项目记忆/指令）
│   ├── customize/    # 自定义（技能、Agent、模型）
│   ├── schedule/     # 定时任务视图
│   ├── trigger/      # 触发器（值班）管理视图
│   ├── settings/     # 系统设置（16 个面板，详见 settings/sections/）
│   ├── preview/      # 文件预览（PDF/Office/图片/Markdown）
│   └── ui/           # 基础 UI 组件 (shadcn/Radix)
├── core/             # 核心引擎（非 UI）
│   ├── agent/        # Agent 循环、后台 Agent、project rules
│   ├── llm/          # LLM 适配层（Claude / OpenAI-compatible / Ollama）
│   ├── tools/        # 工具注册、内置工具、安全校验
│   ├── mcp/          # MCP 客户端
│   ├── skill/        # Skill 加载与预处理
│   ├── search/       # 联网搜索（Bing/Brave/Tavily/SearXNG）
│   ├── memdir/       # 文件化记忆体系（personal/project，多文件 + 索引）
│   ├── scheduler/    # 定时调度引擎
│   ├── trigger/      # 触发器引擎（HTTP/文件/Cron/IM）
│   ├── im/           # IM 频道适配（D-Chat/飞书/钉钉/企微/Slack）
│   ├── permissions/  # 权限模型、能力等级
│   ├── context/      # 上下文管理与自动压缩
│   ├── session/      # 会话管理与磁盘落盘
│   ├── sandbox/      # 沙箱配置
│   ├── logging/      # 结构化日志
│   └── updates/      # 自动更新通道
├── eval/             # 工具调用 / 模型能力评测脚手架（开发者使用）
├── stores/           # Zustand 状态管理
├── hooks/            # React Hooks
├── i18n/             # 国际化 (中文 / English)
├── types/            # TypeScript 类型定义
└── utils/            # 工具函数

builtin-skills/       # 28 个内置技能（每个为独立目录）
builtin-agents/       # 内置 Agent 定义（预留）
abu-browser-bridge/   # 浏览器桥接 MCP Server
abu-chrome-extension/ # Chrome 扩展（Abu-Browser 技能依赖）
src-tauri/
├── src/
│   ├── computer_use.rs    # 截屏 + 键鼠控制 + 敏感应用拦截
│   ├── feishu_ws.rs       # 飞书 WebSocket 长连接
│   ├── overlay.rs         # 电脑操控状态浮层
│   ├── proxy.rs           # 网络隔离代理
│   ├── sandbox.rs         # macOS Seatbelt / Win ConstrainedLanguage
│   ├── trigger_server.rs  # HTTP 触发器服务器
│   └── window_info.rs     # 行为感知（活跃应用采样）
└── tauri.conf.json
```

## 文档

| 文档 | 说明 |
|------|------|
| [使用指南](docs/User-Guide.md) | 完整的产品功能介绍与使用说明 |
| [安装指南](docs/Installation-Guide.md) | 各平台安装与常见问题解决 |

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建你的分支：`git checkout -b feat/my-feature`
3. 提交改动：`git commit -m 'feat: add my feature'`
4. 推送分支：`git push origin feat/my-feature`
5. 发起 Pull Request

## 反馈与交流

使用中遇到问题或有好的想法，欢迎扫码加微信交流：

<img src="src/assets/wechat-qr.png" width="200" />

## 赞赏支持

如果阿布对你有帮助，欢迎请作者喝杯咖啡：

<img src="src/assets/sponsor-qr.png" width="200" />

## 许可证

[Apache License 2.0](LICENSE) — 可自由使用、修改、分发，包括商业用途，需保留版权声明。
