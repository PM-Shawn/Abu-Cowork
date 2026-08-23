/**
 * WeChatAdapter typing protocol: per-user getconfig ticket cache followed by
 * best-effort sendtyping state updates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WeChatAdapter } from './wechat';
import type { WeChatCredentials } from './wechat';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../llm/tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mocks.fetch),
}));

vi.mock('../../logging/logger', () => ({
  createLogger: () => ({
    warn: mocks.warn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const CREDS: WeChatCredentials = {
  botToken: 'bot-token',
  baseurl: 'ilinkai.weixin.qq.com',
  ilinkBotId: 'bot-id',
};
const SERIALIZED_CREDS = JSON.stringify(CREDS);
const USER_FIRST = 'typing-first@im.wechat';
const USER_CACHE = 'typing-cache@im.wechat';
const USER_OTHER = 'typing-other@im.wechat';
const USER_STALE = 'typing-stale@im.wechat';
const USER_FAILURE = 'typing-failure@im.wechat';

let captured: CapturedRequest[] = [];
let getConfigStatus = 200;
let getConfigRetQueue: number[] = [];
let sendTypingRetQueue: number[] = [];
let ticketCounter = 0;

function response(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function requestsFor(path: string): CapturedRequest[] {
  return captured.filter((request) => request.url.includes(path));
}

function parseBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.init.body as string) as Record<string, unknown>;
}

describe('WeChatAdapter.sendTyping', () => {
  beforeEach(() => {
    captured = [];
    getConfigStatus = 200;
    getConfigRetQueue = [];
    sendTypingRetQueue = [];
    ticketCounter = 0;
    mocks.fetch.mockReset();
    mocks.warn.mockReset();
    localStorage.setItem('wechat:ctx', JSON.stringify([
      [USER_FIRST, 'ctx-first'],
      [USER_CACHE, 'ctx-cache'],
      [USER_OTHER, 'ctx-other'],
      [USER_STALE, 'ctx-stale'],
      [USER_FAILURE, 'ctx-failure'],
    ]));

    mocks.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      captured.push({ url, init: init ?? {} });

      if (url.includes('/ilink/bot/getconfig')) {
        const ret = getConfigRetQueue.shift() ?? 0;
        ticketCounter++;
        return response(getConfigStatus, {
          ret,
          errmsg: ret === 0 ? undefined : 'config failed',
          typing_ticket: ret === 0 ? `ticket-${ticketCounter}` : undefined,
        });
      }
      if (url.includes('/ilink/bot/sendtyping')) {
        const ret = sendTypingRetQueue.shift() ?? 0;
        return response(200, {
          ret,
          errmsg: ret === 0 ? undefined : 'typing failed',
        });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
  });

  it('fetches a ticket then sends the active typing state with the iLink request shapes', async () => {
    const adapter = new WeChatAdapter();
    const controller = new AbortController();

    await adapter.sendTyping(SERIALIZED_CREDS, USER_FIRST, 1, controller.signal);

    const configRequests = requestsFor('/ilink/bot/getconfig');
    const typingRequests = requestsFor('/ilink/bot/sendtyping');
    expect(configRequests).toHaveLength(1);
    expect(typingRequests).toHaveLength(1);

    expect(parseBody(configRequests[0])).toEqual({
      ilink_user_id: USER_FIRST,
      context_token: 'ctx-first',
      base_info: { channel_version: '2.4.6', bot_agent: 'Abu' },
    });
    expect(parseBody(typingRequests[0])).toEqual({
      ilink_user_id: USER_FIRST,
      typing_ticket: 'ticket-1',
      status: 1,
      base_info: { channel_version: '2.4.6', bot_agent: 'Abu' },
    });
    expect((configRequests[0].init.headers as Record<string, string>).Authorization)
      .toBe('Bearer bot-token');
    expect(configRequests[0].init.signal).toBe(controller.signal);
    expect(typingRequests[0].init.signal).toBe(controller.signal);
  });

  it('reuses a ticket for the same user while keeping tickets isolated per user', async () => {
    const adapter = new WeChatAdapter();

    await adapter.sendTyping(SERIALIZED_CREDS, USER_CACHE, 1);
    await adapter.sendTyping(SERIALIZED_CREDS, USER_CACHE, 2);
    await adapter.sendTyping(SERIALIZED_CREDS, USER_OTHER, 1);

    expect(requestsFor('/ilink/bot/getconfig')).toHaveLength(2);
    const typingBodies = requestsFor('/ilink/bot/sendtyping').map(parseBody);
    expect(typingBodies.map((body) => body.status)).toEqual([1, 2, 1]);
    expect(typingBodies[0].typing_ticket).toBe(typingBodies[1].typing_ticket);
    expect(typingBodies[2].typing_ticket).not.toBe(typingBodies[0].typing_ticket);
  });

  it('invalidates a rejected ticket so the next heartbeat fetches fresh config', async () => {
    sendTypingRetQueue = [-1, 0];
    const adapter = new WeChatAdapter();

    await expect(adapter.sendTyping(SERIALIZED_CREDS, USER_STALE, 1)).resolves.toBeUndefined();
    await adapter.sendTyping(SERIALIZED_CREDS, USER_STALE, 1);

    expect(requestsFor('/ilink/bot/getconfig')).toHaveLength(2);
    expect(mocks.warn).toHaveBeenCalledWith(
      'typing indicator request failed',
      expect.objectContaining({ userId: USER_STALE, status: 1 }),
    );
  });

  it('contains getconfig failures so normal message processing can continue', async () => {
    getConfigStatus = 503;
    const adapter = new WeChatAdapter();

    await expect(adapter.sendTyping(SERIALIZED_CREDS, USER_FAILURE, 1)).resolves.toBeUndefined();

    expect(requestsFor('/ilink/bot/sendtyping')).toHaveLength(0);
    expect(mocks.warn).toHaveBeenCalledWith(
      'typing indicator request failed',
      expect.objectContaining({
        userId: USER_FAILURE,
        status: 1,
        error: expect.stringContaining('HTTP 503'),
      }),
    );
  });
});
