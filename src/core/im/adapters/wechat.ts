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
import SparkMD5 from 'spark-md5';
import { getTauriFetch } from '../../llm/tauriFetch';
import { writeFile } from '@tauri-apps/plugin-fs';
import { readFile } from '../../tools/fsBridge';
import { authorizeWorkspace } from '../../tools/pathSafety';
import { getBaseName } from '../../../utils/pathUtils';
import { homeDir } from '@tauri-apps/api/path';
import { isWindows } from '../../../utils/platform';
import type { ImageAttachment } from '../../../types';
import { createLogger } from '../../logging/logger';
import { BaseAdapter } from './base';
import type {
  AdapterConfig,
  AbuMessage,
  DirectReplyContext,
  InboundAdapter,
  AdapterCredentials,
  AdapterStatus,
  InboundMessage,
  MediaFilePayload,
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

// Inbound items nest the CDN reference under `media` (verified against the
// official plugin 2.4.6: image/file/voice all read `*_item.media.*`). Images may
// additionally carry `aeskey` (a raw 16-byte key as a hex string) which takes
// precedence over `media.aes_key`. `media.full_url` is a ready-made download URL
// the server sometimes provides instead of encrypt_query_param.
/** A quoted ("引用") message: WeChat's own way to attach text to an earlier
 *  photo, since a single message can't carry both. The quoted message's item
 *  rides along inside the text item as `ref_msg.message_item`. */
interface ILinkRefMessage {
  message_item?: {
    type?: number;
    image_item?: { media?: CDNMedia; aeskey?: string };
    file_item?: { media?: CDNMedia; file_name?: string };
  };
  title?: string;
}

type ILinkItem =
  | { type: 1; text_item: { text: string }; ref_msg?: ILinkRefMessage }
  | { type: 2; image_item: { media?: CDNMedia; aeskey?: string; mid_size?: number; thumb_size?: number } }
  | { type: 3; voice_item: { media?: CDNMedia; encode_type?: string; text?: string; playtime?: number } }
  | { type: 4; file_item: { media?: CDNMedia; file_name: string; md5?: string; len?: number } }
  | { type: 5; video_item: { media?: CDNMedia; video_size?: number; play_length?: number; thumb_media?: CDNMedia } };

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string; // base64-encoded key (raw 16 bytes, or base64 of a 32-char hex string)
  encrypt_type?: 1;
  full_url?: string; // ready-made download URL (used instead of encrypt_query_param when present)
}

// ── Outbound media (getuploadurl → CDN upload → sendmessage) ──

// media_type values for getuploadurl (proto: UploadMediaType).
const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

// Renderer-side cap: the full file plus its ciphertext are held in memory and
// AES-128-ECB runs in pure JS (aes-js), so large files are slow and memory-heavy.
// The server itself accepts ≥100MB (spike-verified); this is our own conservative
// ceiling for v1. Larger sends should offload encryption to the sidecar.
export const WECHAT_MAX_OUTBOUND_BYTES = 25 * 1024 * 1024;

const CDN_UPLOAD_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CDN_DOWNLOAD_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * Where inbound attachments land — somewhere the agent is actually allowed to
 * read, which the OS temp dir is not: macOS resolves it under `~/Library`, a
 * hard-blocked sensitive directory that pathSafety rejects BEFORE any per-path
 * grant, so an attachment saved there could never be opened. `/tmp` is in
 * ALWAYS_ALLOWED_PATHS; on Windows its counterpart (`%LOCALAPPDATA%\Temp`) sits
 * under the equally-blocked `AppData`, so downloads go to `~/Downloads` there —
 * an allowed home path, and a sane place for a file someone sent you.
 */
async function resolveInboundMediaDir(): Promise<string> {
  if (!isWindows()) return '/tmp';
  return `${await homeDir()}/Downloads`.replace(/\\/g, '/');
}

// Logs land in the captured app log (renderer console.* does not), so inbound
// media diagnostics are visible in ~/Library/.../logs/<date>.log.
const wechatLog = createLogger('wechat-im');

