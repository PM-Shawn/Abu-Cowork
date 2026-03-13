# 触发器系统（Trigger System）设计方案

> 版本：v1.0 | 日期：2026-03-13
> 状态：Draft

---

## 一、背景与目标

### 1.1 业务场景

阿布当前有两种执行入口：**用户主动对话** 和 **定时任务（Schedule）**。缺少"事件驱动"能力——即外部事件发生时，阿布自动响应处理。

典型场景：
- IM 群收到告警消息 → 阿布自动排查并回复处理结果
- 目录出现新文件 → 阿布自动处理（发票识别、报表整理）
- 外部系统推送事件 → 阿布自动响应

### 1.2 设计目标

- 新增 **Trigger（触发器）** 作为第三种执行入口，与 Schedule 平级
- 复用现有 AgentLoop、Skill、MCP 工具链，不修改核心执行引擎
- 架构对齐现有 Schedule 系统的模式（Store + Engine + Tool + UI）
- Rust 侧遵循现有 proxy.rs 的 TCP Server 模式，最小化新依赖

### 1.3 行业参考

| 产品 | 触发器能力 | 阿布差异化 |
|------|-----------|-----------|
| Coze | 定时 + Webhook，每 Bot 最多 10 个 | 阿布可监听本地文件/数据库 |
| Dify | 定时 + 事件 + 插件集成 | 阿布有桌面操控能力 |
| n8n | Webhook + 数百种集成 | 阿布数据不出本地 |

---

## 二、整体架构

```
                      ┌─────────────────────────┐
                      │      触发源 (Sources)     │
                      │                         │
                      │  HTTP ← 外部 POST       │
                      │  SQLite ← 外部脚本轮询   │
                      │  FileWatch ← fs.watch   │
                      └───────────┬─────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────┐
│                   TriggerServer (Rust)                │
│              localhost:18080 (可配置)                  │
│                                                      │
│   POST /trigger/:id  ──emit──→  trigger-http-event   │
│   GET  /health                                       │
└──────────────────────────────────────────────────────┘
                                  │
                          Tauri Event
                                  │
                                  ▼
┌──────────────────────────────────────────────────────┐
│                TriggerEngine (TypeScript)             │
│                                                      │
│   listen("trigger-http-event")                       │
│       │                                              │
│       ▼                                              │
│   handleEvent()                                      │
│       ├── 静默时段检查                                 │
│       ├── Filter 匹配 (keyword/regex)                 │
│       ├── 防抖去重                                    │
│       └── executeAction()                            │
│               ├── createConversation(skipActivate)    │
│               ├── 变量注入 prompt                     │
│               └── runAgentLoop(convId, prompt, opts)  │
└──────────────────────────────────────────────────────┘
                                  │
                          复用现有能力
                                  │
                                  ▼
                    ┌──────────────────────┐
                    │   AgentLoop + Skill   │
                    │   + MCP Tools         │
                    └──────────────────────┘
```

### 与 Schedule 系统的对应关系

| Schedule | Trigger | 说明 |
|----------|---------|------|
| `src/types/schedule.ts` | `src/types/trigger.ts` | 类型定义 |
| `src/stores/scheduleStore.ts` | `src/stores/triggerStore.ts` | 状态管理 |
| `src/core/scheduler/scheduler.ts` | `src/core/trigger/triggerEngine.ts` | 执行引擎 |
| `manage_scheduled_task` tool | `manage_trigger` tool | LLM 管理工具 |
| `src/components/schedule/*` | `src/components/trigger/*` | UI 组件 |
| — | `src-tauri/src/trigger_server.rs` | **新增** Rust HTTP Server |

---

## 三、详细设计

### 3.1 类型定义 `src/types/trigger.ts`

```typescript
// ── 触发源 ──
export type TriggerSourceType = 'http';
// P1 阶段扩展: | 'file_watch'

export interface HttpSource {
  type: 'http';
  // 端点自动生成: POST /trigger/{triggerId}
}

export type TriggerSource = HttpSource;

// ── 过滤条件 ──
export type TriggerFilterType = 'always' | 'keyword' | 'regex';
// P2 阶段扩展: | 'llm'

export interface TriggerFilter {
  type: TriggerFilterType;
  keywords?: string[];        // type='keyword' 时使用
  pattern?: string;           // type='regex' 时使用
  field?: string;             // 在 event data 的哪个字段上匹配，默认全部 JSON
}

// ── 防抖 ──
export interface DebounceConfig {
  enabled: boolean;
  windowSeconds: number;      // 相同内容在此时间窗口内不重复触发
}

// ── 静默时段 ──
export interface QuietHoursConfig {
  enabled: boolean;
  start: string;              // "22:00"
  end: string;                // "08:00"
}

// ── 执行动作 ──
export interface TriggerAction {
  skillName?: string;         // 触发哪个 Skill，可选
  prompt: string;             // 发给 Agent 的指令，支持 $EVENT_DATA 变量
  workspacePath?: string;     // 工作区路径
}

// ── 运行记录 ──
export type TriggerRunStatus = 'running' | 'completed' | 'error' | 'filtered' | 'debounced';

export interface TriggerRun {
  id: string;
  triggerId: string;
  conversationId: string;
  startedAt: number;
  completedAt?: number;
  status: TriggerRunStatus;
  eventSummary?: string;      // 事件摘要（截断存储，避免数据过大）
  error?: string;
}

// ── 主结构 ──
export type TriggerStatus = 'active' | 'paused';

export interface Trigger {
  id: string;
  name: string;
  description?: string;
  status: TriggerStatus;
  source: TriggerSource;
  filter: TriggerFilter;
  action: TriggerAction;
  debounce: DebounceConfig;
  quietHours?: QuietHoursConfig;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
  runs: TriggerRun[];         // 最近 20 条
  totalRuns: number;
}

// ── HTTP 请求体 ──
export interface TriggerEventPayload {
  data: Record<string, unknown>;
}
```

