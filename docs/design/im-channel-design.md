# IM 通道系统 — 产品与技术方案 v3.2

> Abu 触发器系统扩展：统一 IM 适配层 + 输出回推 + IM 消息接入
> 更新日期：2026-03-13
> v3.2: 代码级 review 修正（8 项），Phase 1A 已实现
> v3.3: 文档自检修正（9 项）— 路径同步、接口签名、代码块对齐实现
> v3.4: Phase 2 详细设计 — 话题窗口、能力等级、鉴权、流式回复、并发控制
> v3.5: Phase 2 产品设计 — 桌面端 UI、IM 端交互、状态指示器、4 项产品决策
> v3.6: Phase 2 全部实现 — UI 完成（设置页/侧边栏/状态条）+ 健壮性加固（超时/错误反馈/去重）+ 40 个测试文件 779 测试全通过
> v3.7: Phase 3 全部实现 — API Token 回复（飞书/Slack/企微/D-Chat）+ "继续上次"恢复 + IM 对话详情栏 + 排队提示 + 系统托盘 IM 状态 · 41 文件 792 测试全通过

## 一、背景与目标

### 业务场景

1. **告警闭环**：IM 群收到告警 → Abu 自动分析 → 结论回推到群
2. **远程指挥**：在 IM 群 @Abu → Abu 执行 → 结果推回群
3. **定时巡检**：Abu 定时检查 → 异常自动推到 IM 群通知
4. **文件审查**：代码/文档变更 → Abu 审查 → 审查意见推到 IM

### 产品定位

- 坚持桌面端，不做服务端平台（服务端模式待探索）
- 电脑在线时工作，连公司内网即可与 D-Chat 通信

### 分阶段目标

| 阶段 | 内容 | 说明 |
|------|------|------|
| **Phase 1A** | 统一适配层 + 输出回推 | 基础架构 + Webhook 推送 |
| **Phase 1B** | IM 作为触发源 | 在适配层上加 Inbound 能力 |
| **Phase 2** | IM 独立通道 | 多轮对话，有上下文 |

### 架构设计原则

参考业内主流实现（OpenClaw Provider 模式、LangBot 统一消息实体、cc-connect 平台隔离），确立：

1. **统一消息格式** — 核心逻辑只操作 AbuMessage，不碰平台差异
2. **Adapter 隔离** — 每个平台独立文件，互不影响
3. **收发分离** — Outbound（发）和 Inbound（收）是独立接口，可分阶段实现
4. **分段在基类** — 超长消息分段、重试、错误处理等通用逻辑放基类
5. **插件化扩展** — 新增平台只加一个 adapter 文件，不改核心代码

---

## 二、核心架构

### 2.1 整体分层

```
┌─────────────────────────────────────────────────────┐
│                   触发器引擎 / 对话系统               │
│                  (triggerEngine.ts)                  │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
         AbuMessage               AbuMessage
          (统一格式)               (统一格式)
               │                      │
┌──────────────▼──────────────────────▼────────────────┐
│              OutputSender / InboundRouter             │
│     (结果提取 + 变量替换 + 调度)  (消息规范化 + 路由)    │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
┌──────────────▼──────────────────────▼────────────────┐
│                  BaseAdapter (基类)                    │
│       HTTP发送 / 自动分段 / per-chunk重试 / 错误处理    │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
    ┌──────────▼──┐  ┌──────────▼──┐  ┌──────────┐
    │ DchatAdapter│  │FeishuAdapter│  │ SlackAdapter│ ...
    │  formatOut  │  │  formatOut  │  │  formatOut  │
    │  formatIn   │  │  formatIn   │  │  formatIn   │
    └─────────────┘  └─────────────┘  └────────────┘
```

**关键：中间有一个统一的 AbuMessage 格式，上层不感知平台差异，下层只做格式转换。**

### 2.2 统一消息格式 — AbuMessage

```typescript
// src/core/im/adapters/types.ts

/**
 * Abu 统一消息格式
 * 所有平台的消息都转换为此格式（Inbound）
 * 所有推送都从此格式转换为平台格式（Outbound）
 */
export interface AbuMessage {
  content: string;          // Markdown 格式的正文
  title?: string;           // 消息标题（部分平台支持）
  color?: MessageColor;     // 侧边色条/主题色
  footer?: string;          // 底部附注
  metadata?: Record<string, unknown>;  // 平台特定透传（Phase 1A 未使用，Phase 1B/2 预留）
}

export type MessageColor = 'success' | 'warning' | 'danger' | 'info';

/**
 * 输出上下文 — OutputSender 使用
 */
export interface OutputContext {
  triggerName: string;
  eventSummary?: string;
  aiResponse: string;        // 从对话中提取的 AI 回复
  runTime?: string;
  timestamp: string;
  eventData?: string;
}

/**
 * Inbound 规范化后的消息（Phase 1B 用）
 */
export interface InboundMessage {
  message: AbuMessage;
  sender: {
    id: string;
    name: string;
    platform: string;
  };
  chat: {
    id: string;
    name?: string;
    type: 'direct' | 'group';
  };
  replyContext: ReplyContext;   // 回复时需要的上下文
  raw: unknown;                // 原始平台消息（调试用）
}

/**
 * 回复上下文 — 各平台回复所需的信息
 */
export interface ReplyContext {
  platform: string;
  // D-Chat
  vchannelId?: string;
  // 飞书
  chatId?: string;
  messageId?: string;
  // 钉钉
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  // Slack
  channelId?: string;
  threadTs?: string;
}
```

### 2.3 Adapter 接口 — 收发分离

```typescript
// src/core/im/adapters/types.ts

/**
 * 平台配置
 */
export interface AdapterConfig {
  platform: string;            // 平台标识
  displayName: string;         // 显示名称（用于 UI）
  maxLength: number;           // 单条消息最大长度
  chunkMode: 'length' | 'newline';  // 分段模式
  supportsMarkdown: boolean;   // 是否原生支持 Markdown
  supportsCard: boolean;       // 是否支持卡片消息
}

/**
 * Outbound 接口 — 发送消息到平台（Phase 1A 实现）
 */
export interface OutboundAdapter {
  readonly config: AdapterConfig;

  // 将 AbuMessage 转换为平台 payload
  formatOutbound(message: AbuMessage): unknown;

  // 发送单条 HTTP 请求（由基类提供默认实现，子类可覆写）
  sendOutbound(webhookUrl: string, payload: unknown, headers?: Record<string, string>): Promise<void>;

  // 发送完整消息（含自动分段 + per-chunk 重试）
  sendMessage(webhookUrl: string, message: AbuMessage, headers?: Record<string, string>): Promise<void>;
}

/**
 * Inbound 接口 — 从平台接收消息（Phase 1B 实现）
 */
export interface InboundAdapter {
  // 建立连接（WebSocket / HTTP 回调注册）
  connect(credentials: AdapterCredentials): Promise<void>;

  // 注册消息回调
  onMessage(callback: (message: InboundMessage) => void): void;

  // 断开连接
  disconnect(): Promise<void>;

  // 连接状态
  getStatus(): AdapterStatus;
}

export type AdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface AdapterCredentials {
  appId: string;
  appSecret: string;
  [key: string]: unknown;  // 平台特定字段
}

/**
 * 完整 Adapter = Outbound + Inbound（可分阶段实现）
 */
export interface IMAdapter extends OutboundAdapter {
  // Phase 1B 时扩展 Inbound 能力
  inbound?: InboundAdapter;
}
```

