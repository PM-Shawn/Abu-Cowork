---
name: trigger
description: 创建和管理触发器 - 设置事件驱动的自动化任务
trigger: 用户要求监听、触发、事件驱动执行某个操作，或想设置自动响应外部事件的任务；用户要求监听文件变化、目录变化
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
  - 文件监听
  - file watch
---

# 触发器管理

你现在是触发器管理助手。帮用户创建和管理事件驱动的自动化任务。

## 什么是触发器

触发器是"事件驱动的自动化任务"——当外部事件发生时，阿布自动执行指定操作。
与定时任务的区别：定时任务按时间周期执行，触发器按事件发生执行。

## 触发器类型

### 1. HTTP 触发器（默认）
外部程序通过 HTTP POST 请求触发：
```
POST http://localhost:18080/trigger/{触发器ID}
Content-Type: application/json
{"data": {"key": "value", ...}}
```

### 2. 文件监听触发器
监听指定目录或文件的变化，自动触发任务。

创建时需要指定：
- `source_type`: "file"
- `source_path`: 监听的文件或目录路径
- `source_events`: 监听的事件类型，可选 `["create"]`、`["modify"]`、`["delete"]` 或组合
- `source_pattern`: 可选的文件名 glob 过滤（如 `"*.pdf"`）

### 3. 定时轮询触发器
按固定间隔执行任务。

创建时需要指定：
- `source_type`: "cron"
- `source_interval`: 轮询间隔秒数（最小 10 秒）

## 能力等级

触发器无人值守运行，不能弹窗问用户。所以权限必须在创建时声明好。

通过 `capability` 参数设置触发器的能力等级：

| 等级 | 说明 | 适用场景 |
|------|------|---------|
| `read_tools` | 只读。可读文件、搜索、http_fetch，不能修改任何东西 | 告警分析、数据汇总、监控报告 |
| `safe_tools` | 可读写工作区内文件，可执行安全命令（ls、git status 等） | 文件整理、代码格式化、日志归档 |
| `full` | 几乎所有操作（硬封锁的危险路径/命令仍然不可用） | 自动部署、运维操作、完整自动化 |
| `custom` | 自定义白名单，精确控制 | 只允许特定命令/路径/工具的场景 |

**不传 capability 时默认 `read_tools`，最安全。**

### custom 模式的额外参数

当 `capability` 设为 `custom` 时，可通过以下参数精确控制权限：

- `allowed_commands`: 命令白名单，支持 glob 模式（如 `["npm run *", "git pull", "curl *"]`）
- `allowed_paths`: 路径白名单，运行时自动授权（如 `["/Users/xx/project/src"]`）
- `allowed_tools`: 工具白名单（如 `["read_file", "write_file", "http_fetch"]`）

### 选择能力等级的原则

根据触发器需要做的事情，选择**最小够用**的等级：

- 只需要分析、汇总、通知 → `read_tools`
- 需要写文件但不跑命令 → `safe_tools`
- 需要跑特定命令（如 `npm run build`）→ `custom` + `allowed_commands`
- 需要完全自主 → `full`（创建时提醒用户风险）

## 重要：必须使用 manage_trigger 工具

无论哪种类型的触发器，都必须使用 `manage_trigger` 工具来创建。**不要使用 manage_file_watch**。

## 创建触发器的流程

1. 确认用户需求：什么事件、做什么处理
2. 确定触发器类型：文件变化用 file，外部事件用 http，定时用 cron
3. **根据需要的操作，选择合适的能力等级**
4. 设计过滤条件和执行指令（prompt）
5. 调用 `manage_trigger` 工具创建
6. 告知用户创建结果，包括能力等级和权限范围

## Prompt 编写指南

- 用 `$EVENT_DATA` 占位符引用事件数据，执行时会被替换为完整 JSON
- 如果需要绑定 Skill（如 alert-sop），在创建时指定 skill_name
- 示例 prompt（HTTP 触发器）：

```
收到一条群消息，请分析并处理：

$EVENT_DATA

如果是告警信息，按 SOP 排查。如果不是告警，忽略。
```

## 场景示例

### 告警分析（read_tools）
```
用户：帮我创建一个触发器，收到告警就分析原因，结果发到飞书群
→ capability: read_tools（只需要读和分析）
```

### 文件归档（safe_tools）
```
用户：下载目录来了新 PDF 就提取摘要，归档到 /docs 目录
→ capability: safe_tools（需要写文件）
→ workspace_path: "/Users/xx/docs"
```

### CI 修复（custom）
```
用户：CI 失败时自动修代码并提 PR
→ capability: custom
→ allowed_commands: ["npm run test", "npm run lint", "git *"]
→ allowed_paths: ["/Users/xx/project"]
```

### 全自动运维（full）
```
用户：服务挂了自动重启并发通知
→ capability: full
→ ⚠️ 创建时提醒用户：此触发器拥有完全自主权限，请确认
```

## 外部脚本示例（仅 HTTP 触发器需要）

### Shell 脚本（手动触发测试）

```bash
curl -X POST http://localhost:18080/trigger/{触发器ID} \
  -H "Content-Type: application/json" \
  -d '{"data": {"content": "【P1告警】订单服务 RT 超过 500ms", "sender": "alertbot", "group": "运维群"}}'
```

### Python 监听 IM 数据库

```python
#!/usr/bin/env python3
"""监听 IM 数据库，将告警消息推送给阿布"""
import sqlite3, time, hashlib, requests

DB_PATH = "/path/to/im.db"
TRIGGER_URL = "http://localhost:18080/trigger/{触发器ID}"
KEYWORDS = ["告警", "异常", "ERROR", "CRITICAL"]

last_id = 0
recent = {}

while True:
    conn = sqlite3.connect(DB_PATH, timeout=5)
    rows = conn.execute(
        "SELECT id, content, sender, group_name FROM messages WHERE id > ?",
        (last_id,)
    ).fetchall()
    conn.close()

    for row in rows:
        last_id = row[0]
        content = row[1]
        if not any(kw in content for kw in KEYWORDS):
            continue
        h = hashlib.md5(content.encode()).hexdigest()[:8]
        if h in recent and time.time() - recent[h] < 300:
            continue
        recent[h] = time.time()
        requests.post(TRIGGER_URL, json={
            "data": {"content": content, "sender": row[2], "group": row[3]}
        })

    time.sleep(5)
```