**设计决策：**

1. **P0 只做 HTTP 触发源**。SQLite 和 FileWatch 的监听逻辑放在外部脚本，通过 HTTP POST 到阿布。理由：
   - 解耦：监听逻辑千差万别（不同 IM、不同数据库结构），不应硬编码到阿布
   - 简单：阿布只需要开一个 HTTP 端口，任何语言的脚本都能调用
   - 符合行业做法（n8n、Dify 都是 Webhook 模式）
   - 避免给 Rust 侧加 rusqlite 等重依赖

2. **变量注入用 `$EVENT_DATA`** 而非 `{{event.xxx}}`。对齐现有 Skill 系统的 `$ARG` 变量替换机制（`orchestrator.ts` 中的 `substituteVariables`）。`$EVENT_DATA` 会被替换为整个 event JSON 字符串，由 LLM 自行解析字段——比硬编码路径更灵活。

3. **filter.field 支持指定字段匹配**。例如只在 `data.content` 字段上做关键词过滤，避免 JSON 元数据误匹配。

---

### 3.2 Store `src/stores/triggerStore.ts`

对齐 `scheduleStore.ts` 的模式：Zustand + immer + persist。

```typescript
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type {
  Trigger, TriggerRun, TriggerStatus,
  TriggerSource, TriggerFilter, TriggerAction,
  DebounceConfig, QuietHoursConfig,
} from '@/types/trigger';

interface TriggerState {
  // 数据
  triggers: Record<string, Trigger>;

  // UI 状态（不持久化）
  selectedTriggerId: string | null;
  showEditor: boolean;
  editingTriggerId: string | null;
}

interface TriggerActions {
  // CRUD
  createTrigger: (data: {
    name: string;
    description?: string;
    source: TriggerSource;
    filter: TriggerFilter;
    action: TriggerAction;
    debounce: DebounceConfig;
    quietHours?: QuietHoursConfig;
  }) => string;
  updateTrigger: (id: string, data: Partial<Omit<Trigger, 'id' | 'createdAt' | 'runs' | 'totalRuns'>>) => void;
  deleteTrigger: (id: string) => void;
  setTriggerStatus: (id: string, status: TriggerStatus) => void;

  // 运行记录
  startRun: (triggerId: string, conversationId: string, eventSummary?: string) => string;
  completeRun: (triggerId: string, runId: string) => void;
  errorRun: (triggerId: string, runId: string, error: string) => void;
  recordSkipped: (triggerId: string, reason: 'filtered' | 'debounced') => void;

  // 查询
  getActiveTriggers: () => Trigger[];

  // UI
  setSelectedTriggerId: (id: string | null) => void;
  openEditor: (triggerId?: string) => void;
  closeEditor: () => void;
}
```

**持久化策略：** 对齐 scheduleStore。
- 存储键: `'abu-triggers'`
- 仅持久化 `triggers` 字段
- onRehydrateStorage: 重置 UI 状态，将 `running` 状态的 run 标记为 `error`

**运行记录：** 最多保留 20 条（与 Schedule 一致），使用 `unshift` + `slice(0, 20)`。

---

### 3.3 Rust HTTP Server `src-tauri/src/trigger_server.rs`

**技术选型：对齐 `proxy.rs` 模式**

现有 `proxy.rs` 使用 `std::net::TcpListener` + `thread::spawn` 实现网络代理服务器。TriggerServer 采用相同模式，不引入新 crate 依赖。