// Deliberately separate from toolHelpers' IMAGE_EXTENSIONS (which is for reading
// files as vision content): this decides outbound WeChat *routing* — image bubble
// vs file attachment — so it omits svg (WeChat won't render it as an image bubble;
// it should go as a file) and uses bare extensions (no leading dot).
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

interface GetUploadUrlResp {
  upload_full_url?: string; // newer server: complete pre-signed URL
  upload_param?: string; // older server (official plugin era): needs CDN_UPLOAD_BASE prefix
  ret?: number;
  errmsg?: string;
}

interface GetConfigResp {
  typing_ticket?: string;
  ret?: number;
  errmsg?: string;
}

interface SendTypingResp {
  ret?: number;
  errmsg?: string;
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

// Encoded client version: major<<16 | minor<<8 | patch. Aligned to the current
// official plugin @tencent-weixin/openclaw-weixin 2.4.6 = (2<<16)|(4<<8)|6 = 132102.
const ILINK_CLIENT_VERSION = '132102';

// base_info is observability-only (not used for auth/routing) but every request
// carries it. channel_version kept in step with the official client (2.4.6).
const ILINK_BASE_INFO = { channel_version: '2.4.6', bot_agent: 'Abu' } as const;

// context_token cache shared between the inbound polling adapter (writes on each
// received message) and the registry adapter's replyToChat (reads to route replies).
// Keyed by from_user_id (globally unique `xxx@im.wechat`). Module-level so both the
// manager-created adapter instances and the registry adapter see the same tokens.
const sharedContextTokens = new Map<string, string>();
const CTX_STORAGE_KEY = 'wechat:ctx';

interface CachedTypingTicket {
  ticket: string;
  expiresAt: number;
}

// getconfig tickets are scoped to one from_user_id. Keep them for a day instead
// of fetching one for every message; a failed send invalidates the entry so the
// next 5-second heartbeat can recover immediately from an early server expiry.
const sharedTypingTickets = new Map<string, CachedTypingTicket>();
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

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

// Parse an inbound aes_key field into the raw 16 key bytes. Two encodings appear
// in the wild (verified against the official plugin's parseAesKey):
//   - base64(raw 16 bytes)           → images (media.aes_key)
//   - base64(32-char hex string)     → file / voice / video
function parseInboundAesKey(aesKeyBase64: string): Uint8Array {
  const decoded = Uint8Array.from(atob(aesKeyBase64), (c) => c.charCodeAt(0));
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const ascii = String.fromCharCode(...decoded);
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) return aesjs.utils.hex.toBytes(ascii);
  }
  throw new Error(`[WeChat] aes_key must decode to 16 raw bytes or a 32-char hex string (got ${decoded.length} bytes)`);
}

function aes128EcbDecryptBytes(data: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  // aes-js v3 ECB mode; operates on raw blocks (no built-in padding removal)
  const aesEcb = new aesjs.ModeOfOperation.ecb(keyBytes);
  const decrypted = aesEcb.decrypt(data);
  // Remove PKCS7 padding from the last block
  const paddingLen = decrypted[decrypted.length - 1];
  if (paddingLen < 1 || paddingLen > 16) return decrypted; // malformed padding: return as-is
  return decrypted.slice(0, decrypted.length - paddingLen);
}

function aes128EcbEncrypt(data: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  // PKCS7 pad to a 16-byte boundary (a full padding block is added when already aligned).
  const padLen = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded.fill(padLen, data.length);
  const aesEcb = new aesjs.ModeOfOperation.ecb(keyBytes);
  return aesEcb.encrypt(padded);
}

