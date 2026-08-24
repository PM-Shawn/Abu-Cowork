/**
 * WeChatAdapter.sendMediaFile — outbound media protocol.
 *
 * Verifies the three-step flow (getuploadurl → CDN encrypted upload →
 * sendmessage) drives the right request shapes, routes image vs file by
 * extension, sends an optional caption first, handles both upload_full_url and
 * upload_param server responses, and enforces the size ceiling.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from '../../tools/fsBridge';
import { WeChatAdapter, WECHAT_MAX_OUTBOUND_BYTES } from './wechat';
import type { WeChatCredentials } from './wechat';

// wechat.ts reads outbound files through the Electron-boundary fsBridge, not
// plugin-fs directly. Mock it here so the adapter sees controlled bytes.
vi.mock('../../tools/fsBridge', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5])),
}));

// Capture every request the adapter makes.
interface CapturedReq { url: string; init: RequestInit }
let captured: CapturedReq[] = [];
let uploadUrlResponse: Record<string, unknown> = { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=UP' };
// Per-call `ret` values for successive sendmessage requests; undefined → ret 0.
let sendRetQueue: number[] = [];

function makeResp(url: string): Response {
  // getuploadurl
  if (url.includes('/ilink/bot/getuploadurl')) {
    return {
      ok: true,
      status: 200,
      json: async () => uploadUrlResponse,
      headers: { get: () => null },
    } as unknown as Response;
  }
  // sendmessage
  if (url.includes('/ilink/bot/sendmessage')) {
    const ret = sendRetQueue.length > 0 ? sendRetQueue.shift()! : 0;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ret, errmsg: ret ? 'prepare failed' : undefined }),
      headers: { get: () => null },
    } as unknown as Response;
  }
  // CDN upload (any /upload? not on the ilink host)
  if (url.includes('/upload')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: (h: string) => (h.toLowerCase() === 'x-encrypted-param' ? 'DOWNLOAD_PARAM' : null) },
    } as unknown as Response;
  }
  throw new Error(`unexpected fetch url: ${url}`);
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  captured.push({ url, init: init ?? {} });
  return makeResp(url);
});

vi.mock('../../llm/tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve((input: RequestInfo | URL, init?: RequestInit) => fakeFetch(input, init)),
}));

const CREDS: WeChatCredentials = { botToken: 'bt-123', baseurl: 'ilinkai.weixin.qq.com', ilinkBotId: 'bot-1' };
const CHAT_ID = 'o9cq80w0UrFIT@im.wechat';
const CTX_TOKEN = 'ctx-token-xyz';

function findBody(pred: (u: string) => boolean): Record<string, unknown> {
  const req = captured.find((c) => pred(c.url));
  if (!req) throw new Error('request not found');
  return JSON.parse(req.init.body as string);
}

describe('WeChatAdapter.sendMediaFile', () => {
  beforeEach(() => {
    captured = [];
    fakeFetch.mockClear();
    uploadUrlResponse = { upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=UP' };
    sendRetQueue = [];
    // context_token is looked up from the module-level shared cache, restored
    // from localStorage. Seed it so the adapter can resolve the reply target.
    localStorage.setItem('wechat:ctx', JSON.stringify([[CHAT_ID, CTX_TOKEN]]));
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('sends an image: getuploadurl(media_type=1) → CDN upload → sendmessage image_item', async () => {
    const adapter = new WeChatAdapter();
    await adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/pic.png' });

    // getuploadurl body shape
    const up = findBody((u) => u.includes('getuploadurl'));
    expect(up.media_type).toBe(1); // IMAGE
    expect(up.to_user_id).toBe(CHAT_ID);
    expect(up.rawsize).toBe(5);
    expect(up.no_need_thumb).toBe(true);
    expect(typeof up.rawfilemd5).toBe('string');
    expect((up.rawfilemd5 as string).length).toBe(32); // md5 hex
    expect(typeof up.aeskey).toBe('string');
    expect(up.filesize).toBe(16); // 5 bytes PKCS7-padded to one AES block

    // CDN upload was called with octet-stream
    const cdn = captured.find((c) => c.url.includes('/upload') && !c.url.includes('ilink'));
    expect(cdn).toBeTruthy();
    const cdnHeaders = cdn!.init.headers as Record<string, string>;
    expect(cdnHeaders['Content-Type']).toBe('application/octet-stream');

    // sendmessage carries an image_item with the CDN download param
    const send = findBody((u) => u.includes('sendmessage'));
    const item = (send.msg as { item_list: Array<Record<string, unknown>> }).item_list[0];
    expect(item.type).toBe(2);
    const imageItem = item.image_item as { media: { encrypt_query_param: string; encrypt_type: number } };
    expect(imageItem.media.encrypt_query_param).toBe('DOWNLOAD_PARAM');
    expect(imageItem.media.encrypt_type).toBe(1);
  });

  it('sends a non-image as file_item(media_type=3) with file_name + len', async () => {
    const adapter = new WeChatAdapter();
    await adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/report.pdf' });

    const up = findBody((u) => u.includes('getuploadurl'));
    expect(up.media_type).toBe(3); // FILE

    const send = findBody((u) => u.includes('sendmessage'));
    const item = (send.msg as { item_list: Array<Record<string, unknown>> }).item_list[0];
    expect(item.type).toBe(4);
    const fileItem = item.file_item as { file_name: string; len: string };
    expect(fileItem.file_name).toBe('report.pdf');
    expect(fileItem.len).toBe('5');
  });

  it('sends the caption as its own text message before the media', async () => {
    const adapter = new WeChatAdapter();
    await adapter.sendMediaFile(
      JSON.stringify(CREDS),
      { chatId: CHAT_ID },
      { filePath: '/tmp/pic.png', caption: '这是图表' },
    );

    const sends = captured.filter((c) => c.url.includes('sendmessage'));
    expect(sends.length).toBe(2);
    const first = JSON.parse(sends[0].init.body as string);
    const firstItem = (first.msg as { item_list: Array<Record<string, unknown>> }).item_list[0];
    expect(firstItem.type).toBe(1); // TEXT caption
    expect((firstItem.text_item as { text: string }).text).toBe('这是图表');
    const second = JSON.parse(sends[1].init.body as string);
    const secondItem = (second.msg as { item_list: Array<Record<string, unknown>> }).item_list[0];
    expect(secondItem.type).toBe(2); // IMAGE
  });

  it('supports the older upload_param server response shape', async () => {
    uploadUrlResponse = { upload_param: 'PARAM123' };
    const adapter = new WeChatAdapter();
    await adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/pic.png' });

    const cdn = captured.find((c) => c.url.includes('/upload') && !c.url.includes('ilink'));
    expect(cdn!.url).toContain('encrypted_query_param=PARAM123');
    expect(cdn!.url).toContain('filekey=');
  });

  it('rejects a file over the size ceiling before any upload', async () => {
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Uint8Array(WECHAT_MAX_OUTBOUND_BYTES + 1),
    );
    const adapter = new WeChatAdapter();
    await expect(
      adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/big.bin' }),
    ).rejects.toThrow(/too large/);
    expect(captured.length).toBe(0);
  });

  it('rejects an empty file', async () => {
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(new Uint8Array(0));
    const adapter = new WeChatAdapter();
    await expect(
      adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/empty.txt' }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when no context_token is known for the recipient', async () => {
    localStorage.removeItem('wechat:ctx');
    const adapter = new WeChatAdapter();
    await expect(
      adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: 'unknown@im.wechat' }, { filePath: '/tmp/pic.png' }),
    ).rejects.toThrow(/context_token/);
  });

  it('advertises outbound media support', () => {
    expect(new WeChatAdapter().config.supportsMediaOut).toBe(true);
  });

  it('retries once on ret=-2 (prepare failed) then succeeds', async () => {
    sendRetQueue = [-2]; // first sendmessage fails transiently, retry returns ret 0
    const adapter = new WeChatAdapter();
    await adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/pic.png' });
    // two sendmessage calls for the single media item (fail + retry)
    const sends = captured.filter((c) => c.url.includes('sendmessage'));
    expect(sends.length).toBe(2);
  }, 10000);

  it('throws a rate_limited marker when ret=-2 persists', async () => {
    sendRetQueue = [-2, -2];
    const adapter = new WeChatAdapter();
    await expect(
      adapter.sendMediaFile(JSON.stringify(CREDS), { chatId: CHAT_ID }, { filePath: '/tmp/pic.png' }),
    ).rejects.toThrow(/rate_limited/);
  }, 10000);
});