```rust
// 关键组件

// 1. 状态管理（对齐 proxy.rs 的 OnceLock 模式）
static TRIGGER_SERVER_PORT: OnceLock<u16> = OnceLock::new();
static TRIGGER_SERVER_RUNNING: AtomicBool = AtomicBool::new(false);

// 2. 启动命令
#[tauri::command]
pub fn start_trigger_server(app: AppHandle, port: u16) -> Result<u16, String> {
    // 绑定 127.0.0.1:port（仅本地访问）
    // 若 port=0 则自动分配
    // thread::spawn 启动 accept loop
    // 每个连接 thread::spawn 处理
    // 返回实际端口号
}

// 3. 请求处理
fn handle_connection(stream: TcpStream, app: &AppHandle) {
    // 手动解析 HTTP 请求（对齐 proxy.rs 的 parse_request 模式）
    // 路由:
    //   GET  /health           → 200 "ok"
    //   POST /trigger/{id}     → 解析 JSON body，emit Tauri Event
    //   其他                    → 404
}

// 4. 触发事件转发
fn fire_trigger(app: &AppHandle, trigger_id: &str, body: &str) {
    // app.emit("trigger-http-event", json!({
    //     "triggerId": trigger_id,
    //     "payload": serde_json::from_str(body)
    // }))
}

// 5. 停止命令
#[tauri::command]
pub fn stop_trigger_server() { ... }

// 6. 查询端口
#[tauri::command]
pub fn get_trigger_server_port() -> Option<u16> { ... }
```

**注册到 lib.rs：**

```rust
// src-tauri/src/lib.rs invoke_handler 中添加:
start_trigger_server,
stop_trigger_server,
get_trigger_server_port,
```

**设计决策：**

1. **不加 axum**。axum 不在现有依赖中，且我们只需 2 个端点，手动解析 HTTP 足够。proxy.rs 已证明此模式可行。
2. **仅绑定 127.0.0.1**。安全考虑，只接受本机请求。
3. **通过 Tauri Event 转发**。Rust 侧不做业务逻辑，只负责收 HTTP → emit event → 前端 TriggerEngine 处理。与 MCP 的 `mcp-msg-{id}` 事件模式一致。

**HTTP 协议约定：**

```
请求:
POST /trigger/{trigger_id} HTTP/1.1
Content-Type: application/json

{
  "data": {
    "content": "【告警】订单服务 RT 超过 500ms",
    "sender": "alertbot",
    "group": "运维群",
    "timestamp": "2026-03-13 14:32:05"
  }
}

成功响应:
HTTP/1.1 200 OK
Content-Type: application/json

{"success": true, "message": "Trigger abc123 fired"}

触发器不存在:
HTTP/1.1 200 OK
{"success": true, "message": "Event emitted (trigger lookup is async)"}
// 注: Rust 侧不查 Store，一律转发，由前端判断触发器是否存在

失败响应:
HTTP/1.1 400 Bad Request
{"success": false, "message": "Invalid JSON body"}
```

---

### 3.4 TriggerEngine `src/core/trigger/triggerEngine.ts`

对齐 `scheduler.ts` 的单例模式。

```typescript
class TriggerEngine {
  private runningTriggers = new Set<string>();
  private debounceCache = new Map<string, number>(); // "triggerId:contentHash" → timestamp
  private unlistenHttp?: () => void;

  // ── 生命周期（对齐 schedulerEngine.start/stop）──

  async start() {
    // 1. 调用 invoke('start_trigger_server', { port: 18080 })
    // 2. listen('trigger-http-event', callback) 监听 Rust 转发的事件
    // 3. 定期清理 debounceCache 中过期条目（每 5 分钟）
  }

  stop() {
    // 1. invoke('stop_trigger_server')
    // 2. this.unlistenHttp?.()
    // 3. 清空 runningTriggers 和 debounceCache
  }

  // ── 事件处理 ──

  async handleEvent(triggerId: string, payload: TriggerEventPayload) {
    // 1. 从 triggerStore 获取 trigger，验证 status === 'active'
    // 2. 静默时段检查 → 跳过
    // 3. Filter 匹配 → 不匹配则 recordSkipped('filtered')
    // 4. 防抖检查 → 重复则 recordSkipped('debounced')
    // 5. 并发控制 → 同一触发器正在执行则跳过
    // 6. executeAction()
  }

  private async executeAction(trigger: Trigger, payload: TriggerEventPayload) {
    // 对齐 scheduler.ts 的 executeTask 模式:
    //
    // 1. 创建隐藏会话
    //    const convId = chatStore.createConversation(
    //      trigger.action.workspacePath,
    //      { skipActivate: true }
    //    );
    //
    // 2. 设置会话标题（对齐 Schedule 的 [定时] 前缀）
    //    chatStore.renameConversation(convId, `[触发] ${trigger.name} - MM-DD HH:mm`);
    //
    // 3. 记录运行
    //    const runId = triggerStore.startRun(triggerId, convId, eventSummary);
    //
    // 4. 构建 prompt
    //    let prompt = trigger.action.prompt;
    //    // 替换 $EVENT_DATA 为 JSON 字符串
    //    prompt = prompt.replace(/\$EVENT_DATA/g, JSON.stringify(payload.data, null, 2));
    //    // 如果绑定了 Skill，加前缀
    //    if (trigger.action.skillName) {
    //      prompt = `/${trigger.action.skillName} ${prompt}`;
    //    }
    //
    // 5. 执行（对齐 scheduler 的权限模式）
    //    await runAgentLoop(convId, prompt, {
    //      commandConfirmCallback: autoDenyConfirmation,
    //      filePermissionCallback: autoFilePermission,
    //    });
    //
    // 6. 完成/错误处理 + 桌面通知
  }

  // ── 过滤逻辑 ──

  private matchFilter(trigger: Trigger, payload: TriggerEventPayload): boolean {
    const { filter } = trigger;
    // 确定匹配目标文本
    let text: string;
    if (filter.field) {
      // 指定字段匹配
      text = String(payload.data[filter.field] ?? '');
    } else {
      // 全 JSON 匹配
      text = JSON.stringify(payload.data);
    }

    switch (filter.type) {
      case 'always': return true;
      case 'keyword': return (filter.keywords ?? []).some(kw => text.includes(kw));
      case 'regex': return new RegExp(filter.pattern ?? '').test(text);
    }
  }

  // ── 防抖逻辑 ──

  private isDebounced(trigger: Trigger, payload: TriggerEventPayload): boolean {
    if (!trigger.debounce.enabled) return false;
    const content = JSON.stringify(payload.data);
    const hash = simpleHash(content);
    const key = `${trigger.id}:${hash}`;
    const now = Date.now();
    const last = this.debounceCache.get(key);
    if (last && now - last < trigger.debounce.windowSeconds * 1000) return true;
    this.debounceCache.set(key, now);
    return false;
  }

  // ── 静默时段 ──

  private isQuietHours(trigger: Trigger): boolean {
    // 同前文设计，支持跨午夜判断
  }
}

export const triggerEngine = new TriggerEngine();
```

