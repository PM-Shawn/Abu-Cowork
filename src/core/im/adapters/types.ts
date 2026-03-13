/**
 * IM Adapter Types — Unified message format and adapter interfaces
 *
 * All platforms convert to/from AbuMessage.
 * Upper layers never touch platform-specific formats.
 */

// ── Unified Message Format ──

export type MessageColor = 'success' | 'warning' | 'danger' | 'info';

/**
 * Abu unified message format.
 * All outbound messages are built from this format.
 * All inbound messages are normalized to this format.
 */
export interface AbuMessage {
  /** Markdown-formatted body text */
  content: string;
  /** Message title (supported by some platforms) */
  title?: string;
  /** Sidebar color / theme color */
  color?: MessageColor;
  /** Footer note */
  footer?: string;
  /** Platform-specific passthrough data */
  metadata?: Record<string, unknown>;
}

/**
 * Output context — used by OutputSender for template variable replacement
 */
export interface OutputContext {
  triggerName: string;
  eventSummary?: string;
  aiResponse: string;
  runTime?: string;
  timestamp: string;
  eventData?: string;
}

// ── Adapter Config ──

export interface AdapterConfig {
  /** Platform identifier */
  platform: string;
  /** Display name for UI */
  displayName: string;
  /** Max characters per message */
  maxLength: number;
  /** Chunking mode: 'length' for hard cut, 'newline' for paragraph-aware */
  chunkMode: 'length' | 'newline';
  /** Whether the platform natively supports Markdown */
  supportsMarkdown: boolean;
  /** Whether the platform supports card/interactive messages */
  supportsCard: boolean;
  /** Whether the platform supports updating sent messages (Phase 2 streaming reply) */
  supportsMessageUpdate?: boolean;
}

// ── Adapter Interfaces ──

/**
 * Outbound adapter — send messages to platform (Phase 1A)
 */
export interface OutboundAdapter {
  readonly config: AdapterConfig;

  /** Convert AbuMessage to platform-specific payload */
  formatOutbound(message: AbuMessage): unknown;

  /** Send a single HTTP request (base class provides default) */
  sendOutbound(webhookUrl: string, payload: unknown, headers?: Record<string, string>): Promise<void>;

  /** Send complete message with auto-chunking + per-chunk retry */
  sendMessage(webhookUrl: string, message: AbuMessage, headers?: Record<string, string>): Promise<void>;
}

/**
 * Inbound adapter — receive messages from platform (Phase 1B)
 */
export interface InboundAdapter {
  connect(credentials: AdapterCredentials): Promise<void>;
  onMessage(callback: (message: InboundMessage) => void): void;
  disconnect(): Promise<void>;
  getStatus(): AdapterStatus;
}

export type AdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface AdapterCredentials {
  appId: string;
  appSecret: string;
  [key: string]: unknown;
}

/**
 * Reply context for API-token-based direct replies (Phase 3A)
 */
export interface DirectReplyContext {
  /** Target chat/channel ID */
  chatId: string;
  /** Original message ID (for threading) */
  messageId?: string;
  /** Thread timestamp (Slack) */
  threadTs?: string;
}

/**
 * Complete adapter = Outbound + optional Inbound + optional Direct Reply
 */
export interface IMAdapter extends OutboundAdapter {
  inbound?: InboundAdapter;

  /**
   * Send a direct reply via platform API (requires access token).
   * Phase 3A: token-based replies for Feishu, Slack, WeCom, D-Chat.
   * Not all adapters implement this — check before calling.
   */
  replyToChat?(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }>;
}

// ── Inbound Message (Phase 1B) ──

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
  replyContext: ReplyContext;
  raw: unknown;
}

export interface ReplyContext {
  platform: string;
  // D-Chat
  vchannelId?: string;
  // Feishu
  chatId?: string;
  messageId?: string;
  // DingTalk
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  // Slack
  channelId?: string;
  threadTs?: string;
}
