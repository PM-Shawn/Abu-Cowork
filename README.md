<div align="center">

**中文** | [English](README_EN.md)

<img src="website/assets/abu-avatar.png" width="120" height="120" style="border-radius: 24px" />

# Abu (阿布)

**你的 AI 桌面办公搭子 — 交给阿布就行啦**

本地运行的 AI 桌面办公助手，灵感来自 Claude Code 的 Cowork 模式。
你说需求，阿布干活 — 读文件、跑命令、写文档、做报表，全在本地完成。

[![Release](https://img.shields.io/github/v/release/PM-Shawn/Abu-Cowork?style=flat-square)](https://github.com/PM-Shawn/Abu-Cowork/releases)
[![License](https://img.shields.io/badge/license-Abu%20License-blue?style=flat-square)](LICENSE)

[下载安装](#-下载安装) · [快速开始](#-快速开始) · [功能介绍](#-功能介绍) · [使用指南](docs/User-Guide.md) · [从源码构建](#-从源码构建)

</div>

---

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
<td align="center"><b>Skill 技能</b><br/>内置 20+ 技能，支持自定义扩展<br/><br/><img src="website/assets/screenshot-skills.png" width="100%" /></td>
<td align="center"><b>MCP 连接器</b><br/>一键接入 Playwright、GitHub 等外部工具<br/><br/><img src="website/assets/screenshot-mcp.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>定时任务</b><br/>Cron 定时执行，让阿布每天自动工作<br/><br/><img src="website/assets/screenshot-schedule-create.png" width="100%" /></td>
<td align="center"><b>触发器 / 值班</b><br/>HTTP、文件变更、IM 消息等事件自动触发<br/><br/><img src="website/assets/screenshot-triggers.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>AI 服务配置</b><br/>支持多厂商模型，灵活切换<br/><br/><img src="website/assets/screenshot-settings-ai.png" width="100%" /></td>
<td align="center"><b>IM 频道配置</b><br/>连接飞书、钉钉、企微等 IM 平台<br/><br/><img src="website/assets/screenshot-settings-im.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>个人记忆</b><br/>记住你的偏好和工作习惯<br/><br/><img src="website/assets/screenshot-memory.png" width="100%" /></td>
<td align="center"><b>安全沙箱</b><br/>Seatbelt 沙箱 + 网络隔离，保护隐私<br/><br/><img src="website/assets/screenshot-security.png" width="100%" /></td>
</tr>
</table>

## 功能介绍

### 核心能力

- **Agent 自主执行** — 不只是聊天，能自主规划、调用工具、读写文件、执行命令，完成复杂任务
- **Skill 技能系统** — 内置 20+ 技能（翻译、周报、代码审查、深度研究、文档写作等），一键安装，支持自定义
- **MCP 工具协议** — 通过 Model Context Protocol 连接数据库、搜索引擎、GitHub 等外部服务
- **多模型支持** — 支持 Anthropic Claude、DeepSeek、通义千问、豆包、Moonshot、智谱等主流模型

### 自动化与触发器

- **定时任务** — Cron 表达式定时执行（如每天早上 9 点发 AI 日报）
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

- **个人记忆** — 阿布会记住你的偏好和工作习惯（`~/.abu/agents/memory.md`）
- **项目记忆** — 自动维护项目级上下文（`{workspace}/.abu/MEMORY.md`）
- **项目指令** — 手动配置项目专属规则（`{workspace}/.abu/ABU.md`）

### 浏览器集成

- **浏览器桥接** — 通过 MCP Server 连接 Chrome，实现网页自动化操作
- **Chrome 扩展** — 配合阿布完成网页元素点击、表单填写、截图、JS 执行等操作

### 安全与隐私

- **沙箱安全** — macOS Seatbelt 沙箱隔离 + 敏感路径保护 + 命令安全检查
- **本地优先** — 数据存在本地，API Key 存在本地，不经过第三方服务器
- **跨平台** — 支持 macOS (Apple Silicon / Intel) 和 Windows

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

1. 下载安装并打开 Abu
2. 点击左下角设置图标，进入「自定义模型」
3. 选择 API 厂商，填入 API Key
4. 回到主界面，开始对话

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

> 更多使用场景请查看 [使用指南](docs/User-Guide.md)

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.0 (Rust + Web) |
| 前端 | React 19 + TypeScript + TailwindCSS v4 + Vite |
| LLM | 多模型适配 (Anthropic / OpenAI-compatible) |
| 状态管理 | Zustand + Immer |
| 工具协议 | MCP (`@modelcontextprotocol/sdk`) |
| 安全沙箱 | macOS Seatbelt + 路径/命令双重校验 |
| UI | Radix UI + Lucide Icons |
| 测试 | Vitest + happy-dom |

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

# 启动桌面应用（推荐）
npm run tauri dev

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
│   ├── chat/         # 对话界面、消息气泡、Markdown 渲染
│   ├── sidebar/      # 侧边栏导航
│   ├── panel/        # 右侧详情面板
│   ├── schedule/     # 定时任务视图
│   ├── trigger/      # 触发器管理视图
│   ├── settings/     # 系统设置（含 IM 频道配置）
│   └── ui/           # 基础 UI 组件 (shadcn/Radix)
├── core/             # 核心引擎（非 UI）
│   ├── agent/        # Agent 循环、重试、记忆系统
│   ├── llm/          # LLM 适配层 (Claude + OpenAI-compatible)
│   ├── tools/        # 工具注册、内置工具、安全校验
│   ├── mcp/          # MCP 客户端
│   ├── skill/        # Skill 加载与预处理
│   ├── scheduler/    # 定时调度引擎
│   ├── trigger/      # 触发器引擎（文件监听/Webhook/Cron/IM）
│   ├── im/           # IM 频道适配（D-Chat/飞书/钉钉/企微/Slack）
│   ├── context/      # 上下文管理与 Token 估算
│   └── sandbox/      # 沙箱配置
├── stores/           # Zustand 状态管理
├── hooks/            # React Hooks
├── i18n/             # 国际化 (中文 / English)
├── types/            # TypeScript 类型定义
└── utils/            # 工具函数

builtin-skills/       # 内置技能定义 (翻译、周报、代码审查等)
builtin-agents/       # 内置 Agent 定义
abu-browser-bridge/   # 浏览器桥接 MCP Server
abu-chrome-extension/ # Chrome 扩展
src-tauri/            # Tauri Rust 后端 (沙箱、命令执行、网络代理)
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

[Abu License](LICENSE) — 个人、教育、非商业用途免费使用。使用需保留版权声明，禁止修改或删除。商业用途需获取授权，详见 [LICENSE](LICENSE)。