**与 SchedulerEngine 的关键差异：**

| | SchedulerEngine | TriggerEngine |
|---|---|---|
| 触发方式 | 内部 60s 定时 tick | 外部 HTTP 事件推送 |
| 并发控制 | runningTasks Set | runningTriggers Set |
| 去重机制 | 无（由 nextRunAt 保证） | debounceCache（内容哈希 + 时间窗口） |
| 静默时段 | 无 | 有 |
| 过滤机制 | 无 | keyword / regex / field |

---

### 3.5 App 启动集成

```typescript
// src/App.tsx（现有 useEffect 中）
useEffect(() => {
  schedulerEngine.start();
  triggerEngine.start();       // ← 新增
  return () => {
    schedulerEngine.stop();
    triggerEngine.stop();      // ← 新增
  };
}, []);
```

---

### 3.6 LLM 管理工具 `manage_trigger`

对齐 `manage_scheduled_task` 工具的模式，注册到 `builtins.ts`。

```typescript
const manageTriggerTool: ToolDefinition = {
  name: 'manage_trigger',
  description: '创建、查看、更新、删除、暂停或恢复触发器（事件驱动的自动化任务）。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'],
      },
      // 创建/更新参数
      name: { type: 'string', description: '触发器名称' },
      description: { type: 'string', description: '触发器描述' },
      prompt: { type: 'string', description: '触发时执行的指令。用 $EVENT_DATA 引用事件数据' },
      skill_name: { type: 'string', description: '绑定的技能名称（可选）' },
      workspace_path: { type: 'string', description: '工作区路径（可选）' },
      // 过滤参数
      filter_type: { type: 'string', enum: ['always', 'keyword', 'regex'] },
      filter_keywords: {
        type: 'array', items: { type: 'string' },
        description: '关键词列表（filter_type=keyword 时）',
      },
      filter_pattern: { type: 'string', description: '正则表达式（filter_type=regex 时）' },
      filter_field: { type: 'string', description: '在事件数据的哪个字段上匹配（可选，默认全部）' },
      // 防抖参数
      debounce_enabled: { type: 'boolean', description: '是否启用防抖（默认 true）' },
      debounce_seconds: { type: 'number', description: '防抖时间窗口秒数（默认 300）' },
      // 操作参数
      trigger_id: { type: 'string', description: '触发器 ID（update/delete/pause/resume 时必填）' },
      status_filter: { type: 'string', enum: ['active', 'paused', 'all'] },
    },
    required: ['action'],
  },
  execute: async (input) => {
    // 对齐 manage_scheduled_task 的实现模式
    // create: 验证 name + prompt 必填，创建触发器，返回 ID 和 HTTP 端点地址
    // list: 列出所有触发器，显示状态、最近触发时间、HTTP 端点
    // update/delete/pause/resume: 需要 trigger_id
  },
};
```

**create 返回值示例：**
```
触发器已创建:
- 名称: 群消息告警处理
- ID: abc123xyz
- HTTP 端点: POST http://localhost:18080/trigger/abc123xyz
- 状态: active
- 过滤: keyword [告警, 异常, ERROR]
- 防抖: 5分钟

外部程序可通过以下命令触发:
curl -X POST http://localhost:18080/trigger/abc123xyz \
  -H "Content-Type: application/json" \
  -d '{"data": {"content": "告警内容", "sender": "xxx"}}'
```

---

### 3.7 Trigger 管理 Skill `builtin-skills/trigger/SKILL.md`

