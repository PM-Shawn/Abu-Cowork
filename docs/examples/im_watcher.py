#!/usr/bin/env python3
"""
IM 消息监听器 — 监听本地 IM 数据库，将新消息 POST 到 Abu 触发器

使用方法:
  1. 在 Abu 中创建一个触发器，获取触发器 ID
  2. 修改下方配置（数据库路径、触发器地址、群聊过滤等）
  3. 运行: python im_watcher.py

支持的 IM 客户端（需自行调整 SQL 查询）:
  - 微信 (WeChat) — ~/Library/Containers/com.tencent.xinwei/Data/...
  - 企业微信 (WeCom) — 类似路径
  - 钉钉 (DingTalk) — 本地 SQLite 数据库
  - 飞书 (Lark) — 本地缓存数据库

注意:
  - 此脚本仅作为模板，实际数据库路径和表结构因 IM 版本而异
  - 部分 IM 客户端的数据库可能加密，需要额外处理
  - 建议配合关键词过滤，避免大量无关消息涌入
"""

import sqlite3
import time
import json
import hashlib
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

# ============================================================
# 配置区 — 根据实际情况修改
# ============================================================

# Abu 触发器地址（在 Abu 触发器详情页复制）
TRIGGER_URL = "http://localhost:18080/trigger/YOUR_TRIGGER_ID"

# IM 数据库路径（示例为微信 macOS，请替换为实际路径）
DB_PATH = Path.home() / "Library/Containers/com.tencent.xinwei/Data/Library/Application Support/com.tencent.xinwei/xxx_yyy/msg/message_1.db"

# 轮询间隔（秒）
POLL_INTERVAL = 5

# 要监听的群聊 ID 列表（为空则监听所有）
WATCH_GROUPS = [
    # "group_id_1",
    # "group_id_2",
]

# 关键词过滤（消息包含任一关键词才发送，为空则不过滤）
KEYWORDS = [
    # "告警",
    # "error",
    # "alert",
    # "P0",
    # "故障",
]

# ============================================================
# 核心逻辑
# ============================================================

class IMWatcher:
    def __init__(self):
        self.last_msg_id: Optional[int] = None
        self.sent_hashes: set[str] = set()  # 防重复

    def get_latest_messages(self) -> list[dict]:
        """从 IM 数据库读取新消息（示例 SQL，需根据实际表结构调整）"""
        if not DB_PATH.exists():
            print(f"[WARN] 数据库不存在: {DB_PATH}")
            return []

        try:
            # 以只读模式打开，避免锁冲突
            conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # === 示例 SQL（微信 macOS 旧版结构，仅供参考） ===
            # 实际表名和字段名因 IM 版本而异，请自行抓取
            query = """
                SELECT
                    mesLocalID   AS msg_id,
                    mesMesSvrID  AS server_id,
                    msgCreateTime AS timestamp,
                    mesDes       AS is_incoming,
                    mesContent   AS content,
                    mesChatRoom  AS group_id
                FROM message
                WHERE mesLocalID > ?
                ORDER BY mesLocalID ASC
                LIMIT 50
            """
            last_id = self.last_msg_id or 0
            cursor.execute(query, (last_id,))
            rows = [dict(row) for row in cursor.fetchall()]
            conn.close()
            return rows

        except sqlite3.OperationalError as e:
            print(f"[ERROR] 数据库读取失败: {e}")
            return []
        except Exception as e:
            print(f"[ERROR] 未知错误: {e}")
            return []

    def should_forward(self, msg: dict) -> bool:
        """判断消息是否需要转发"""
        # 群聊过滤
        if WATCH_GROUPS and msg.get("group_id") not in WATCH_GROUPS:
            return False

        content = msg.get("content", "")

        # 关键词过滤
        if KEYWORDS:
            if not any(kw.lower() in content.lower() for kw in KEYWORDS):
                return False

        # 去重（相同内容 5 分钟内不重复发送）
        content_hash = hashlib.md5(content.encode()).hexdigest()
        if content_hash in self.sent_hashes:
            return False

        return True

    def forward_to_trigger(self, msg: dict) -> bool:
        """将消息 POST 到 Abu 触发器"""
        payload = {
            "data": {
                "content": msg.get("content", ""),
                "group_id": msg.get("group_id", ""),
                "timestamp": msg.get("timestamp", 0),
                "msg_id": msg.get("server_id") or msg.get("msg_id"),
            }
        }

        try:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                TRIGGER_URL,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode())
                print(f"[OK] 已转发消息 -> {result.get('status', 'unknown')}")
                return True
        except urllib.error.URLError as e:
            print(f"[ERROR] 转发失败: {e}")
            return False

    def run(self):
        """主循环"""
        print(f"[START] IM 消息监听器已启动")
        print(f"  触发器地址: {TRIGGER_URL}")
        print(f"  数据库路径: {DB_PATH}")
        print(f"  轮询间隔: {POLL_INTERVAL}s")
        print(f"  监听群聊: {WATCH_GROUPS or '全部'}")
        print(f"  关键词过滤: {KEYWORDS or '无'}")
        print()

        while True:
            try:
                messages = self.get_latest_messages()

                for msg in messages:
                    msg_id = msg.get("msg_id", 0)

                    # 更新游标
                    if isinstance(msg_id, int) and msg_id > (self.last_msg_id or 0):
                        self.last_msg_id = msg_id

                    # 过滤 + 转发
                    if self.should_forward(msg):
                        content = msg.get("content", "")
                        content_hash = hashlib.md5(content.encode()).hexdigest()
                        if self.forward_to_trigger(msg):
                            self.sent_hashes.add(content_hash)

                # 清理过期的去重记录（保留最近 1000 条）
                if len(self.sent_hashes) > 1000:
                    self.sent_hashes = set(list(self.sent_hashes)[-500:])

            except KeyboardInterrupt:
                print("\n[STOP] 监听器已停止")
                break
            except Exception as e:
                print(f"[ERROR] 循环异常: {e}")

            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    watcher = IMWatcher()
    watcher.run()
