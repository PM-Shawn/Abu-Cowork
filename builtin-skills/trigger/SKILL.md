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

```
POST http://localhost:18080/trigger/{触发器ID}
Content-Type: application/json

{"data": {"key": "value", ...}}
```

## 创建触发器的流程

1. 确认用户需求：什么事件、做什么处理、结果发到哪里
2. 设计过滤条件：是否需要关键词过滤、防抖去重
3. 编写执行指令（prompt）：用 `$EVENT_DATA` 引用事件数据
4. 调用 `manage_trigger` 工具创建
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

### Shell 脚本示例（手动触发测试）

```bash
curl -X POST http://localhost:18080/trigger/{触发器ID} \
  -H "Content-Type: application/json" \
  -d '{"data": {"content": "【P1告警】订单服务 RT 超过 500ms", "sender": "alertbot", "group": "运维群"}}'
```