```yaml
---
name: trigger
description: 创建和管理触发器 - 设置事件驱动的自动化任务
trigger: 用户要求监听、触发、事件驱动执行某个操作，或想设置自动响应外部事件的任务
do-not-trigger: 用户只是讨论事件或通知概念，不涉及自动化处理；用户要求定时任务（应使用 schedule 技能）
user-invocable: true
argument-hint: <触发器描述>
allowed-tools:
  - manage_trigger
tags:
  - trigger
  - 触发器
  - 事件驱动
  - automation
  - webhook
---

# 触发器管理

你现在是触发器管理助手。帮用户创建和管理事件驱动的自动化任务。

## 什么是触发器

触发器是"事件驱动的自动化任务"——当外部事件发生时，阿布自动执行指定操作。
与定时任务的区别：定时任务按时间周期执行，触发器按事件发生执行。

## 工作原理

阿布在本地启动了一个 HTTP 服务（默认端口 18080），外部程序通过 POST 请求触发：

POST http://localhost:18080/trigger/{触发器ID}
Body: {"data": {"key": "value", ...}}

## 创建触发器的流程

1. 确认用户需求：什么事件、做什么处理、结果发到哪里
2. 设计过滤条件：是否需要关键词过滤、防抖去重
3. 编写执行指令（prompt）：用 $EVENT_DATA 引用事件数据
4. 调用 manage_trigger 创建
5. 告知用户 HTTP 端点地址和调用示例

## Prompt 编写指南

- 用 `$EVENT_DATA` 占位符引用事件数据，执行时会被替换为完整 JSON
- 如果需要绑定 Skill（如 alert-sop），在创建时指定 skill_name
- 示例 prompt：

```
收到一条群消息，请分析并处理：

$EVENT_DATA

如果是告警信息，按 SOP 排查。如果不是告警，忽略。
```

## 外部脚本示例

创建完触发器后，应主动提供对应的外部监听脚本示例，帮助用户快速接入。

### Python 监听 IM 数据库示例

```python
import sqlite3, time, requests, json

DB_PATH = "/path/to/im.db"
TRIGGER_URL = "http://localhost:18080/trigger/{触发器ID}"
KEYWORDS = ["告警", "异常", "ERROR"]

last_id = 0

while True:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, content, sender, group_name FROM messages WHERE id > ?",
        (last_id,)
    ).fetchall()
    conn.close()

    for row in rows:
        last_id = row[0]
        content = row[1]
        if any(kw in content for kw in KEYWORDS):
            requests.post(TRIGGER_URL, json={
                "data": {
                    "content": content,
                    "sender": row[2],
                    "group": row[3]
                }
            })

    time.sleep(5)
```

### Shell 脚本示例

```bash
curl -X POST http://localhost:18080/trigger/{触发器ID} \
  -H "Content-Type: application/json" \
  -d '{"data": {"content": "测试告警", "sender": "test"}}'
```
```

---

### 3.8 告警排查 SOP Skill `builtin-skills/alert-sop/SKILL.md`

```yaml
---
name: alert-sop
description: 自动分析告警信息，按SOP排查问题并生成处理报告
trigger: 收到告警消息需要自动排查处理，或用户提到告警分析、告警排查、SOP处理
do-not-trigger: 用户只是讨论告警相关概念，没有具体告警需要处理
user-invocable: true
argument-hint: <告警内容或事件数据 JSON>
tags:
  - ops
  - alert
  - sop
  - 运维
---

# 告警自动排查 SOP

你是一个运维告警处理专家。收到告警信息后，严格按以下流程排查。

## 告警数据

$ARG

## Step 1: 告警分类

分析告警内容，判断类型和紧急程度：

| 类型 | 特征 | 等级 |
|------|------|------|
| 服务不可用 | down, 502, 503, 连接失败, 不可用 | P0 |
| 性能劣化 | 超时, 延迟高, RT 升高, 慢查询 | P1 |
| 资源告警 | CPU, 内存, 磁盘, 容量 | P1 |
| 业务指标 | 成功率, 量跌, 转化率 | P2 |

## Step 2: 信息收集

依次调用可用的排查工具（根据已连接的 MCP Server 决定）：

1. 查服务状态 — 确认哪些服务受影响
2. 查错误日志 — 关注异常堆栈、错误频率、首次出现时间
3. 查监控指标 — 是否有突变、影响范围（单机 vs 集群）
4. 查发布记录 — 最近是否有发布、时间是否吻合

如果某个工具不可用或调用失败，跳过该步骤并在报告中注明。

## Step 3: 根因分析

综合信息分析根因，常见模式：
- 发布后出现 → 发布引入，建议回滚
- 突发无发布 → 依赖方/流量突增/资源耗尽
- 缓慢劣化 → 内存泄漏/连接池耗尽
- 周期性出现 → 定时任务冲突

如果无法确定根因，如实说明，不要猜测。

## Step 4: 生成报告

输出以下格式的报告：

```
【告警处理报告】
━━━━━━━━━━━━━━━━━━
告警内容：{一句话概括}
告警时间：{时间}
紧急程度：{P0/P1/P2}

