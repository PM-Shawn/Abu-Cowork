/**
 * WeChatInboundAdapter — inbound image handling.
 *
 * Drives the polling loop with a mocked getupdates that returns one image
 * message plus a mocked CDN download, and asserts the emitted InboundMessage
 * carries a real decoded image attachment (base64) — the fix for inbound photos
 * reaching the vision model instead of a bare "[图片]" marker.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as aesjs from 'aes-js';
import { WeChatInboundAdapter } from './wechat';
import type { WeChatCredentials } from './wechat';
import type { InboundMessage } from './types';

// Build a CDN payload the adapter can decrypt: AES-128-ECB + PKCS7 over known bytes.
const KEY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const PLAINTEXT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]); // PNG-ish bytes
const KEY_B64 = btoa(String.fromCharCode(...KEY));

function pkcs7(data: Uint8Array): Uint8Array {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}
const CIPHERTEXT = new aesjs.ModeOfOperation.ecb(KEY).encrypt(pkcs7(PLAINTEXT));

let getUpdatesCalls = 0;

const fakeFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  // CDN media download (GET)
  if (url.includes('novac2c.cdn.weixin.qq.com')) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => CIPHERTEXT.buffer.slice(CIPHERTEXT.byteOffset, CIPHERTEXT.byteOffset + CIPHERTEXT.byteLength),
    } as unknown as Response;
  }
  // getupdates long-poll: first call returns one image message, then empty
  if (url.includes('/ilink/bot/getupdates')) {
    getUpdatesCalls++;
    if (getUpdatesCalls === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ret: 0,
          get_updates_buf: 'cursor1',
          // A photo followed by a text message, exactly as WeChat delivers
          // "<photo>" then "describe this". Order must be preserved even though
          // the photo needs an async CDN download and the text does not.
          msgs: [
            {
              message_id: 424242,
              from_user_id: 'user@im.wechat',
              message_type: 1,
              context_token: 'ctx',
              item_list: [{
                type: 2,
                // inbound nests the CDN ref under `media` (2.4.6 wire shape)
                image_item: { media: { encrypt_query_param: '/enc?x=1', aes_key: KEY_B64, encrypt_type: 1 } },
              }],
            },
            {
              message_id: 424243,
              from_user_id: 'user@im.wechat',
              message_type: 1,
              context_token: 'ctx',
              item_list: [{ type: 1, text_item: { text: '描述这图片' } }],
            },
          ],
        }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0, msgs: [] }) } as unknown as Response;
  }
  throw new Error(`unexpected url ${url}`);
});

vi.mock('../../llm/tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve((input: RequestInfo | URL, init?: RequestInit) => fakeFetch(input, init)),
}));

const CREDS: WeChatCredentials = { botToken: 'bt', baseurl: 'ilinkai.weixin.qq.com', ilinkBotId: 'b' };

describe('WeChatInboundAdapter inbound image', () => {
  beforeEach(() => {
    getUpdatesCalls = 0;
    fakeFetch.mockClear();
    localStorage.clear();
  });

  /** Collect the first `n` non-system inbound messages, in arrival order. */
  function collect(adapter: WeChatInboundAdapter, n: number): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    return new Promise<InboundMessage[]>((resolve) => {
      adapter.onMessage((m) => {
        if (m.sender.id === '__system__') return;
        out.push(m);
        if (out.length >= n) resolve(out);
      });
    });
  }

  it('emits an InboundMessage with a decoded base64 image attachment', async () => {
    const adapter = new WeChatInboundAdapter();
    const received = collect(adapter, 1);

    await adapter.connect({ appId: 'ch1', appSecret: JSON.stringify(CREDS) });
    const [msg] = await received;
    await adapter.disconnect();

    expect(msg.images).toBeDefined();
    expect(msg.images!.length).toBe(1);
    // decoded bytes must round-trip to the original plaintext
    expect(msg.images![0].data).toBe(btoa(String.fromCharCode(...PLAINTEXT)));
    expect(msg.images![0].mediaType).toBe('image/jpeg');
    // text carries a placeholder; the image block is what the model sees
    expect(msg.message.content).toContain('[图片]');
  }, 10000);

  it('preserves arrival order — a photo is dispatched before the text sent after it', async () => {
    // Regression: handleMessage was fire-and-forget, so the text message (no
    // network) overtook the photo (async CDN download) and the agent answered
    // "describe this" before it had the image — then claimed it saw nothing.
    const adapter = new WeChatInboundAdapter();
    const received = collect(adapter, 2);

    await adapter.connect({ appId: 'ch1', appSecret: JSON.stringify(CREDS) });
    const msgs = await received;
    await adapter.disconnect();

    expect(msgs).toHaveLength(2);
    expect(msgs[0].images?.length).toBe(1); // photo first, with its image attached
    expect(msgs[1].message.content).toContain('描述这图片'); // then the text
    expect(msgs[1].images).toBeUndefined();
  }, 10000);
});
