/**
 * WeChat iLink Adapter
 *
 * Integrates with the WeChat iLink Bot API (ClawBot) for private chat messaging.
 * Auth: QR-code scan → bot_token (no OAuth exchange, persists until -14 session expiry).
 * Inbound: long-polling via POST /ilink/bot/getupdates (35s server hold).
 * Outbound: POST /ilink/bot/sendmessage using per-user context_token.
 * Media: AES-128-ECB encrypted CDN download → local temp file.
 *
 * Group chat: not supported by iLink for personal accounts (messages not delivered).
 */

import * as aesjs from 'aes-js';
import { getTauriFetch } from '../../llm/tauriFetch';
import { writeFile } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import { BaseAdapter } from './base';
import type {
  AdapterConfig,
  AbuMessage,
  DirectReplyContext,
  InboundAdapter,
  AdapterCredentials,
  AdapterStatus,
  InboundMessage,
  ReplyContext,
} from './types';

// ── Public credential shape (stored in channel.appSecret as JSON) ──

export interface WeChatCredentials {
  botToken: string;
  baseurl: string;
  ilinkBotId: string;
}

// ── iLink wire types ──

interface ILinkMessage {
  message_id: number;
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  create_time_ms: number;
  message_type: 1 | 2; // 1 = user sent, 2 = bot sent
  message_state: 0 | 1 | 2;
  context_token: string;
  group_id?: string;
  item_list: ILinkItem[];
}

type ILinkItem =
  | { type: 1; text_item: { text: string } }
  | { type: 2; image_item: CDNMedia & { mid_size?: CDNMedia; thumb_size?: CDNMedia } }
  | { type: 3; voice_item: CDNMedia & { encode_type: string; text?: string; playtime: number } }
  | { type: 4; file_item: CDNMedia & { file_name: string; md5: string; len: number } }
  | { type: 5; video_item: CDNMedia & { video_size: number; play_length: number; thumb_media: CDNMedia } };

interface CDNMedia {
  encrypt_query_param: string;
  aes_key: string; // base64-encoded 16-byte key
  encrypt_type: 1;
}

// ── QR login types ──

export interface WeChatQRCode {
  qrcode: string; // session token for polling get_qrcode_status
  qrcode_img_content: string; // payload URL to encode into a QR code (NOT an image)
}

export type WeChatQRStatus =
  | { status: 'wait' }
  | { status: 'scanned' }
  | { status: 'confirmed'; credentials: WeChatCredentials }
  | { status: 'expired' };

// ── Helpers ──

// Encoded client version: major<<16 | minor<<8 | patch (matches official plugin 2.4.3 = 132099)
const ILINK_CLIENT_VERSION = '132099';

// base_info is observability-only (not used for auth/routing) but every request carries it.
const ILINK_BASE_INFO = { channel_version: '2.4.3', bot_agent: 'Abu' } as const;

// context_token cache shared between the inbound polling adapter (writes on each
// received message) and the registry adapter's replyToChat (reads to route replies).
// Keyed by from_user_id (globally unique `xxx@im.wechat`). Module-level so both the
// manager-created adapter instances and the registry adapter see the same tokens.
const sharedContextTokens = new Map<string, string>();
const CTX_STORAGE_KEY = 'wechat:ctx';

function persistSharedContextTokens(): void {
  try {
    localStorage.setItem(CTX_STORAGE_KEY, JSON.stringify([...sharedContextTokens.entries()]));
  } catch {
    // best-effort persistence
  }
}

function restoreSharedContextTokens(): void {
  if (sharedContextTokens.size > 0) return;
  try {
    const saved = localStorage.getItem(CTX_STORAGE_KEY);
    if (saved) {
      for (const [k, v] of JSON.parse(saved) as Array<[string, string]>) {
        sharedContextTokens.set(k, v);
      }
    }
  } catch {
    // ignore corrupt cache
  }
}