排查结果：
  - 服务状态：{结果}
  - 错误日志：{关键信息}
  - 监控指标：{异常指标}
  - 最近发布：{有无}

根因分析：
  {1-3 句话}

建议操作：
  {具体建议}

当前状态：{已恢复/持续中/需人工介入}
━━━━━━━━━━━━━━━━━━
由阿布自动排查生成
```

## 注意事项

- 工具调用失败不要重试超过 2 次
- P0 告警报告末尾加"建议人工立即介入确认"
- 如果需要将报告发回群聊，使用可用的消息发送工具
```

**设计决策：**
- 使用 `$ARG` 而非自定义变量，对齐 Skill 系统现有的 `substituteVariables` 机制
- 不硬编码具体的 tool name（如 `query_service_status`），改为描述性指令，让 Agent 根据已连接的 MCP Server 自行选择可用工具
- 这样该 Skill 不依赖特定 MCP Server，具有通用性

---

### 3.9 UI 组件 `src/components/trigger/`

对齐 `src/components/schedule/` 的组件结构：

```
src/components/trigger/
├── TriggerView.tsx           # 列表页（对齐 ScheduleView）
├── TriggerEditor.tsx         # 创建/编辑弹窗（对齐 ScheduleEditor）
├── TriggerCard.tsx           # 触发器卡片（对齐 ScheduleTaskCard）
├── TriggerDetail.tsx         # 详情页（对齐 ScheduleTaskDetail）
└── TriggerRunHistory.tsx     # 运行记录（对齐 ScheduleRunHistory）
```

**TriggerEditor 表单字段：**

```
┌─────────────────────────────────────────┐
│  新建触发器                               │
├─────────────────────────────────────────┤
│  名称 *        [                    ]    │
│  描述          [                    ]    │
│                                         │
│  ── 触发条件 ──                          │
│  过滤方式:  [每次触发] [关键词] [正则]     │
│  关键词:    [告警] [异常] [ERROR] [+]    │  ← 仅 filter_type=keyword 显示
│  匹配字段:  [content        ] (可选)     │
│                                         │
│  ── 执行动作 ──                          │
│  绑定技能:  [无 ▾] / [alert-sop ▾]      │
│  执行指令 *:                             │
│  ┌─────────────────────────────────┐    │
│  │ 收到群消息，请分析处理：          │    │
│  │ $EVENT_DATA                     │    │
│  │ 如果是告警，按SOP排查。           │    │
│  └─────────────────────────────────┘    │
│  💡 用 $EVENT_DATA 引用事件数据           │
│                                         │
│  ── 防抖设置 ──                          │
│  [✓] 启用防抖   间隔: [300] 秒           │
│                                         │
│  ── 静默时段（可选）──                    │
│  [ ] 启用   [22:00] - [08:00]           │
│                                         │
│            [取消]  [保存并启用]            │
└─────────────────────────────────────────┘
```

**TriggerDetail 页面增加：**
- HTTP 端点地址展示 + 复制按钮
- curl 示例展示 + 复制按钮
- "测试触发"按钮（发送一个测试 payload）

---

## 四、外部监听脚本方案

阿布本身只提供 HTTP 触发端口，监听逻辑由外部脚本完成。这是有意的设计——不同 IM、不同数据库结构差异极大，硬编码不如提供脚本模板。

### 4.1 IM 数据库监听脚本（独立进程）

```python
#!/usr/bin/env python3
"""
IM 群消息监听脚本 —— 监听本地 IM 数据库，将告警消息推送给阿布
用法: python im_watcher.py --db /path/to/im.db --trigger-id abc123
"""
import sqlite3, time, hashlib, argparse, requests, json, sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True, help='IM 数据库路径')
    parser.add_argument('--trigger-id', required=True, help='阿布触发器 ID')
    parser.add_argument('--port', type=int, default=18080, help='阿布端口')
    parser.add_argument('--table', default='messages', help='消息表名')
    parser.add_argument('--interval', type=int, default=5, help='轮询间隔(秒)')
    parser.add_argument('--keywords', nargs='+', default=['告警', '异常', 'ERROR', 'CRITICAL'],
                        help='过滤关键词')
    parser.add_argument('--group', help='只监听指定群（可选）')
    args = parser.parse_args()

    url = f"http://localhost:{args.port}/trigger/{args.trigger_id}"
    last_id = get_max_id(args.db, args.table)
    recent_hashes = {}  # 本地防抖

    print(f"[im_watcher] 开始监听 {args.db}")
    print(f"[im_watcher] 推送地址 {url}")
    print(f"[im_watcher] 关键词 {args.keywords}")

    while True:
        try:
            conn = sqlite3.connect(args.db, timeout=5)
            conn.row_factory = sqlite3.Row
            query = f"SELECT * FROM {args.table} WHERE id > ?"
            params = [last_id]
            if args.group:
                query += " AND group_name = ?"
                params.append(args.group)
            rows = conn.execute(query, params).fetchall()
            conn.close()

            for row in rows:
                last_id = row['id']
                content = row['content'] if 'content' in row.keys() else ''

                # 关键词预过滤
                if not any(kw in content for kw in args.keywords):
                    continue

                # 本地防抖（5分钟）
                h = hashlib.md5(content.encode()).hexdigest()[:8]
                now = time.time()
                if h in recent_hashes and now - recent_hashes[h] < 300:
                    continue
                recent_hashes[h] = now

                # 推送给阿布
                payload = {"data": dict(row)}
                try:
                    resp = requests.post(url, json=payload, timeout=5)
                    print(f"[im_watcher] 推送成功: {content[:50]}... → {resp.status_code}")
                except Exception as e:
                    print(f"[im_watcher] 推送失败: {e}")

        except Exception as e:
            print(f"[im_watcher] 轮询异常: {e}")

        time.sleep(args.interval)


def get_max_id(db_path, table):
    try:
        conn = sqlite3.connect(db_path, timeout=5)
        result = conn.execute(f"SELECT MAX(id) FROM {table}").fetchone()
        conn.close()
        return result[0] or 0
    except:
        return 0

if __name__ == '__main__':
    main()
```