### 2.4 BaseAdapter 基类 — 通用逻辑

```typescript
// src/core/im/adapters/base.ts

abstract class BaseAdapter implements IMAdapter {
  abstract readonly config: AdapterConfig;
  abstract formatOutbound(message: AbuMessage): unknown;

  /**
   * 发送单条 HTTP 请求（通用实现，子类可覆写）
   */
  async sendOutbound(webhookUrl: string, payload: unknown, headers?: Record<string, string>): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`[${this.config.platform}] HTTP ${response.status}: ${text}`);
    }
  }

  /**
   * 自动分段（超长消息拆分）
   */
  chunkContent(content: string): string[] {
    const max = this.config.maxLength;
    if (content.length <= max) return [content];

    if (this.config.chunkMode === 'newline') {
      return this.chunkByNewline(content, max);
    }
    return this.chunkByLength(content, max);
  }

  /**
   * 按段落分段 — 优先在换行处断开
   * 单行超长时 fallback 到 chunkByLength
   */
  private chunkByNewline(content: string, max: number): string[] {
    const chunks: string[] = [];
    let current = '';

    for (const line of content.split('\n')) {
      // 单行超长 → 按字符硬截断后逐段加入
      if (line.length > max) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        const subChunks = this.chunkByLength(line, max);
        chunks.push(...subChunks);
        continue;
      }

      if ((current + '\n' + line).length > max && current) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /**
   * 按字符数分段 — 硬截断
   */
  private chunkByLength(content: string, max: number): string[] {
    const chunks: string[] = [];
    const suffix = '\n\n...(续)';
    const effectiveMax = max - suffix.length;

    for (let i = 0; i < content.length; i += effectiveMax) {
      const chunk = content.slice(i, i + effectiveMax);
      const isLast = i + effectiveMax >= content.length;
      chunks.push(isLast ? chunk : chunk + suffix);
    }
    return chunks;
  }

  /**
   * 发送完整消息（含自动分段 + per-chunk 重试）
   * OutputSender 调用此方法
   */
  async sendMessage(webhookUrl: string, message: AbuMessage, headers?: Record<string, string>): Promise<void> {
    const chunks = this.chunkContent(message.content);

    for (let i = 0; i < chunks.length; i++) {
      const chunkMessage: AbuMessage = {
        ...message,
        content: chunks[i],
        title: i === 0 ? message.title : undefined,  // 标题只在第一段
      };
      const payload = this.formatOutbound(chunkMessage);

      // per-chunk 重试（3次，指数退避）
      let lastError: Error | undefined;
      const delays = [3000, 8000, 20000];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.sendOutbound(webhookUrl, payload, headers);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, delays[attempt]));
          }
        }
      }

      if (lastError) {
        throw new Error(
          `[${this.config.platform}] Chunk ${i + 1}/${chunks.length} failed after 3 retries: ${lastError.message}`
        );
      }

      // 多段之间间隔 500ms，避免平台限流
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
}
```

### 2.5 目录结构

```
src/core/
  ├── trigger/
  │   └── triggerEngine.ts           (已有，增加 pushOutput 方法)
  └── im/                           (新建 — IM 适配层，独立于 trigger，Phase 1B/2 复用)
      ├── outputSender.ts            (结果提取 + 变量替换 + 调度)
      └── adapters/
          ├── types.ts               (AbuMessage + OutputContext + Adapter 接口)
          ├── base.ts                (BaseAdapter 基类)
          ├── registry.ts            (Adapter 注册表，导出 IMAdapter 类型)
          ├── dchat.ts               (D-Chat)
          ├── feishu.ts              (飞书)
          ├── dingtalk.ts            (钉钉)
          ├── wecom.ts               (企业微信)
          ├── slack.ts               (Slack)
          └── custom.ts             (自定义 HTTP)
```

---

## 三、各平台 Adapter 实现

### 3.1 Adapter 注册表

```typescript
// src/core/im/adapters/registry.ts

import { DchatAdapter } from './dchat';
import { FeishuAdapter } from './feishu';
import { DingtalkAdapter } from './dingtalk';
import { WecomAdapter } from './wecom';
import { SlackAdapter } from './slack';
import { CustomAdapter } from './custom';

const adapters: Record<string, IMAdapter> = {
  dchat: new DchatAdapter(),
  feishu: new FeishuAdapter(),
  dingtalk: new DingtalkAdapter(),
  wecom: new WecomAdapter(),
  slack: new SlackAdapter(),
  custom: new CustomAdapter(),
};

export function getAdapter(platform: string): IMAdapter | undefined {
  return adapters[platform];
}

export function getAvailablePlatforms(): AdapterConfig[] {
  return Object.values(adapters).map(a => a.config);
}

// 动态注册（未来插件化扩展用）
export function registerAdapter(adapter: IMAdapter): void {
  adapters[adapter.config.platform] = adapter;
}
```

### 3.2 D-Chat Adapter

```typescript
// src/core/im/adapters/dchat.ts

export class DchatAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'dchat',
    displayName: 'D-Chat',
    maxLength: 20000,        // 附件消息最大 20000 字
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: true,      // 支持交互式消息
  };

  formatOutbound(message: AbuMessage): unknown {
    // 短消息用纯文本，长消息用附件格式
    if (message.content.length <= 3000 && !message.title) {
      return { text: message.content };
    }

    const colorMap: Record<MessageColor, string> = {
      success: '#36a64f',
      warning: '#ff9800',
      danger: '#e53935',
      info: '#2196f3',
    };

    return {
      text: message.title ?? '',
      attachments: [{
        title: message.title,
        text: message.content,
        color: message.color ? colorMap[message.color] : '#2196f3',
        ...(message.footer ? { footer: message.footer } : {}),
      }],
    };
  }
}
```

### 3.3 飞书 Adapter

```typescript
// src/core/im/adapters/feishu.ts

export class FeishuAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'feishu',
    displayName: '飞书',
    maxLength: 30000,
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: true,
  };

  formatOutbound(message: AbuMessage): unknown {
    const colorMap: Record<MessageColor, string> = {
      success: 'green', warning: 'orange', danger: 'red', info: 'blue',
    };

    return {
      msg_type: 'interactive',
      card: {
        header: message.title ? {
          title: { tag: 'plain_text', content: message.title },
          template: message.color ? colorMap[message.color] : 'blue',
        } : undefined,
        elements: [
          { tag: 'markdown', content: message.content },
          ...(message.footer ? [{
            tag: 'note',
            elements: [{ tag: 'plain_text', content: message.footer }],
          }] : []),
        ],
      },
    };
  }
}
```