function makeILinkHeaders(token?: string): Record<string, string> {
  const uin = btoa(String(Math.floor(Math.random() * 0xffffffff)));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function aes128EcbDecrypt(data: Uint8Array, keyBase64: string): Uint8Array {
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  // aes-js v3 ECB mode; operates on raw blocks (no built-in padding removal)
  const aesEcb = new aesjs.ModeOfOperation.ecb(keyBytes);
  const decrypted = aesEcb.decrypt(data);
  // Remove PKCS7 padding from the last block
  const paddingLen = decrypted[decrypted.length - 1];
  if (paddingLen < 1 || paddingLen > 16) return decrypted; // malformed padding: return as-is
  return decrypted.slice(0, decrypted.length - paddingLen);
}

async function downloadAndDecryptMedia(
  encryptQueryParam: string,
  aesKeyB64: string,
  fileName?: string,
): Promise<string> {
  const cdnUrl = `https://novac2c.cdn.weixin.qq.com/c2c${encryptQueryParam}`;
  const f = await getTauriFetch();
  const resp = await f(cdnUrl);
  if (!resp.ok) throw new Error(`CDN download failed: HTTP ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const decrypted = aes128EcbDecrypt(new Uint8Array(buf), aesKeyB64);

  const ext = fileName?.split('.').pop() ?? 'bin';
  const name = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const tmp = await tempDir();
  const path = `${tmp}/${name}`;
  await writeFile(path, decrypted);
  return path;
}

function clientId(): string {
  return `abu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Build an iLink endpoint URL. The server returns baseurl WITH a scheme
// (e.g. "https://ilinkai.weixin.qq.com") so we strip any scheme before
// re-prefixing — otherwise we get "https://https://..." and the request fails.
function ilinkUrl(baseurl: string, path: string): string {
  const host = baseurl.replace(/^https?:\/\//, '');
  return `https://${host}${path}`;
}

// ── QR Login ──

const ILINK_BASE = 'ilinkai.weixin.qq.com';

export async function getWeChatQRCode(): Promise<WeChatQRCode> {
  const f = await getTauriFetch();
  // Must be POST with body { local_token_list: [] } — a GET or empty body makes the
  // server fall back to a generic landing page instead of a bot-binding QR.
  const resp = await f(`https://${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: 'POST',
    headers: makeILinkHeaders(),
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (!resp.ok) throw new Error(`get_bot_qrcode HTTP ${resp.status}`);
  const data = (await resp.json()) as WeChatQRCode & { ret?: number };
  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`get_bot_qrcode ret=${data.ret}`);
  }

  // qrcode_img_content is NOT an image — it's the payload (a liteapp.weixin.qq.com
  // deep-link URL) that must be encoded into a QR code by the caller. The user
  // scans that generated QR code with WeChat.
  return { qrcode: data.qrcode, qrcode_img_content: data.qrcode_img_content };
}

export async function pollWeChatQRStatus(qrcode: string): Promise<WeChatQRStatus> {
  const f = await getTauriFetch();
  const resp = await f(
    `https://${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { headers: makeILinkHeaders() },
  );
  if (!resp.ok) throw new Error(`get_qrcode_status HTTP ${resp.status}`);

  const data = (await resp.json()) as {
    status: string;
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    ret?: number;
  };

  // Note: server spells it "scaned" (one n). "binded_redirect" = already bound on
  // this machine, also carries valid creds → treat as success.
  if ((data.status === 'confirmed' || data.status === 'binded_redirect') && data.bot_token) {
    return {
      status: 'confirmed',
      credentials: {
        botToken: data.bot_token,
        baseurl: data.baseurl ?? ILINK_BASE,
        ilinkBotId: data.ilink_bot_id ?? '',
      },
    };
  }
  if (data.status === 'expired' || data.status === 'verify_code_blocked') {
    return { status: 'expired' };
  }
  if (data.status === 'scaned' || data.status === 'scanned') {
    return { status: 'scanned' };
  }
  // States we don't fully support yet — log so we can detect them from the field.
  // scaned_but_redirect: IDC host switch; need_verifycode: numeric pairing code.
  if (data.status === 'scaned_but_redirect' || data.status === 'need_verifycode') {
    console.warn(`[WeChat] unhandled QR status: ${data.status}`, data);
    return { status: 'scanned' };
  }
  return { status: 'wait' };
}

// ── Inbound Adapter ──

export class WeChatInboundAdapter implements InboundAdapter {
  private _status: AdapterStatus = 'disconnected';
  private abortCtrl: AbortController | null = null;
  private messageCallback: ((msg: InboundMessage) => void) | null = null;

  private credentials: WeChatCredentials | null = null;
  private cursor = '';
  private channelKey = ''; // for localStorage persistence
  // Dedup processed message IDs — the cursor may not advance, so the server can
  // re-deliver the same message; without this the bot would reply repeatedly.
  private seenMessageIds = new Set<number>();

  onMessage(callback: (msg: InboundMessage) => void): void {
    this.messageCallback = callback;
  }

  getStatus(): AdapterStatus {
    return this._status;
  }

  async connect(credentials: AdapterCredentials): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') return;

    this.credentials = JSON.parse(credentials.appSecret) as WeChatCredentials;
    this.channelKey = credentials.appId;

    // Restore persisted cursor + shared context tokens
    const savedCursor = localStorage.getItem(`wechat:cursor:${this.channelKey}`);
    if (savedCursor) this.cursor = savedCursor;
    restoreSharedContextTokens();

    this._status = 'connecting';
    this.abortCtrl = new AbortController();
    this._status = 'connected';
    console.log(`[WeChat] polling loop starting (baseurl=${this.credentials.baseurl}, cursor=${this.cursor ? 'restored' : 'empty'})`);
    this.runPollingLoop();
  }

  async disconnect(): Promise<void> {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this._status = 'disconnected';
  }

  private async runPollingLoop(): Promise<void> {
    const signal = this.abortCtrl!.signal;
    let failCount = 0;

    while (!signal.aborted) {
      try {
        const { botToken, baseurl } = this.credentials!;
        const f = await getTauriFetch();
        const resp = await f(ilinkUrl(baseurl, '/ilink/bot/getupdates'), {
          method: 'POST',
          headers: makeILinkHeaders(botToken),
          body: JSON.stringify({
            get_updates_buf: this.cursor,
            base_info: ILINK_BASE_INFO,
          }),
        });

        if (!resp.ok) throw new Error(`getupdates HTTP ${resp.status}`);

        const data = (await resp.json()) as {
          ret?: number;
          errcode?: number;
          errmsg?: string;
          msgs?: ILinkMessage[];
          get_updates_buf?: string;
        };

        console.log(`[WeChat] getupdates → ret=${data.ret} errcode=${data.errcode ?? 0} msgs=${data.msgs?.length ?? 0}`);

        // Session expired (-14 in either ret or errcode) — signal re-auth UI
        if (data.ret === -14 || data.errcode === -14) {
          console.warn('[WeChat] session expired (-14) — re-auth needed');
          this._status = 'error';
          this.messageCallback?.({
            message: { content: '' },
            sender: { id: '__system__', name: '', platform: 'wechat' },
            chat: { id: '__system__', type: 'direct' },
            replyContext: { platform: 'wechat', extra: { type: 'auth_expired' } },
            raw: data,
          });
          return;
        }

        // Only treat as error when an explicit non-zero code is present.
        // Successful responses may omit `ret` entirely (it comes back undefined).
        if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) {
          throw new Error(`getupdates ret=${data.ret} errcode=${data.errcode} errmsg=${data.errmsg ?? ''}`);
        }

        if (data.get_updates_buf) {
          this.cursor = data.get_updates_buf;
          localStorage.setItem(`wechat:cursor:${this.channelKey}`, this.cursor);
        }

        for (const msg of data.msgs ?? []) {
          console.log(`[WeChat] msg id=${msg.message_id} from=${msg.from_user_id} type=${msg.message_type} group=${msg.group_id ?? ''} items=${msg.item_list?.length ?? 0}`);
          if (msg.message_type !== 1) continue; // skip bot's own messages
          if (msg.group_id) continue; // skip group messages (not supported)
          if (this.seenMessageIds.has(msg.message_id)) continue; // already handled
          this.seenMessageIds.add(msg.message_id);

          sharedContextTokens.set(msg.from_user_id, msg.context_token);
          persistSharedContextTokens();
          void this.handleMessage(msg);
        }

        failCount = 0;
      } catch (err) {
        if (signal.aborted) break;
        failCount++;
        console.error(`[WeChat] getupdates failed (attempt ${failCount}):`, err);
        // After 3 consecutive failures, back off 30s; otherwise 2s
        const delay = failCount >= 3 ? 30_000 : 2_000;
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }

  private async handleMessage(msg: ILinkMessage): Promise<void> {
    const parts: string[] = [];

    for (const item of msg.item_list) {
      switch (item.type) {
        case 1:
          parts.push(item.text_item.text);
          break;
        case 2: {
          try {
            const path = await downloadAndDecryptMedia(
              item.image_item.encrypt_query_param,
              item.image_item.aes_key,
              'image.jpg',
            );
            parts.push(`[图片: ${path}]`);
          } catch {
            parts.push('[图片（加载失败）]');
          }
          break;
        }
        case 3: {
          // Use server-side ASR transcription when available
          const voiceText = item.voice_item.text;
          parts.push(voiceText ? `[语音] ${voiceText}` : '[语音消息]');
          break;
        }
        case 4: {
          try {
            const path = await downloadAndDecryptMedia(
              item.file_item.encrypt_query_param,
              item.file_item.aes_key,
              item.file_item.file_name,
            );
            parts.push(`[文件: ${item.file_item.file_name}, 路径: ${path}]`);
          } catch {
            parts.push(`[文件: ${item.file_item.file_name}（加载失败）]`);
          }
          break;
        }
        case 5:
          parts.push(`[视频: ${item.video_item.play_length}秒]`);
          break;
      }
    }

    const text = parts.join('\n').trim();
    if (!text) return;

    console.log(`[WeChat] dispatching inbound message: "${text.slice(0, 50)}"`);

    const replyCtx: ReplyContext = {
      platform: 'wechat',
      chatId: msg.from_user_id,
      messageId: String(msg.message_id),
    };

    this.messageCallback?.({
      message: { content: text },
      sender: {
        id: msg.from_user_id,
        name: msg.from_user_id.split('@')[0] ?? msg.from_user_id,
        platform: 'wechat',
      },
      chat: { id: msg.from_user_id, type: 'direct' },
      replyContext: replyCtx,
      raw: msg,
    });
  }
}

// ── Main Adapter ──

export class WeChatAdapter extends BaseAdapter {
  readonly config: AdapterConfig = {
    platform: 'wechat',
    displayName: '微信',
    maxLength: 3800,
    chunkMode: 'newline',
    supportsMarkdown: false, // WeChat renders plain text only
    supportsCard: false,
    skipThinkingAck: true, // can't update messages → ack would be separate noise
  };

  /** Inbound adapter exposed so wechatConnectionManager can manage its lifecycle. */
  readonly inbound: WeChatInboundAdapter;

  constructor() {
    super();
    this.inbound = new WeChatInboundAdapter();
  }

  formatOutbound(message: AbuMessage): unknown {
    return {
      msg: {
        from_user_id: '',
        to_user_id: '',
        client_id: clientId(),
        message_type: 2,
        message_state: 2,
        context_token: '',
        item_list: [{ type: 1, text_item: { text: message.content } }],
      },
      base_info: ILINK_BASE_INFO,
    };
  }

  /**
   * Reply to a WeChat user via iLink sendmessage API.
   *
   * `token` is the JSON-serialised WeChatCredentials from tokenManager.
   * `context.chatId` is the user's from_user_id (used to look up context_token).
   */
  async replyToChat(
    token: string,
    context: DirectReplyContext,
    message: AbuMessage,
  ): Promise<{ messageId?: string }> {
    const { botToken, baseurl } = JSON.parse(token) as WeChatCredentials;
    restoreSharedContextTokens();
    const contextToken = sharedContextTokens.get(context.chatId);
    if (!contextToken) {
      throw new Error(`[WeChat] No context_token for user ${context.chatId} — user must send a message first`);
    }
    console.log(`[WeChat] replying to ${context.chatId} (${this.chunkContent(message.content).length} chunk(s))`);

    const chunks = this.chunkContent(message.content);
    for (let i = 0; i < chunks.length; i++) {
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: context.chatId,
          client_id: clientId(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: chunks[i] } }],
        },
        base_info: ILINK_BASE_INFO,
      };

      const f = await getTauriFetch();
      const resp = await f(ilinkUrl(baseurl, '/ilink/bot/sendmessage'), {
        method: 'POST',
        headers: makeILinkHeaders(botToken),
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`[WeChat] sendmessage HTTP ${resp.status}`);

      const data = (await resp.json()) as { ret: number; errmsg?: string };
      if (data.ret !== 0) throw new Error(`[WeChat] sendmessage ret=${data.ret}: ${data.errmsg ?? ''}`);

      if (i < chunks.length - 1) {
        await new Promise<void>((r) => setTimeout(r, 300));
      }
    }

    return {};
  }
}