**分层过滤设计（三层漏斗）：**

```
第一层: 外部脚本 — 关键词 + 发送人 + 群过滤（零 token 成本）
    ↓ 只有疑似告警才推送
第二层: TriggerEngine — filter + debounce（零 token 成本）
    ↓ 确认需要处理才启动 Agent
第三层: Agent（LLM）— 理解语义，判断是否真需要处理
    ↓ 确认后执行 SOP
```

---

## 五、运维平台 MCP Server

告警排查需要调用内部平台接口，封装为 MCP Server。

### 5.1 推荐结构

```
abu-ops-bridge/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts          # MCP Server 入口
```

### 5.2 工具定义

```typescript
// 根据实际内部平台 API 实现，以下为接口规范

tools: [
  {
    name: "query_service_status",
    description: "查询服务健康状态",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "服务名，不填查全部" },
      },
    },
    // 实现: 调用内部监控平台 API
  },
  {
    name: "query_recent_logs",
    description: "查询最近的错误日志",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string" },
        minutes: { type: "number", default: 30 },
        level: { type: "string", default: "ERROR" },
      },
      required: ["service_name"],
    },
  },
  {
    name: "query_metrics",
    description: "查询监控指标（CPU/内存/RT/QPS/错误率等）",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string" },
        metric_name: { type: "string" },
        minutes: { type: "number", default: 60 },
      },
      required: ["service_name"],
    },
  },
  {
    name: "query_deployment_history",
    description: "查询最近的发布/部署记录",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string" },
        hours: { type: "number", default: 24 },
      },
    },
  },
  {
    name: "send_im_message",
    description: "发送消息到 IM 群",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", description: "群 ID 或群名" },
        content: { type: "string", description: "消息内容" },
      },
      required: ["group_id", "content"],
    },
    // 实现方案选择:
    // A. 调用 IM 内部 API（如果有）
    // B. 模拟操作: 通过 AppleScript/Accessibility API 操控 IM 窗口
    // C. 写入 IM 数据库（需验证 IM 客户端是否会同步）
  },
]
```

### 5.3 接入方式

在阿布设置中添加该 MCP Server：

```json
{
  "name": "ops-bridge",
  "type": "stdio",
  "command": "node",
  "args": ["path/to/abu-ops-bridge/dist/index.js"],
  "env": {
    "OPS_API_BASE": "http://internal-ops-platform/api",
    "OPS_API_TOKEN": "xxx"
  }
}
```

---

## 六、端到端流程示例

### 场景：IM 群告警自动处理

**配置阶段：**

1. 用户对阿布说："帮我创建一个触发器，监听运维群的告警消息，自动排查并回复"
2. 阿布通过 trigger skill + manage_trigger tool 创建触发器
3. 返回触发器 ID 和 HTTP 端点
4. 用户启动外部脚本 `python im_watcher.py --db /path/to/im.db --trigger-id abc123`

**执行阶段：**