### 3.4 钉钉 Adapter

```typescript
// src/core/im/adapters/dingtalk.ts

export class DingtalkAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'dingtalk',
    displayName: '钉钉',
    maxLength: 20000,
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: false,
  };

  formatOutbound(message: AbuMessage): unknown {
    const title = message.title ?? 'Abu AI';
    let text = message.title ? `### ${message.title}\n\n` : '';
    text += message.content;
    if (message.footer) text += `\n\n---\n${message.footer}`;

    return {
      msgtype: 'markdown',
      markdown: { title, text },
    };
  }
}
```

### 3.5 企业微信 Adapter

```typescript
// src/core/im/adapters/wecom.ts

export class WecomAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'wecom',
    displayName: '企业微信',
    maxLength: 4096,          // 字节限制
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: false,
  };

  formatOutbound(message: AbuMessage): unknown {
    let content = '';
    if (message.title) content += `### ${message.title}\n\n`;
    content += message.content;
    if (message.footer) content += `\n\n> ${message.footer}`;

    return {
      msgtype: 'markdown',
      markdown: { content },
    };
  }

  // 企微按字节计算，覆写分段逻辑
  chunkContent(content: string): string[] {
    const maxBytes = this.config.maxLength;
    const encoder = new TextEncoder();

    if (encoder.encode(content).length <= maxBytes) return [content];

    const chunks: string[] = [];
    let current = '';

    for (const line of content.split('\n')) {
      const candidate = current ? current + '\n' + line : line;

      // 单行超长 → 按字节硬截断
      if (encoder.encode(line).length > maxBytes) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        // 逐字符累加直到接近字节限制
        let segment = '';
        for (const char of line) {
          if (encoder.encode(segment + char).length > maxBytes - 20) {
            chunks.push(segment + '...');
            segment = char;
          } else {
            segment += char;
          }
        }
        if (segment) current = segment;
        continue;
      }

      if (encoder.encode(candidate).length > maxBytes && current) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
}
```

### 3.6 Slack Adapter

```typescript
// src/core/im/adapters/slack.ts

export class SlackAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'slack',
    displayName: 'Slack',
    maxLength: 3000,           // Block Kit section 限制，留余量
    chunkMode: 'newline',
    supportsMarkdown: false,   // Slack 用 mrkdwn，不是标准 Markdown
    supportsCard: true,
  };

  formatOutbound(message: AbuMessage): unknown {
    const blocks: unknown[] = [];

    if (message.title) {
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: message.title },
      });
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: this.toMrkdwn(message.content) },
    });

    if (message.footer) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: message.footer }],
      });
    }

    return { blocks };
  }

  /**
   * Markdown → Slack mrkdwn 转换
   *
   * 已知限制（Phase 1 不处理，后续按需补充）：
   * - 表格不支持，会原样输出
   * - 嵌套列表会被扁平化
   * - 图片语法不支持
   */
  private toMrkdwn(md: string): string {
    return md
      // 标题 → 粗体
      .replace(/^#{1,3} (.+)$/gm, '*$1*')
      // **粗体** → *粗体*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
      // ~~删除线~~ → ~删除线~
      .replace(/~~(.+?)~~/g, '~$1~')
      // - 列表 → • 列表
      .replace(/^- /gm, '• ')
      // > 引用保持不变（Slack 也用 >）
      ;
  }
}
```

### 3.7 自定义 HTTP Adapter

> **v3.2 修正**：自定义 headers 通过 `sendMessage(url, msg, headers)` 参数传递，不再通过 metadata 透传。
> BaseAdapter.sendOutbound 签名增加 `headers?: Record<string, string>` 参数。
> CustomAdapter 无需覆写 sendOutbound。

```typescript
// src/core/im/adapters/custom.ts

export class CustomAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'custom',
    displayName: '自定义 HTTP',
    maxLength: 100000,
    chunkMode: 'length',
    supportsMarkdown: true,
    supportsCard: false,
  };

  formatOutbound(message: AbuMessage): unknown {
    return {
      title: message.title,
      content: message.content,
      color: message.color,
      footer: message.footer,
      timestamp: new Date().toISOString(),
    };
  }
}

// OutputSender 调用时传入 headers：
// adapter.sendMessage(webhookUrl, message, output.customHeaders)
```

---

## 四、OutputSender — 输出回推核心

### 4.1 类型定义

```typescript
// src/types/trigger.ts — 新增

type OutputPlatform = 'dchat' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'custom';

type OutputExtractMode = 'last_message' | 'full' | 'custom_template';

interface TriggerOutput {
  enabled: boolean;
  // Phase 1A: 只支持 'webhook'
  // Phase 1B: 增加 'reply_source'
  target: 'webhook';
  platform: OutputPlatform;
  webhookUrl: string;
  extractMode: OutputExtractMode;
  customTemplate?: string;
  // 自定义 HTTP 场景：额外 headers（如 Authorization）
  customHeaders?: Record<string, string>;
}

// TriggerRun 扩展
interface TriggerRun {
  // ...已有字段
  outputStatus?: 'pending' | 'sent' | 'failed';
  outputError?: string;
  outputSentAt?: number;
}

// Trigger 扩展
interface Trigger {
  // ...已有字段
  output?: TriggerOutput;
}
```

### 4.2 OutputSender 实现

```typescript
// src/core/im/outputSender.ts

import { getAdapter } from './adapters/registry';
import type { AbuMessage, OutputContext } from './adapters/types';
import type { TriggerOutput, OutputExtractMode } from '@/types/trigger';

class OutputSender {