function md5Hex(data: Uint8Array): string {
  // spark-md5 hashes an ArrayBuffer; hand it exactly this view's bytes.
  return SparkMD5.ArrayBuffer.hash(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Upload a local file's bytes to the WeChat CDN with AES-128-ECB encryption.
 *
 * Mirrors the official plugin's flow (spike-verified end to end):
 *   getuploadurl → returns upload_full_url (new) or upload_param (old)
 *   → POST AES-encrypted bytes to the CDN → x-encrypted-param download param.
 *
 * Returns a CDN media reference plus the ciphertext size (used as mid_size /
 * video_size in the sendmessage item).
 */
async function uploadMediaToCdn(
  creds: WeChatCredentials,
  toUserId: string,
  plaintext: Uint8Array,
  mediaType: number,
): Promise<{ media: CDNMedia; ciphertextSize: number }> {
  const { botToken, baseurl } = creds;
  const rawsize = plaintext.length;
  const rawfilemd5 = md5Hex(plaintext);
  const filekey = randomHex(16);
  const aesKeyHex = randomHex(16);
  const aesKeyBytes = aesjs.utils.hex.toBytes(aesKeyHex);
  const ciphertext = aes128EcbEncrypt(plaintext, aesKeyBytes);
  const filesize = ciphertext.length;

  const f = await getTauriFetch();

  // 1. getuploadurl
  const upResp = await f(ilinkUrl(baseurl, '/ilink/bot/getuploadurl'), {
    method: 'POST',
    headers: makeILinkHeaders(botToken),
    body: JSON.stringify({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: ILINK_BASE_INFO,
    }),
  });
  if (!upResp.ok) throw new Error(`getuploadurl HTTP ${upResp.status}`);
  const upData = (await upResp.json()) as GetUploadUrlResp;
  if (upData.ret !== undefined && upData.ret !== 0) {
    throw new Error(`getuploadurl ret=${upData.ret} errmsg=${upData.errmsg ?? ''}`);
  }

  // Server returns either a complete URL (newer) or just the param (older).
  let cdnUrl: string;
  if (upData.upload_full_url) {
    cdnUrl = upData.upload_full_url;
  } else if (upData.upload_param) {
    cdnUrl = `${CDN_UPLOAD_BASE}/upload?encrypted_query_param=${encodeURIComponent(upData.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error('getuploadurl returned neither upload_full_url nor upload_param');
  }

  // 2. Encrypted upload to CDN. Pass a plain ArrayBuffer of exactly the
  // ciphertext bytes — a clean BodyInit both fetch paths (local + plugin) accept.
  const cipherBuf = ciphertext.buffer.slice(
    ciphertext.byteOffset,
    ciphertext.byteOffset + ciphertext.byteLength,
  ) as ArrayBuffer;
  const cdnResp = await f(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: cipherBuf,
  });
  if (cdnResp.status !== 200) {
    const err = cdnResp.headers.get('x-error-message') ?? `HTTP ${cdnResp.status}`;
    throw new Error(`CDN upload failed: ${err}`);
  }
  const downloadParam = cdnResp.headers.get('x-encrypted-param');
  if (!downloadParam) throw new Error('CDN upload: missing x-encrypted-param response header');

  return {
    media: {
      encrypt_query_param: downloadParam,
      // The official plugin base64-encodes the HEX STRING (32 ASCII chars), not
      // the raw 16 key bytes. Copied verbatim: this is the production wire format
      // the receiving client decrypts against (spike-confirmed on a real device).
      aes_key: btoa(aesKeyHex),
      encrypt_type: 1,
    },
    ciphertextSize: filesize,
  };
}

/**
 * Download + AES-128-ECB decrypt an inbound media item's CDN blob.
 *
 * Field layout verified against the official plugin 2.4.6:
 *   - URL: `media.full_url` if present, else the CDN download endpoint
 *     `${CDN_DOWNLOAD_BASE}/download?encrypted_query_param=<param>` (the raw
 *     param is NOT a path — it must be a query arg).
 *   - Key: `aeskeyHex` (image_item.aeskey, a raw-hex string) takes precedence;
 *     otherwise `media.aes_key` (base64 of raw-16 or of a 32-char hex string).
 */
async function downloadAndDecryptMedia(
  media: CDNMedia,
  aesKeyHex: string | undefined,
  fileName?: string,
): Promise<{ path: string; bytes: Uint8Array }> {
  const keyBytes = aesKeyHex
    ? aesjs.utils.hex.toBytes(aesKeyHex)
    : parseInboundAesKey(media.aes_key ?? '');

  const cdnUrl = media.full_url
    ? media.full_url
    : `${CDN_DOWNLOAD_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`;

  const f = await getTauriFetch();
  const resp = await f(cdnUrl);
  if (!resp.ok) throw new Error(`CDN download failed: HTTP ${resp.status}`);

  const buf = await resp.arrayBuffer();
  const decrypted = aes128EcbDecryptBytes(new Uint8Array(buf), keyBytes);

  const ext = fileName?.split('.').pop() ?? 'bin';
  const name = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  // NOT the OS temp dir: on macOS it resolves under ~/Library, which pathSafety
  // hard-blocks (a sensitive home dir, checked BEFORE any per-path grant), so a
  // file saved there could never be opened — `read_file` answered "拒绝访问" for
  // an attachment the user had just sent. `/tmp` is in ALWAYS_ALLOWED_PATHS, so
  // the agent can read what arrives without widening anything.
  const path = `${await resolveInboundMediaDir()}/${name}`;
  await writeFile(path, decrypted);
  return { path, bytes: decrypted };
}

// Encode raw bytes to a base64 string (no data: prefix) for ImageAttachment.data.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000; // avoid call-stack limits on large inputs
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Map a WeChat image file extension to an ImageAttachment media type.
function imageMediaTypeFor(ext: string): ImageAttachment['mediaType'] {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return 'image/jpeg';
  }
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

          try {
            sharedContextTokens.set(msg.from_user_id, msg.context_token);
            persistSharedContextTokens();
            // Await, do NOT fire-and-forget: handleMessage downloads+decrypts media
            // for image/file items, so a text message sent right after a photo would
            // otherwise overtake it and reach the agent first. WeChat's ordering is
            // meaningful ("<photo>" then "describe this"), so a batch must be
            // dispatched strictly in order.
            await this.handleMessage(msg);
          } catch (err) {
            // The response cursor has already advanced. Isolate a bad message so
            // it cannot strand every later message in the same response; rolling
            // the cursor back would instead redeliver messages already dispatched.
            wechatLog.error('inbound message processing failed', {
              message_id: msg.message_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
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
    // Inbound images are downloaded + decrypted here and carried as real image
    // attachments so the vision model actually sees them (see onMessage →
    // dispatchDirect → channelRouter, which passes these as `images`). Without
    // this the model only ever saw a "[图片]" text marker.
    const images: ImageAttachment[] = [];

    for (const item of msg.item_list) {
      switch (item.type) {
        case 1: {
          parts.push(item.text_item.text);
          // A quoted photo ("引用" an earlier image, then type the question) is
          // WeChat's own answer to "one message can't carry image + text", and
          // the official plugin reads it the same way: pull the quoted item's
          // image so the question arrives WITH its picture, deterministically.
          const quoted = item.ref_msg?.message_item;
          if (quoted?.type === 2 && (quoted.image_item?.media?.encrypt_query_param || quoted.image_item?.media?.full_url)) {
            try {
              const { bytes } = await downloadAndDecryptMedia(
                quoted.image_item.media,
                quoted.image_item.aeskey,
                'image.jpg',
              );
              images.push({
                id: `wechat-img-${msg.message_id}-ref-${images.length}`,
                data: bytesToBase64(bytes),
                mediaType: imageMediaTypeFor('jpg'),
              });
              wechatLog.warn('inbound quoted image decoded ok', { bytes: bytes.length });
            } catch (err) {
              wechatLog.error('inbound quoted image download failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // A quoted FILE works the same way (the official plugin's ref lookup
          // covers every media type, not just images): fetch it and hand the
          // agent its local path alongside the question.
          if (quoted?.type === 4 && (quoted.file_item?.media?.encrypt_query_param || quoted.file_item?.media?.full_url)) {
            const quotedName = quoted.file_item.file_name ?? 'file';
            try {
              const { path } = await downloadAndDecryptMedia(
                quoted.file_item.media,
                undefined,
                quotedName,
              );
              authorizeWorkspace(path, ['read']);
              parts.push(`[文件: ${quotedName}, 路径: ${path}]`);
              wechatLog.warn('inbound quoted file downloaded ok', { name: quotedName });
            } catch (err) {
              wechatLog.error('inbound quoted file download failed', {
                error: err instanceof Error ? err.message : String(err),
              });
              parts.push(`[文件: ${quotedName}（加载失败）]`);
            }
          }
          break;
        }
        case 2: {
          try {
            const media = item.image_item.media;
            if (!media?.encrypt_query_param && !media?.full_url) throw new Error('image_item has no media ref');
            const { bytes } = await downloadAndDecryptMedia(
              media,
              item.image_item.aeskey, // raw-hex key, takes precedence over media.aes_key
              'image.jpg',
            );
            images.push({
              id: `wechat-img-${msg.message_id}-${images.length}`,
              data: bytesToBase64(bytes),
              mediaType: imageMediaTypeFor('jpg'),
            });
            wechatLog.debug('inbound image decoded ok', { bytes: images[images.length - 1]?.data.length ?? 0 });
            // No text placeholder on success: the image block itself is what the
            // model sees, and a literal "[图片]" marker alongside it reads as a
            // failed attachment ("the image didn't load") and makes the model
            // narrate loading status instead of just describing the picture.
          } catch (err) {
            wechatLog.error('inbound image download failed', { error: err instanceof Error ? err.message : String(err) });
            parts.push('[图片（加载失败）]');
          }
          break;
        }
        case 3: {
          // Prefer the server's own transcription — the official plugin does the
          // same, only falling back to downloading audio when there is no text.
          // We stop at the text: raw SILK needs a transcoder (silk-wasm) AND an
          // audio-capable model, so a downloaded .silk would be a dead end. When
          // there's no transcript, say so in a way the agent can act on.
          const voiceText = item.voice_item.text;
          parts.push(voiceText
            ? `[语音] ${voiceText}`
            : '[语音消息（没有转写文字，无法识别内容——请让用户改用文字重发）]');
          break;
        }
        case 4: {
          try {
            const media = item.file_item.media;
            if (!media?.encrypt_query_param && !media?.full_url) throw new Error('file_item has no media ref');
            const { path } = await downloadAndDecryptMedia(
              media,
              undefined, // files use media.aes_key (base64 of hex)
              item.file_item.file_name,
            );
            // Grant READ on exactly this file. It lands in the system temp dir,
            // which no IM channel has authorized, so `read_file` was refused
            // ("拒绝访问") and the agent could never open a document the user had
            // just deliberately sent it. The grant is per-file and read-only —
            // not the temp directory, and never write — so it opens nothing
            // beyond the attachment itself.
            authorizeWorkspace(path, ['read']);
            // Keep the local path in the text so the agent can read_file it
            // (files aren't vision content; the path is how it reaches them).
            parts.push(`[文件: ${item.file_item.file_name}, 路径: ${path}]`);
          } catch (err) {
            wechatLog.error('inbound file download failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            parts.push(`[文件: ${item.file_item.file_name}（加载失败）]`);
          }
          break;
        }
        case 5: {
          // Same treatment as a file: fetch it and hand over the local path.
          // Without this a video was a dead end — the agent saw only a duration
          // and had nothing it could open, forward, or process.
          const media = item.video_item.media;
          const seconds = item.video_item.play_length;
          if (!media?.encrypt_query_param && !media?.full_url) {
            parts.push(`[视频: ${seconds}秒]`);
            break;
          }
          try {
            const { path } = await downloadAndDecryptMedia(media, undefined, 'video.mp4');
            authorizeWorkspace(path, ['read']);
            parts.push(`[视频: ${seconds}秒, 路径: ${path}]`);
            wechatLog.warn('inbound video downloaded ok', { seconds });
          } catch (err) {
            wechatLog.error('inbound video download failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            parts.push(`[视频: ${seconds}秒（加载失败）]`);
          }
          break;
        }
      }
    }

    const text = parts.join('\n').trim();
    if (!text && images.length === 0) return;

    console.log(`[WeChat] dispatching inbound message: "${text.slice(0, 50)}" (${images.length} image(s))`);

    const replyCtx: ReplyContext = {
      platform: 'wechat',
      chatId: msg.from_user_id,
      messageId: String(msg.message_id),
    };

    this.messageCallback?.({
      message: { content: text },
      images: images.length > 0 ? images : undefined,
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
    supportsMediaOut: true, // can deliver images/files via sendMediaFile
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

  /** Fetch the per-user ticket required by the iLink typing endpoint. */
  private async getConfig(
    f: typeof globalThis.fetch,
    creds: Pick<WeChatCredentials, 'botToken' | 'baseurl'>,
    userId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    restoreSharedContextTokens();
    const contextToken = sharedContextTokens.get(userId);
    if (!contextToken) {
      throw new Error(`[WeChat] No context_token for user ${userId} — user must send a message first`);
    }

    const resp = await f(ilinkUrl(creds.baseurl, '/ilink/bot/getconfig'), {
      method: 'POST',
      headers: makeILinkHeaders(creds.botToken),
      signal,
      body: JSON.stringify({
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: ILINK_BASE_INFO,
      }),
    });
    if (!resp.ok) throw new Error(`[WeChat] getconfig HTTP ${resp.status}`);

    const data = (await resp.json()) as GetConfigResp;
    if (data.ret !== undefined && data.ret !== 0) {
      throw new Error(`[WeChat] getconfig ret=${data.ret}: ${data.errmsg ?? ''}`);
    }
    if (!data.typing_ticket) {
      throw new Error('[WeChat] getconfig returned no typing_ticket');
    }
    return data.typing_ticket;
  }

  /**
   * Best-effort WeChat typing state. Protocol failures are deliberately
   * contained here: a presence hint must never interrupt the real reply path.
   */
  async sendTyping(
    token: string,
    userId: string,
    status: 1 | 2,
    signal?: AbortSignal,
  ): Promise<void> {
    let ticket: string | undefined;
    try {
      const creds = JSON.parse(token) as WeChatCredentials;
      const f = await getTauriFetch();
      const cached = sharedTypingTickets.get(userId);

      if (cached && cached.expiresAt > Date.now()) {
        ticket = cached.ticket;
      } else {
        if (cached) sharedTypingTickets.delete(userId);
        ticket = await this.getConfig(f, creds, userId, signal);
        sharedTypingTickets.set(userId, {
          ticket,
          expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
        });
      }

      const resp = await f(ilinkUrl(creds.baseurl, '/ilink/bot/sendtyping'), {
        method: 'POST',
        headers: makeILinkHeaders(creds.botToken),
        signal,
        body: JSON.stringify({
          ilink_user_id: userId,
          typing_ticket: ticket,
          status,
          base_info: ILINK_BASE_INFO,
        }),
      });
      if (!resp.ok) throw new Error(`[WeChat] sendtyping HTTP ${resp.status}`);

      const data = (await resp.json()) as SendTypingResp;
      if (data.ret !== undefined && data.ret !== 0) {
        throw new Error(`[WeChat] sendtyping ret=${data.ret}: ${data.errmsg ?? ''}`);
      }
    } catch (err) {
      const cached = sharedTypingTickets.get(userId);
      if (ticket && cached?.ticket === ticket) {
        sharedTypingTickets.delete(userId);
      }
      if (signal?.aborted) return;
      wechatLog.warn('typing indicator request failed', {
        userId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * POST a list of message items to iLink, one sendmessage request per item
   * (the protocol carries exactly one item per message), pausing 300ms between
   * requests. Shared by replyToChat (text chunks) and sendMediaFile (caption +
   * media) so the request/error/throttle handling lives in one place.
   */
  private async postSendMessageItems(
    creds: Pick<WeChatCredentials, 'botToken' | 'baseurl'>,
    contextToken: string,
    chatId: string,
    items: unknown[],
  ): Promise<void> {
    const f = await getTauriFetch();
    for (let i = 0; i < items.length; i++) {
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: chatId,
          client_id: clientId(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [items[i]],
        },
        base_info: ILINK_BASE_INFO,
      };
      await this.postOneItem(f, creds, body);
      if (i < items.length - 1) {
        await new Promise<void>((r) => setTimeout(r, 300));
      }
    }
  }

  /**
   * POST one sendmessage request. `ret=-2 prepare failed` is the server's
   * transient rate-limit signal (observed after bursts of media sends): retry
   * it once after a short backoff, then surface a stable `rate_limited` marker
   * the tool layer maps to a friendly "please retry later" message. Other
   * non-zero rets are hard errors.
   */
  private async postOneItem(
    f: typeof globalThis.fetch,
    creds: Pick<WeChatCredentials, 'botToken' | 'baseurl'>,
    body: unknown,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await f(ilinkUrl(creds.baseurl, '/ilink/bot/sendmessage'), {
        method: 'POST',
        headers: makeILinkHeaders(creds.botToken),
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`[WeChat] sendmessage HTTP ${resp.status}`);
      const data = (await resp.json()) as { ret?: number; errmsg?: string };
      if (data.ret === undefined || data.ret === 0) return;
      if (data.ret === -2 && attempt === 0) {
        // transient "prepare failed" — back off once and retry
        await new Promise<void>((r) => setTimeout(r, 1500));
        continue;
      }
      if (data.ret === -2) {
        throw new Error('[WeChat] rate_limited: sendmessage ret=-2 prepare failed');
      }
      throw new Error(`[WeChat] sendmessage ret=${data.ret}: ${data.errmsg ?? ''}`);
    }
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
    const chunks = this.chunkContent(message.content);
    console.log(`[WeChat] replying to ${context.chatId} (${chunks.length} chunk(s))`);

    await this.postSendMessageItems(
      { botToken, baseurl },
      contextToken,
      context.chatId,
      chunks.map((text) => ({ type: 1, text_item: { text } })),
    );

    return {};
  }

  /**
   * Send a local file (image / document) to a WeChat user.
   *
   * Routes by extension: known image types go as an image bubble (type 2),
   * everything else as a file attachment (type 4). An optional caption is sent
   * first as its own text message, matching the official plugin's behavior
   * (each sendmessage carries exactly one item).
   *
   * `token` is the JSON-serialised WeChatCredentials; `context.chatId` is the
   * recipient's from_user_id (used to look up the shared context_token).
   */
  async sendMediaFile(
    token: string,
    context: DirectReplyContext,
    payload: MediaFilePayload,
  ): Promise<{ messageId?: string }> {
    const creds = JSON.parse(token) as WeChatCredentials;
    restoreSharedContextTokens();
    const contextToken = sharedContextTokens.get(context.chatId);
    if (!contextToken) {
      throw new Error(`[WeChat] No context_token for user ${context.chatId} — user must send a message first`);
    }

    const bytes = await readFile(payload.filePath);
    if (bytes.length === 0) throw new Error('[WeChat] cannot send an empty file');
    if (bytes.length > WECHAT_MAX_OUTBOUND_BYTES) {
      throw new Error(
        `[WeChat] file too large: ${bytes.length} bytes (max ${WECHAT_MAX_OUTBOUND_BYTES})`,
      );
    }

    const fileName = payload.fileName ?? (getBaseName(payload.filePath) || 'file');
    const dot = fileName.lastIndexOf('.');
    const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
    const isImage = IMAGE_EXTS.has(ext);
    const mediaType = isImage ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE;

    console.log(`[WeChat] sendMediaFile to ${context.chatId}: ${fileName} (${bytes.length}B, ${isImage ? 'image' : 'file'})`);

    const { media, ciphertextSize } = await uploadMediaToCdn(
      creds,
      context.chatId,
      bytes,
      mediaType,
    );

    const item = isImage
      ? { type: 2, image_item: { media, mid_size: ciphertextSize } }
      : { type: 4, file_item: { media, file_name: fileName, len: String(bytes.length) } };

    // Caption first (its own text message), then the media item.
    const items: unknown[] = [];
    if (payload.caption?.trim()) {
      items.push({ type: 1, text_item: { text: payload.caption.trim() } });
    }
    items.push(item);

    await this.postSendMessageItems(creds, contextToken, context.chatId, items);
    return {};
  }
}