```
14:32:00  IM 群收到消息: "【P1告警】订单服务 RT 超过 500ms，持续 5 分钟"
    │
14:32:05  im_watcher.py 检测到新消息，关键词匹配"告警"
    │      POST http://localhost:18080/trigger/abc123
    │      Body: {"data": {"content": "【P1告警】...", "sender": "alertbot", "group": "运维群"}}
    │
14:32:05  TriggerServer (Rust) 收到请求
    │      emit("trigger-http-event", payload)
    │
14:32:05  TriggerEngine.handleEvent("abc123", payload)
    │      ✓ 非静默时段
    │      ✓ 关键词匹配通过
    │      ✓ 非防抖重复
    │
14:32:05  TriggerEngine.executeAction()
    │      创建会话: [触发] 群消息告警处理 - 03-13 14:32
    │      Prompt: "/alert-sop 收到群消息，请分析处理：\n{...JSON...}"
    │
14:32:06  AgentLoop 开始执行
    │      System Prompt 注入 alert-sop SKILL.md 内容
    │
14:32:08  Agent Step 1: 分析告警 → P1 性能劣化
14:32:12  Agent Step 2: 调用 query_service_status → 订单服务响应慢
14:32:18  Agent Step 3: 调用 query_recent_logs → 发现数据库超时
14:32:24  Agent Step 4: 调用 query_metrics → RT 从 50ms 飙到 600ms
14:32:28  Agent Step 5: 调用 query_deployment_history → 14:00 有发布
14:32:32  Agent Step 6: 分析根因 → 14:00 发布引入慢 SQL
14:32:35  Agent Step 7: 调用 send_im_message → 发送报告到运维群
    │
14:32:35  运维群收到阿布回复:
           【告警处理报告】
           ━━━━━━━━━━━━━━━━━━
           告警内容：订单服务 RT 超过 500ms
           紧急程度：P1
           根因分析：14:00 发布引入慢 SQL，导致数据库查询超时
           建议操作：回滚 14:00 的发布，或优化相关 SQL
           ━━━━━━━━━━━━━━━━━━
```

---

## 七、开发任务拆解

### P0: 最小可用（跑通一个场景）

| # | 任务 | 涉及文件 | 估时 | 依赖 |
|---|------|---------|------|------|
| 1 | 类型定义 | `src/types/trigger.ts` | 0.5d | 无 |
| 2 | Store | `src/stores/triggerStore.ts` | 1d | #1 |
| 3 | Rust HTTP Server | `src-tauri/src/trigger_server.rs` + `lib.rs` 注册 | 1.5d | 无 |
| 4 | TriggerEngine | `src/core/trigger/triggerEngine.ts` | 2d | #2, #3 |
| 5 | manage_trigger tool | `src/core/tools/builtins.ts` 追加 | 1d | #2 |
| 6 | App.tsx 集成 | `src/App.tsx` 加启动 | 0.5d | #4 |
| 7 | trigger Skill | `builtin-skills/trigger/SKILL.md` | 0.5d | #5 |
| 8 | alert-sop Skill | `builtin-skills/alert-sop/SKILL.md` | 0.5d | 无 |
| 9 | 联调测试（curl 手动触发） | — | 1d | #1-#8 |

**P0 合计: ~8.5 人天**

### P1: 产品化

| # | 任务 | 估时 | 依赖 |
|---|------|------|------|
| 10 | TriggerView 列表页 | 1d | P0 |
| 11 | TriggerEditor 表单 | 1.5d | P0 |
| 12 | TriggerCard 卡片 | 0.5d | P0 |
| 13 | TriggerDetail 详情页 | 1d | P0 |
| 14 | TriggerRunHistory 运行记录 | 0.5d | P0 |
| 15 | 侧边栏导航入口 | 0.5d | #10 |
| 16 | im_watcher.py 脚本模板 | 0.5d | 无 |
| 17 | abu-ops-bridge MCP Server | 2-3d | 需对接内部 API |

**P1 合计: ~8 人天**

### P2: 增强

| # | 任务 | 说明 |
|---|------|------|
| 18 | file_watch 触发源 | TriggerEngine 内置文件监听 |
| 19 | LLM 过滤（filter.type=llm） | 用小模型做语义判断 |
| 20 | 人工确认模式 | 桌面通知 + 确认后执行 |
| 21 | 触发器模板市场 | 预置常见场景模板 |
| 22 | TriggerServer 端口可配置 UI | 设置页面 |
| 23 | 外部脚本管理（启停/日志） | 在阿布内管理监听脚本生命周期 |

---

## 八、风险与决策记录

| 决策 | 选择 | 理由 | 替代方案 |
|------|------|------|---------|
| HTTP 框架 | 原生 TCP（对齐 proxy.rs） | 零新依赖，2 个端点足够 | 加 axum（更优雅但增加依赖） |
| SQLite 监听 | 外部脚本 + HTTP 推送 | 解耦，IM 差异大 | Rust 侧加 rusqlite（增加耦合） |
| 变量注入 | `$EVENT_DATA` 整体替换 | 对齐现有 `$ARG` 机制 | 模板引擎 `{{event.xxx}}`（需新增机制） |
| 发消息 | MCP Server 封装 | 灵活，可按实际 IM 实现 | 阿布内置 Computer Use 操控 |
| 安全 | 仅绑定 127.0.0.1 | 防止外部访问 | 加 token 认证（P2 考虑） |

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| IM 数据库加密 | 外部脚本无法读取 | 需先确认是否加密，可能需要解密工具 |
| 发消息无 API | 回复群聊困难 | 备选方案：剪贴板+模拟按键、IM 内部 IPC |
| 高频触发消耗 token | 成本失控 | 三层漏斗过滤 + 防抖 + 静默时段 |
| 阿布未运行时事件丢失 | 告警未处理 | P2 考虑事件队列持久化 |