  /**
   * 从对话中提取 AI 回复的原始文本
   */
  extractAIResponse(conversationId: string, mode: OutputExtractMode): string {
    const conversation = useChatStore.getState().conversations[conversationId];
    const messages = conversation?.messages ?? [];

    switch (mode) {
      case 'last_message': {
        const lastAI = [...messages].reverse().find(m => m.role === 'assistant');
        return lastAI?.content ?? '(无结果)';
      }
      case 'full': {
        return messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => `**${m.role === 'user' ? '事件' : 'Abu'}**: ${m.content}`)
          .join('\n\n');
      }
      case 'custom_template': {
        // 模板模式下返回原始 AI 回复，模板替换在 buildMessage 中做
        const lastAI = [...messages].reverse().find(m => m.role === 'assistant');
        return lastAI?.content ?? '(无结果)';
      }
    }
  }

  /**
   * 构建 AbuMessage
   *
   * 流程：
   * 1. extractAIResponse → 拿到原始 AI 回复
   * 2. 填入 context.aiResponse
   * 3. 如果是模板模式 → 变量替换
   * 4. 组装 AbuMessage
   */
  buildMessage(
    conversationId: string,
    output: TriggerOutput,
    context: OutputContext,
  ): AbuMessage {
    // Step 1: 提取 AI 回复
    const aiResponse = this.extractAIResponse(conversationId, output.extractMode);
    context.aiResponse = aiResponse;

    // Step 2: 确定最终 content
    let content: string;
    if (output.extractMode === 'custom_template' && output.customTemplate) {
      content = this.replaceVariables(output.customTemplate, context);
    } else {
      content = aiResponse;
    }

    // Step 3: 组装
    return {
      content,
      title: context.triggerName,
      color: 'info',
      footer: `Abu AI · ${context.timestamp}`,
    };
  }

  /**
   * 发送结果到目标平台
   * 注意：重试逻辑在 BaseAdapter.sendMessage 的 per-chunk 级别，
   * 这里不再做整体重试，避免已发送的 chunk 被重复推送。
   */
  async send(
    output: TriggerOutput,
    message: AbuMessage,
  ): Promise<{ success: boolean; error?: string }> {
    if (!output.platform || !output.webhookUrl) {
      return { success: false, error: 'Missing platform or webhookUrl' };
    }

    const adapter = getAdapter(output.platform);
    if (!adapter) {
      return { success: false, error: `Unknown platform: ${output.platform}` };
    }

    try {
      // custom headers 通过 sendMessage 参数传递（非 metadata 透传）
      await adapter.sendMessage(output.webhookUrl, message, output.customHeaders);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 测试推送
   */
  async testSend(
    platform: OutputPlatform,
    webhookUrl: string,
    customHeaders?: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    const adapter = getAdapter(platform);
    if (!adapter) return { success: false, error: `Unknown platform: ${platform}` };

    const testMessage: AbuMessage = {
      content: 'Abu AI 连接测试成功',
      title: '测试消息',
      color: 'success',
      footer: `Abu AI · ${new Date().toLocaleString('zh-CN')}`,
    };

    try {
      await adapter.sendMessage(webhookUrl, testMessage, customHeaders);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 模板变量替换
   */
  private replaceVariables(template: string, ctx: OutputContext): string {
    return template
      .replace(/\$TRIGGER_NAME/g, ctx.triggerName ?? '')
      .replace(/\$EVENT_SUMMARY/g, ctx.eventSummary ?? '')
      .replace(/\$AI_RESPONSE/g, ctx.aiResponse ?? '')
      .replace(/\$RUN_TIME/g, ctx.runTime ?? '')
      .replace(/\$TIMESTAMP/g, ctx.timestamp ?? '')
      .replace(/\$EVENT_DATA/g, ctx.eventData ?? '');
  }
}

export const outputSender = new OutputSender();
```

### 4.3 模板变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `$TRIGGER_NAME` | 触发器名称 | "生产告警监控" |
| `$EVENT_SUMMARY` | 事件摘要 | "CPU 99% 告警" |
| `$EVENT_DATA` | 原始事件 JSON | `{"content":"..."}` |
| `$AI_RESPONSE` | AI 回复内容 | "分析结果：内存泄漏..." |
| `$RUN_TIME` | 处理耗时 | "12s" |
| `$TIMESTAMP` | 处理时间 | "2026-03-13 14:32" |

---

## 五、引擎集成

### 5.1 triggerEngine 增强

> **v3.2 修正**：`runAgentLoop` 已返回 `Promise<void>`，无需 `waitForAgentCompletion`。
> `executeAction` 签名保持 `(trigger, payload)`，`runId` 是内部变量。

```typescript
// triggerEngine.ts — executeAction 方法中，completeRun 之后新增 pushOutput 调用

// runAgentLoop returns Promise<void> — no polling needed
await runAgentLoop(conversationId, prompt, { ... });
useTriggerStore.getState().completeRun(trigger.id, runId);

// 输出回推（新增 ~15 行）
if (trigger.output?.enabled) {
  await this.pushOutput(trigger, runId, conversationId, payload);
}

// pushOutput 独立方法
private async pushOutput(trigger, runId, conversationId, payload) {
  useTriggerStore.getState().updateRunOutput(trigger.id, runId, 'pending');
  const context: OutputContext = { ... };
  const message = outputSender.buildMessage(conversationId, trigger.output, context);
  const { success, error } = await outputSender.send(trigger.output, message);
  useTriggerStore.getState().updateRunOutput(trigger.id, runId, success ? 'sent' : 'failed', error);
}
```

### 5.2 Store 更新

> **v3.2 修正**：persist version 升级为 2，增加 migrate 函数；onRehydrateStorage 重置 stuck 的 outputStatus。

```typescript
// triggerStore.ts 变更：
// 1. version: 1 → 2（migrate 函数处理 v1 数据，新字段均可选无需转换）
// 2. createTrigger / updateTrigger 参数增加 output?: TriggerOutput
// 3. 新增 updateRunOutput 方法
// 4. onRehydrateStorage 增加 outputStatus === 'pending' → 'failed' 重置
```

---

## 六、产品 UI

### 6.1 触发器编辑器 — 输出配置区域

```
━━━ 输出配置（可选）━━━━━━━━━━━━━━━━━━━━

☑ 处理完成后推送结果

推送平台：
  [D-Chat] [飞书] [钉钉] [企业微信] [Slack] [自定义HTTP]

Webhook URL：
  ┌──────────────────────────────────────────────┐
  │ https://xxx.xiaojukeji.com/webhook/xxx       │
  └──────────────────────────────────────────────┘
  [测试推送]  →  ✓ 推送成功 / ✗ 推送失败: 401 Unauthorized

自定义 Headers（仅"自定义HTTP"时显示）：
  ┌──────────────────────────────────────────────┐
  │ Authorization: Bearer sk-xxx                 │
  │ X-Custom-Key: value                          │
  └──────────────────────────────────────────────┘

结果提取：
  ● 最后一条 AI 回复
  ○ 完整对话记录
  ○ 自定义模板  →  展开模板编辑器

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 6.2 运行记录增强

```
运行记录：
  ● 3/13 14:32 - 告警分析   [已完成] [已推送 ✓]
  ● 3/13 14:28 - 告警分析   [已完成] [推送失败 ✗] [重试]
  ● 3/13 13:15 - 告警分析   [未匹配]
```

### 6.3 i18n 新增 Key

```
trigger.outputConfig           输出配置 / Output Config
trigger.enableOutput           处理完成后推送结果 / Push results after processing
trigger.outputPlatform         推送平台 / Platform
trigger.webhookUrl             Webhook URL
trigger.webhookUrlPlaceholder  https://... / https://...
trigger.customHeaders          自定义 Headers / Custom Headers
trigger.customHeadersPlaceholder  Authorization: Bearer sk-xxx
trigger.testPush               测试推送 / Test Push
trigger.testPushSuccess        推送成功 / Push succeeded
trigger.testPushFailed         推送失败 / Push failed
trigger.extractMode            结果提取 / Extract Mode
trigger.extractLastMessage     最后一条 AI 回复 / Last AI reply
trigger.extractFull            完整对话记录 / Full conversation
trigger.extractTemplate        自定义模板 / Custom template
trigger.templatePlaceholder    $TRIGGER_NAME 处理完成：$AI_RESPONSE
trigger.templateVariables      可用变量 / Available variables
trigger.outputSent             已推送 / Pushed
trigger.outputFailed           推送失败 / Push failed
trigger.outputRetry            重试推送 / Retry
```

---

## 七、Phase 1B：IM 作为触发源

> Phase 1A 完成后，在 Adapter 上加 Inbound 能力

### 7.1 在已有 Adapter 上扩展

```typescript
// 例：src/core/im/adapters/dchat.ts 增加 Inbound

export class DchatAdapter extends BaseAdapter {
  // ...Phase 1A 的 Outbound 实现保持不变

  // Phase 1B 新增
  inbound: InboundAdapter = {
    async connect(credentials) {
      // D-Chat: 注册 notification_url 到 Abu 已有的 HTTP 端口
      // Abu 启动时自动注册 http://<内网IP>:<端口>/dchat/notify
    },
    onMessage(callback) {
      // 在 trigger_server.rs 增加 /dchat/notify 路由
      // 收到 POST → 解析 → 构造 InboundMessage → callback
    },
    async disconnect() { /* 取消注册 */ },
    getStatus() { return 'connected'; },
  };
}
```

```typescript
// 例：src/core/im/adapters/feishu.ts 增加 Inbound

export class FeishuAdapter extends BaseAdapter {
  // ...Outbound 不变

  inbound: InboundAdapter = {
    async connect(credentials) {
      // 用 @larksuiteoapi/node-sdk 建立 WebSocket 长连接
      // EventDispatcher 注册 im.message.receive_v1
    },
    onMessage(callback) {
      // 消息事件 → 解析 → InboundMessage → callback
    },
    async disconnect() { /* 关闭 WebSocket */ },
    getStatus() { /* 返回连接状态 */ },
  };
}
```

### 7.2 TriggerSource 扩展

```typescript
type IMPlatform = 'dchat' | 'feishu' | 'dingtalk' | 'wecom' | 'slack';
type IMListenScope = 'all' | 'mention_only' | 'direct_only';

interface IMSource {
  type: 'im';
  platform: IMPlatform;
  appId: string;
  appSecret: string;
  listenScope: IMListenScope;
}

type TriggerSource = HttpSource | FileSource | CronSource | IMSource;
```

### 7.3 TriggerOutput 扩展

```typescript
// Phase 1B 时 TriggerOutput.target 增加 reply_source
interface TriggerOutput {
  enabled: boolean;
  target: 'webhook' | 'reply_source';  // ← Phase 1B 新增 reply_source
  platform?: OutputPlatform;      // target=webhook 时必填
  webhookUrl?: string;            // target=webhook 时必填
  extractMode: OutputExtractMode;
  customTemplate?: string;
  customHeaders?: Record<string, string>;
}
```

### 7.4 reply_source 回复到来源

```typescript
// OutputSender.send 增加 reply_source 分支

if (output.target === 'reply_source' && replyContext) {
  // 使用各平台的消息发送 API（非 Webhook，需 token）
  // D-Chat: POST /api/v1/message.send { vchannel_id, text }
  // 飞书: POST /open-apis/im/v1/messages/:message_id/reply
  // 钉钉: POST sessionWebhook { text/markdown }
  // Slack: chat.postMessage { channel, thread_ts }
}
```

---

## 八、Phase 2：IM 独立通道

> Phase 1 验证可行后启动，复用 Adapter 层。
> IM 通道让用户通过 IM 直接操作 Abu（类似 OpenClaw），支持多轮对话。

### 8.1 在线可用性策略

Abu 坚持桌面端定位，IM 通道在电脑在线时工作。

| 策略 | 说明 |
|------|------|
| **常驻托盘** | Abu 最小化到系统托盘常驻，只要电脑没关机就能响应 IM 消息 |
| **离线忽略** | Abu 离线时 Inbound 连接断开，离线期间的 @Abu 消息不处理、不排队。上线后从新消息开始响应 |

### 8.2 会话模型 — 话题窗口

IM 里的"对话"和 Abu 桌面端的"对话"是两个概念，需要映射。

**话题窗口模型：**
- @Abu 开启一个话题窗口
- 30 分钟无交互自动结束，下次 @Abu 新建
- 支持 thread 的平台（Slack、飞书）优先使用 thread 粒度：同一个回复链 = 同一个 Abu 会话
- 不支持 thread 的平台（钉钉、D-Chat、企微）使用时间窗口

```typescript
// src/core/im/session.ts

interface IMSession {
  /** 映射 key: "platform:chatId:threadId" 或 "platform:chatId:window" */
  key: string;
  conversationId: string;
  lastActiveAt: number;
  messageCount: number;
  /** 来源用户 */
  userId: string;
  /** 能力等级（由 AuthGate 判定） */
  capability: IMCapabilityLevel;
}

interface SessionMapperConfig {
  /** 话题窗口超时（毫秒），默认 30 分钟 */
  windowTimeoutMs: number;
  /** 单会话最大轮次，超过自动新建，默认 50 */
  maxRoundsPerSession: number;
}

class SessionMapper {
  private sessions = new Map<string, IMSession>();

  /**
   * 查找或创建会话
   *
   * 规则：
   * 1. 有 thread → key = "platform:chatId:threadId"
   * 2. 无 thread → key = "platform:chatId:window"
   * 3. 超时（30 min 无交互）→ 新建会话
   * 4. 超过 maxRounds → 新建会话
   */
  resolveSession(message: InboundMessage): IMSession { ... }

  /** 定时清理过期会话 */
  cleanup(): void { ... }
}
```

### 8.3 能力等级 — 可配置

IM 通道的 Abu 能做什么，由用户在 IMChannelConfig 中配置：

```typescript
type IMCapabilityLevel = 'chat_only' | 'read_tools' | 'safe_tools' | 'full';

interface IMChannelConfig {
  /** 能力等级 */
  capability: IMCapabilityLevel;
  /** 允许操作的用户白名单（IM user ID），空数组 = 所有人 */
  allowedUsers: string[];
  /** 允许的 workspace 路径（限制操作范围） */
  workspacePaths: string[];
  /** 话题窗口超时（分钟） */
  sessionTimeoutMinutes: number;
}
```

| 等级 | 说明 | 允许的操作 | 场景 |
|------|------|-----------|------|
| `chat_only` | 纯聊天 | 无工具，只做问答分析 | 开放群，任何人可问 |
| `read_tools` | 只读 | 读文件、搜索代码、查日志 | 团队内部查询 |
| `safe_tools` | 安全工具 | 读 + 触发器同级（autoDeny 危险操作） | 日常运维 |
| `full` | 完整 | 和桌面端一样 | 个人私聊 / 受信用户 |

默认 `safe_tools`。`full` 等级要求配置用户白名单，防止群里任何人触发危险操作。

**实现复用已有权限机制：**

```typescript
function getCallbacksForLevel(level: IMCapabilityLevel) {
  switch (level) {
    case 'chat_only':
      return {
        disableTools: true,
        commandConfirmCallback: async () => false,
        filePermissionCallback: async () => false,
      };
    case 'read_tools':
      return {
        commandConfirmCallback: async () => false,
        filePermissionCallback: async (req) => req.capability === 'read',
      };
    case 'safe_tools':
      // 和触发器共用同一套权限模型
      return {
        commandConfirmCallback: autoDenyConfirmation,
        filePermissionCallback: autoFilePermission,
      };
    case 'full':
      return {
        commandConfirmCallback: async () => true,
        filePermissionCallback: async () => true,
      };
  }
}
```

### 8.4 用户鉴权 — AuthGate

```typescript
// src/core/im/authGate.ts

class AuthGate {
  /**
   * 判定用户的能力等级
   *
   * 规则：
   * 1. config.capability == 'full' 且用户不在白名单 → 降级到 safe_tools
   * 2. config.allowedUsers 非空且用户不在列表中 → 拒绝
   * 3. 否则 → 使用 config.capability
   */
  resolveCapability(
    userId: string,
    config: IMChannelConfig,
  ): IMCapabilityLevel | 'denied' { ... }
}
```

### 8.5 流式回复策略

各平台对消息更新的支持差异大，AdapterConfig 增加字段标识：

```typescript
interface AdapterConfig {
  // ...已有字段
  /** 是否支持更新已发送的消息（Phase 2 流式回复用） */
  supportsMessageUpdate: boolean;
}
```

| 平台 | supportsMessageUpdate | 回复策略 |
|------|----------------------|----------|
| 飞书 | true（卡片 PATCH） | 流式更新卡片内容，完成后定稿 |
| Slack | true（chat.update） | 流式更新消息，完成后定稿 |
| 钉钉 | false | 先发"正在分析..."，完成后发完整回复 |
| D-Chat | false（待确认） | 同钉钉策略兜底 |
| 企业微信 | false | 同钉钉策略 |

```typescript
// src/core/im/streamingReply.ts

interface StreamingReply {
  /** 发送"思考中"占位消息，返回消息 ID（可更新平台）或 void */
  sendThinking(adapter: IMAdapter, context: ReplyContext): Promise<string | void>;

  /** 流式更新内容（仅 supportsMessageUpdate 平台） */
  updateContent(adapter: IMAdapter, messageId: string, content: string): Promise<void>;

  /** 发送最终结果（不可更新平台直接发新消息） */
  sendFinal(adapter: IMAdapter, context: ReplyContext, message: AbuMessage): Promise<void>;
}
```

### 8.6 并发控制

多人同时 @Abu 时并行处理，复用触发器引擎的并发控制机制：

- 每个 @Abu 独立创建会话，并行执行
- 全局并发上限（复用 `MAX_CONCURRENT_TRIGGERS`）
- 超过上限时排队，回复"Abu 正在处理其他请求，请稍候"

### 8.7 整体架构

```
                    IM 消息进来
                        │
              ┌─────────▼──────────┐
              │   InboundRouter     │  ← Phase 1B 已有
              │   (消息规范化)       │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │   AuthGate          │  ← Phase 2 新增
              │   (用户鉴权 + 能力判定) │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │   SessionMapper     │  ← Phase 2 新增
              │   (thread/窗口 → 会话) │
              │   (30min 超时, 50轮上限) │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │   runAgentLoop      │  ← 已有，按能力等级注入回调
              │   + 并发控制         │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │   StreamingReply    │  ← Phase 2 新增
              │   (流式/批量回复)    │
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │   Adapter.send      │  ← Phase 1A 已有
              └────────────────────┘
```

### 8.8 与 Phase 1 的关系

| 模块 | Phase 1A | Phase 1B | Phase 2 增量 |
|------|----------|----------|-------------|
| Adapter 层 | ✓ Outbound | + Inbound | 复用，AdapterConfig 加 supportsMessageUpdate |
| OutputSender | ✓ 结果推送 | — | 复用 |
| InboundRouter | — | ✓ 消息接收 | 复用 |
| AuthGate | — | — | **新增** |
| SessionMapper | — | — | **新增** |
| StreamingReply | — | — | **新增** |
| IMChannelConfig | — | — | **新增**（UI: 通道配置面板） |
| 权限回调 | — | — | 复用 autoDeny + autoFilePermission |

Phase 2 核心新增 4 个模块，其余全部复用 Phase 1 基础设施。

### 8.9 产品 UI — 桌面端

#### 通道配置入口

设置页新增"IM 通道"区域（低频配置操作），IM 对话混排在侧边栏对话列表中（用平台 icon 区分来源）。

```
━━━ 设置 > IM 通道 ━━━━━━━━━━━━━━━━━━━━━━━━━

状态概览：
  飞书   ● 已连接    3 个活跃会话
  D-Chat ○ 未配置
  Slack  ○ 未配置

[+ 添加通道]

┌─────────────────────────────────────────┐
│  飞书                       [编辑] [断开] │
│                                         │
│  连接状态：● 已连接（3分钟前重连）          │
│  App ID：cli_xxxx****                   │
│  活跃会话：3 个                           │
│  今日消息：27 条                          │
│                                         │
│  能力等级：                               │
│  ┌─────────────────────────────────┐    │
│  │ ○ 纯聊天 — 仅问答，不使用工具      │    │
│  │ ○ 只读 — 可读文件/搜索，不可修改    │    │
│  │ ● 安全工具 — 自动拒绝危险操作      │    │
│  │ ○ 完整 — 和桌面端一样（需白名单）   │    │
│  └─────────────────────────────────┘    │
│                                         │
│  用户白名单：                             │
│  ┌─────────────────────────────────┐    │
│  │ 空 = 所有人可用                    │    │
│  │ ou_zhangsan (张三)        [×]    │    │
│  │ ou_lisi (李四)            [×]    │    │
│  │ [+ 添加用户]                      │    │
│  └─────────────────────────────────┘    │
│                                         │
│  工作目录：                               │
│  ┌─────────────────────────────────┐    │
│  │ /Users/didi/projects/app   [×]  │    │
│  │ [+ 添加目录]                      │    │
│  └─────────────────────────────────┘    │
│                                         │
│  会话超时：[30] 分钟                      │
│                                         │
└─────────────────────────────────────────┘
```

#### 添加通道流程

```
Step 1 — 选择平台
  [D-Chat] [飞书] [钉钉] [企业微信] [Slack]

Step 2 — 填写凭证
  App ID:     [________________]
  App Secret: [________________]
  📖 如何获取？→ 各平台机器人创建文档

Step 3 — 测试连接
  [测试连接]  →  ✓ 连接成功 / ✗ 失败: Invalid credentials

Step 4 — 配置能力（可后续在设置页修改）
  能力等级 / 白名单 / 工作目录 / 会话超时
  [完成]
```

#### 侧边栏对话列表 — IM 对话混排

IM 对话和普通对话混排在同一个列表，用平台 icon + 来源标签区分：

```
侧边栏：
  今天
    💬 重构登录模块                    14:32
    🔷 张三 · 飞书群                   14:28    ← 飞书 icon
    💬 API 设计讨论                    13:15
    🟡 李四 · D-Chat                  12:40    ← D-Chat icon

  触发器
    ⚡ 生产告警监控
```

#### IM 对话详情页

点进 IM 对话后，顶部多一行通道信息栏：

```
┌─────────────────────────────────────────────┐
│  🔷 张三 · 飞书 · 技术群                       │
│  能力: safe_tools │ 14:28 开始 │ 5 轮对话      │
│  [结束会话]                                   │
├─────────────────────────────────────────────┤
│                                              │
│  [事件] 张三: @Abu 帮我看下 order-service      │
│         的日志有没有报错                        │
│                                              │
│  [Abu]  找到 3 条 ERROR：                     │
│         1. NullPointerException at ...        │
│         ...                                  │
│                                              │
│  [事件] 张三: 第一个能定位到哪行代码吗？          │
│                                              │
│  [Abu]  OrderService.java:142 行...           │
│                                              │
└─────────────────────────────────────────────┘
```

### 8.10 产品 UI — IM 端交互

#### 首次交互

```
群聊：
  张三: @Abu 帮我分析下这个告警

  Abu: 收到，正在分析...
       （支持消息更新的平台会流式更新这条消息）

  Abu: 分析完成。
       CPU 使用率 99% 持续 5 分钟，定位到 order-service GC 频率异常...
       建议：1. 排查最近发布  2. 临时扩容
       ── Abu AI · 2026-03-13 14:32
```

#### 多轮追问（话题窗口内，有上下文）

```
  张三: @Abu 能查下 order-service 最近的发布记录吗？

  Abu: 最近 3 次发布：
       - 3/13 10:00  fix: 修复订单查询缓存
       - 3/12 16:00  feat: 新增批量导出功能  ← 可疑
       - 3/11 14:00  chore: 依赖更新
       3/12 的"批量导出"改动较大，建议重点排查。
```

#### 话题超时后

```
  （30 分钟无交互后...）

  张三: @Abu 刚才的问题解决了吗？

  Abu: 上一个话题（CPU 告警分析）已结束。
       回复"继续上次"可恢复上下文，
       或直接描述新的问题。

  张三: 继续上次

  Abu: 已恢复上次对话上下文（CPU 告警 → order-service → 3/12 发布）。
       请继续。
```

#### 能力不足提示

```
  李四: @Abu 把 config.ts 的超时改成 30 秒

  Abu: ⚠️ 当前通道能力等级为"安全工具"，无法修改文件。
       请在 Abu 桌面端操作，或联系管理员调整权限。
```

#### Abu 离线

```
  张三: @Abu 帮我查下日志

  （无回复 — Abu 离线时 Inbound 连接已断开，消息不会送达）
  （Abu 上线后不追溯处理离线消息，从新消息开始响应）
```

#### 并发排队

```
  李四: @Abu 帮我查下发布记录

  Abu: 收到！当前有 3 个请求正在处理，你的请求已排队，
       预计等待约 1 分钟。
```

#### 私聊 vs 群聊

| 场景 | 行为 |
|------|------|
| **私聊** | 直接对话，无需 @Abu 前缀。能力等级按通道配置 |
| **群聊 @Abu** | 需要 @Abu 才触发。按通道配置的能力等级 |
| **群聊不 @Abu** | 忽略，不响应 |

### 8.11 状态指示器

#### 系统托盘菜单

```
   🟢  Abu AI
  ┌──────────────────────────┐
  │  IM 通道                  │
  │    飞书   ● 已连接  3 会话 │
  │    D-Chat ● 已连接  1 会话 │
  │                          │
  │  触发器  ⚡ 3 个活跃       │
  │                          │
  │  [打开 Abu]  [退出]       │
  └──────────────────────────┘
```

#### 侧边栏底部状态条

```
  ─────────────────────────
  ● 飞书 · ● D-Chat    ⚡ 3
  ─────────────────────────
```

### 8.12 产品决策记录

| 决策项 | 结论 | 理由 |
|--------|------|------|
| IM 对话位置 | 混排在对话列表，平台 icon 区分 | 对话统一管理，用户关心的是"所有和 Abu 的对话"不关心来源 |
| 话题超时后恢复 | 支持"继续上次"恢复上下文 | 更友好，避免用户重复描述 |
| 私聊能力等级 | 按通道配置，不特殊对待 | 统一规则，简化心智模型 |
| 离线消息 | 不处理，上线后从新消息开始 | 简化实现，避免过期消息被执行的风险 |

---

## 九、实现计划

### Phase 1A（6步）— 已完成 ✓

| 步骤 | 内容 | 状态 |
|------|------|------|
| **Step 1** | `adapters/types.ts` — AbuMessage + OutputContext + Adapter 接口 | ✓ 完成 |
| **Step 2** | `adapters/base.ts` — BaseAdapter 基类（HTTP发送 / 分段 / per-chunk重试） | ✓ 完成 |
| **Step 3** | 6个 Adapter 实现（dchat/feishu/dingtalk/wecom/slack/custom） | ✓ 完成 |
| **Step 4** | `outputSender.ts` — 结果提取 + 变量替换 + 消息构建 + 调度 | ✓ 完成 |
| **Step 5** | 引擎集成 — pushOutput 回推流程 + Store 更新（version 1→2） | ✓ 完成 |
| **Step 6** | 编辑器 UI — 输出配置区域 + 测试推送 + 模板编辑器 + i18n | ✓ 完成 |

### Phase 1B（IM 作为触发源）— 已完成 ✓

> **实现说明**：Tauri 是浏览器环境，不支持 Node.js SDK。所有平台统一走 HTTP 回调方式，
> IM 平台将消息 POST 到 Abu trigger_server 的 `/im/{platform}/webhook` 路由。

| 步骤 | 内容 | 状态 |
|------|------|------|
| **Step 1** | `IMSource` / `IMPlatform` / `IMListenScope` / `IMReplyContext` 类型定义 | ✓ 完成 |
| **Step 2** | trigger_server.rs — `/im/{platform}/webhook` 路由 + 飞书/Slack URL verification | ✓ 完成 |
| **Step 3** | `InboundRouter` — 5 平台 payload 解析 → NormalizedIMMessage（含 14 个单测） | ✓ 完成 |
| **Step 4** | TriggerEngine 集成 — IM 事件监听 + imTriggersMap + scope 过滤 + 分发 | ✓ 完成 |
| **Step 5** | `reply_source` — OutputSender 回复到来源（钉钉 sessionWebhook 已支持，其他平台需 Phase 2 API auth） | ✓ 完成 |
| **Step 6** | 编辑器 UI — IM 来源配置（平台/凭证/监听范围/回调地址）+ 输出目标切换 | ✓ 完成 |
| **Step 7** | `TriggerOutput.target` 扩展为 `'webhook' \| 'reply_source'`，platform/webhookUrl 改为可选 | ✓ 完成 |
| **Step 8** | i18n — 16 个 IM 相关翻译 key（中/英） | ✓ 完成 |

### Phase 2（IM 独立通道）

| 步骤 | 内容 | 状态 |
|------|------|------|
| **Step 1** | `IMChannel` 类型 + `imChannelStore`（persist + immer） + 配置持久化 | ✓ 完成 |
| **Step 2** | `AuthGate` — 用户鉴权 + 4 级能力判定 + 白名单降级逻辑（含 6 个单测） | ✓ 完成 |
| **Step 3** | `SessionMapper` — 话题窗口 + thread/window 映射 + 超时清理 + "继续上次"恢复（含 6 个单测） | ✓ 完成 |
| **Step 4** | `StreamingReply` — sendThinking + sendFinal + AdapterConfig.supportsMessageUpdate | ✓ 完成 |
| **Step 5** | `IMChannelRouter` — 核心集成（消息路由 → AuthGate → SessionMapper → agentLoop → Reply + 并发控制） | ✓ 完成 |
| **Step 6** | 并发控制（MAX_CONCURRENT_IM=5）+ 消息排队 | ✓ 完成 |
| **Step 7** | 设置页 — 通道配置面板（添加/编辑/断开 + 能力等级 + 白名单 + 工作目录） | ✓ 完成 |
| **Step 8** | 侧边栏 — IM 对话混排（平台 icon + 来源标签）+ 对话详情信息栏 | ✓ 完成 |
| **Step 9** | 侧边栏底部 IM 状态条 + App.tsx 集成 imChannelRouter | ✓ 完成 |

### Phase 3（IM 通道增强）— 已完成 ✓

| 步骤 | 内容 | 状态 |
|------|------|------|
| **Step A** | API Token 回复 — tokenManager（缓存+刷新）+ 4 平台 replyToChat 实现 + streamingReply 升级 | ✓ 完成 |
| **Step B** | "继续上次"恢复 — 超时提示 + 恢复确认 + 上下文摘要 + sessionMapper 增强 | ✓ 完成 |
| **Step C** | IM 对话详情栏 — IMInfoBar 组件（平台/用户/能力/时间/轮次/结束会话）+ ChatView 集成 | ✓ 完成 |
| **Step D** | 排队提示 — 并发超限时发送排队位置通知 | ✓ 完成 |
| **Step E** | 系统托盘 IM 状态 — Rust update_tray_menu 命令 + traySync 前端订阅 + 动态菜单更新 | ✓ 完成 |

---

## 十、技术风险与决策

| 项目 | 风险 | 决策 |
|------|------|------|
| agent 完成检测 | ~~当前无完成回调~~ | `runAgentLoop` 返回 `Promise<void>`，直接 await 即可（v3.2 修正） |
| 企微消息超长 | 4096 字节限制 | WecomAdapter 覆写 chunkContent，按字节计算 |
| Slack Markdown | mrkdwn ≠ Markdown | SlackAdapter 内置转换，已知限制（表格/嵌套列表）标注 |
| 自定义 Headers | custom adapter 需要额外 headers | TriggerOutput.customHeaders + sendMessage 参数传递（v3.2 修正，不再 metadata 透传） |
| 凭证存储 | Phase 1A 不涉及（只用 URL） | Phase 1B 用 Tauri stronghold |
| D-Chat 内网 IP 变化 | notification_url 需更新 | Abu 启动时自动注册当前 IP |
| WebSocket 断线 | 长连接不稳定 | 指数退避重连（1s/2s/4s/.../5min） |
| 重复推送 | 整体重试会重发已成功的 chunk | 重试在 per-chunk 级别，OutputSender 不做整体重试 |
| reply_source 误用 | Phase 1A 没有 Inbound 能力 | Phase 1A TriggerOutput.target 只允许 'webhook' |
| 新增平台 | 需要改核心代码？ | 不需要，加 adapter 文件 + registry 注册即可 |
| IM 操作安全 | 群里任何人可触发危险操作 | 4 级能力配置 + 用户白名单，`full` 等级必须配白名单 |
| 会话上下文膨胀 | 长时间对话 token 爆炸 | 话题窗口 30min 超时 + 50 轮上限，超过自动新建 |
| 离线体验 | 电脑关机后 IM 无响应 | 常驻托盘减少离线时间；离线时连接断开，不回复、不排队 |
| 多人并发 | 群里多人同时 @Abu | 并行处理 + 全局并发上限，超限排队提示 |
| 流式回复兼容 | 部分平台不支持消息更新 | AdapterConfig.supportsMessageUpdate 标识，不支持的平台用"思考中→完整回复"模式 |
| agentLoop 超时 | Agent 卡死会永久占用并发槽位 | 3 分钟超时保护（AGENT_TIMEOUT_MS），超时自动释放（v3.6 加固） |
| 直接回复限制 | 仅 DingTalk sessionWebhook 可直接回复 | 其他平台降级为日志记录，回复存在 Abu 会话中。完整回复需 Phase 3 API token 管理 |
| 消息去重 | Webhook 重试可能创建重复会话 | 基于 platform:chatId:senderId:text 的内存去重，每 5 分钟清理（v3.6 加固） |
| 错误反馈 | processMessage 出错时用户不知道 | 错误写入 channel.lastError（UI 可见）+ best-effort 错误消息回复（v3.6 加固） |
| API Token 过期 | Token 过期后回复失败 | tokenManager 自动缓存 + 提前 10 分钟刷新 + 401 时自动 invalidate 并重新获取（v3.7） |
| D-Chat API 端点 | 内部平台 API 地址可能变化 | tokenManager/dchat.ts 使用占位 URL，需按实际部署调整（v3.7） |
| 托盘菜单更新频率 | store 变化频繁可能导致菜单闪烁 | traySync 使用 500ms debounce，避免频繁 IPC 调用（v3.7） |

---

## 十一、扩展新平台示例

未来要加 Telegram，只需一个文件：

```typescript
// src/core/im/adapters/telegram.ts

export class TelegramAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'telegram',
    displayName: 'Telegram',
    maxLength: 4096,
    chunkMode: 'newline',
    supportsMarkdown: true,
    supportsCard: false,
    supportsMessageUpdate: true,
  };

  formatOutbound(message: AbuMessage): unknown {
    let text = '';
    if (message.title) text += `<b>${message.title}</b>\n\n`;
    text += message.content;
    if (message.footer) text += `\n\n<i>${message.footer}</i>`;

    return { text, parse_mode: 'HTML' };
  }
}

// registry.ts 加一行：
// telegram: new TelegramAdapter(),
```

**新增一个平台 = 一个文件 + 注册一行。核心代码零修改。**
