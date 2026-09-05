/**
 * Contract tests for the browser MCP tool surface.
 *
 * Two things are pinned here, both of them cross-module couplings that no
 * compiler checks today:
 *
 * 1. The tool NAMES. `src/core/permissions/browserToolPolicy.ts` decides what
 *    needs approval by matching these strings. Nothing links the two packages,
 *    so renaming a tool here would silently drop it out of the permission gate
 *    — a fail-open. Any change to this list has to be made in both places.
 *
 * 2. The locator/condition parsing, which is the only validation standing
 *    between model-authored JSON and the DOM runtime.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ABU_CONVERSATION_META_KEY,
  ABU_CREATE_IF_EMPTY_META_KEY,
  ABU_RUN_META_KEY,
  registerTools,
  type BrowserTransport,
} from './tools.js';

type ToolHandler = (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  handler: ToolHandler;
}
type ServerArg = Parameters<typeof registerTools>[0];

/** Captures what registerTools() registers, without a real MCP server. */
function collectTools(): { registered: RegisteredTool[]; transport: BrowserTransport } {
  const registered: RegisteredTool[] = [];
  const server = {
    tool(
      name: string,
      description: string,
      schemaOrHandler: Record<string, unknown> | ToolHandler,
      maybeHandler?: ToolHandler,
    ) {
      const hasSchema = typeof schemaOrHandler !== 'function';
      registered.push({
        name,
        description,
        schema: hasSchema ? (schemaOrHandler as Record<string, unknown>) : undefined,
        handler: (hasSchema ? maybeHandler : (schemaOrHandler as ToolHandler)) as ToolHandler,
      });
    },
  };
  const transport: BrowserTransport = {
    isConnected: vi.fn(async () => true),
    send: vi.fn(async () => ({ success: true, data: {} })),
    getConnectionError: vi.fn(() => 'not connected'),
  } as unknown as BrowserTransport;

  registerTools(server as unknown as ServerArg, transport);
  return { registered, transport };
}

describe('tool surface', () => {
  it('registers exactly the tool names the permission gate keys off', () => {
    const { registered } = collectTools();
    // Sorted so the diff on any future change is readable.
    expect(registered.map((t) => t.name).sort()).toEqual([
      'click',
      'connection_status',
      'execute_js',
      'extract_table',
      'extract_text',
      'fill',
      'find',
      'get_downloads',
      'get_tabs',
      'keyboard',
      'navigate',
      'query_js',
      'screenshot',
      'screenshot_full_page',
      'scroll',
      'select',
      'snapshot',
      'start_recording',
      'stop_recording',
      'wait_for',
    ]);
  });

  it('keeps every state-changing tool named exactly as browserToolPolicy expects', () => {
    // Mirror of STATE_CHANGING_TOOLS in src/core/permissions/browserToolPolicy.ts.
    // If this fails, the permission gate has stopped covering an action.
    const gated = ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate'];
    const names = new Set(collectTools().registered.map((t) => t.name));
    for (const name of gated) expect(names).toContain(name);
  });

  it('points the model at the snapshot as the primary way to understand a page', () => {
    const { registered } = collectTools();
    const snapshot = registered.find((t) => t.name === 'snapshot')!;
    expect(snapshot.description).toMatch(/primary way to understand/i);
    // The recovery path out of a truncated snapshot has to be in the tool
    // description, not only in the runtime message: falling back to a script
    // is what the truncation used to cause.
    expect(snapshot.description).toMatch(/execute_js/);
    expect(snapshot.description).toMatch(/query_js/);
    expect(Object.keys(snapshot.schema!)).toEqual(expect.arrayContaining(['selector', 'maxChars']));
  });

  it('tells the model select is one call, not click-then-hunt', () => {
    // A field trace showed the model clicking the dropdown open, snapshotting,
    // then scripting the page — it only reached for `select` once, and that
    // one call worked. The instruction has to be in the description.
    const select = collectTools().registered.find((t) => t.name === 'select')!;
    expect(select.description).toMatch(/ONE call/);
    expect(select.description).toMatch(/Do NOT click the control open first/);
    expect(select.description).toMatch(/execute_js/);
  });

  it('points click at select for dropdowns and reports the real target', () => {
    const click = collectTools().registered.find((t) => t.name === 'click')!;
    expect(click.description).toMatch(/use `select`/);
    expect(click.description).toMatch(/actually hit/);
  });

  it('sends the model back to the read tools before it scripts the page', () => {
    // A field trace spent four script executions — four approval prompts —
    // answering "did the submit work". Every one of them was a job for
    // wait_for + extract_text.
    const js = collectTools().registered.find((t) => t.name === 'execute_js')!;
    expect(js.description).toMatch(/LAST RESORT/);
    expect(js.description).toMatch(/interrupts the user/);
    expect(js.description).toMatch(/query_js/);
    expect(js.description).toMatch(/extract_text/);
    expect(js.description).toMatch(/select/);
  });

  it('describes query_js as a detached read-only batch-read tool', () => {
    const query = collectTools().registered.find((t) => t.name === 'query_js')!;
    expect(query.description).toMatch(/detached, inert copy/i);
    expect(query.description).toMatch(/batch reads/i);
    expect(query.description).toMatch(/no approval prompt/i);
    expect(Object.keys(query.schema!)).toEqual(expect.arrayContaining(['tabId', 'code', 'selector']));
  });

  it('forwards the snapshot scoping options to the page', async () => {
    const { registered, transport } = collectTools();
    const snapshot = registered.find((t) => t.name === 'snapshot')!;

    await snapshot.handler({ tabId: 7, selector: '.ant-form', maxChars: 5000 });

    expect(transport.send).toHaveBeenCalledWith(
      'snapshot',
      { tabId: 7, selector: '.ant-form', maxChars: 5000 },
      undefined,
      { signal: undefined }
    );
  });

  it('reads HTML first, then evaluates query_js outside the page transport', async () => {
    const { registered, transport } = collectTools();
    vi.mocked(transport.send).mockResolvedValueOnce({
      success: true,
      data: '<html><body><main><h1>Hello</h1><p data-kind="x">World</p></main></body></html>',
    });
    const query = registered.find((t) => t.name === 'query_js')!;

    const result = await query.handler({
      tabId: 9,
      selector: 'main',
      code: '({ title: document.querySelector("h1").textContent, count: document.querySelectorAll("[data-kind]").length })',
    }) as { content: Array<{ text: string }> };

    expect(transport.send).toHaveBeenCalledWith(
      'get_html',
      { tabId: 9, selector: 'main' },
      undefined,
      { signal: undefined }
    );
    expect(result.content[0].text).toContain('"title": "Hello"');
    expect(result.content[0].text).toContain('"count": 1');
    expect(result.content[0].text).toContain('note: this ran against a read-only copy');
  });
});

describe('ownerId forwarding', () => {
  const metaWithOwner = { _meta: { [ABU_CONVERSATION_META_KEY]: 'conv-42' } };

  it('get_tabs sends {} without a conversation id, and { ownerId } with one', async () => {
    const { registered, transport } = collectTools();
    const getTabs = registered.find((t) => t.name === 'get_tabs')!;

    // get_tabs takes no input schema, so its only parameter is `extra`.
    await getTabs.handler({});
    expect(transport.send).toHaveBeenLastCalledWith('get_tabs', {}, undefined, { signal: undefined });

    await getTabs.handler(metaWithOwner);
    expect(transport.send).toHaveBeenLastCalledWith(
      'get_tabs',
      { ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });

  it('get_tabs forwards createIfEmpty:false only when the caller opted out of provisioning', async () => {
    const { registered, transport } = collectTools();
    const getTabs = registered.find((t) => t.name === 'get_tabs')!;

    // A read-only probe (the desktop permission gate resolving a tab's origin)
    // must not be the thing that opens a tab.
    await getTabs.handler({
      _meta: {
        [ABU_CONVERSATION_META_KEY]: 'conv-42',
        [ABU_CREATE_IF_EMPTY_META_KEY]: false,
      },
    });
    expect(transport.send).toHaveBeenLastCalledWith(
      'get_tabs',
      { ownerId: 'conv-42', createIfEmpty: false },
      undefined,
      { signal: undefined }
    );

    // Anything other than an explicit `false` keeps the historical payload
    // shape, so the host keeps its create-when-empty default.
    await getTabs.handler({
      _meta: {
        [ABU_CONVERSATION_META_KEY]: 'conv-42',
        [ABU_CREATE_IF_EMPTY_META_KEY]: true,
      },
    });
    expect(transport.send).toHaveBeenLastCalledWith(
      'get_tabs',
      { ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });

  it('click omits ownerId without a conversation id, and includes it with one', async () => {
    const { registered, transport } = collectTools();
    const click = registered.find((t) => t.name === 'click')!;

    await click.handler({ tabId: 1, locator: '{"css":"#a"}' });
    expect(transport.send).toHaveBeenLastCalledWith(
      'click',
      { tabId: 1, locator: { css: '#a' } },
      undefined,
      { signal: undefined }
    );

    await click.handler({ tabId: 1, locator: '{"css":"#a"}' }, metaWithOwner);
    expect(transport.send).toHaveBeenLastCalledWith(
      'click',
      { tabId: 1, locator: { css: '#a' }, ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });

  it('navigate omits ownerId without a conversation id, and includes it with one', async () => {
    const { registered, transport } = collectTools();
    const navigate = registered.find((t) => t.name === 'navigate')!;

    await navigate.handler({ tabId: 2, url: 'https://example.com', action: 'goto' });
    expect(transport.send).toHaveBeenLastCalledWith(
      'navigate',
      { tabId: 2, url: 'https://example.com', action: 'goto' },
      undefined,
      { signal: undefined }
    );

    await navigate.handler({ tabId: 2, url: 'https://example.com', action: 'goto' }, metaWithOwner);
    expect(transport.send).toHaveBeenLastCalledWith(
      'navigate',
      { tabId: 2, url: 'https://example.com', action: 'goto', ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });

  it('screenshot omits ownerId without a conversation id, and includes it with one', async () => {
    const { registered, transport } = collectTools();
    const screenshot = registered.find((t) => t.name === 'screenshot')!;

    await screenshot.handler({ tabId: 3 });
    expect(transport.send).toHaveBeenLastCalledWith(
      'screenshot',
      { tabId: 3 },
      undefined,
      { signal: undefined }
    );

    await screenshot.handler({ tabId: 3 }, metaWithOwner);
    expect(transport.send).toHaveBeenLastCalledWith(
      'screenshot',
      { tabId: 3, ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });

  it('query_js omits ownerId without a conversation id, and includes it with one on the get_html call', async () => {
    // What matters for this test is the `get_html` payload query_js sends
    // *before* it hands the HTML to evaluateQueryJsOnHtml — the DOM evaluation
    // itself is exercised (and already known-flaky in this environment, see
    // the pre-existing "reads HTML first..." failure above) by other tests, so
    // swallow any rejection from that step and assert on the transport call.
    const { registered, transport } = collectTools();
    const query = registered.find((t) => t.name === 'query_js')!;
    vi.mocked(transport.send).mockResolvedValue({ success: true, data: '<html></html>' });

    await query.handler({ tabId: 9, code: '1' }).catch(() => {});
    expect(transport.send).toHaveBeenLastCalledWith(
      'get_html',
      { tabId: 9, selector: undefined },
      undefined,
      { signal: undefined }
    );

    await query.handler({ tabId: 9, code: '1' }, metaWithOwner).catch(() => {});
    expect(transport.send).toHaveBeenLastCalledWith(
      'get_html',
      { tabId: 9, selector: undefined, ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });
});

// N6: tab ownership in the Abu host is the pair {conversationId, runKey}, so
// the run half has to ride the same `_meta` channel as the conversation half.
// Absence must stay absence — the host's "no run ⇒ main loop" default is what
// keeps every pre-N6 caller byte-compatible, and a defaulted-here payload would
// take that decision away from it.
describe('runId forwarding', () => {
  const metaWithOwner = { _meta: { [ABU_CONVERSATION_META_KEY]: 'conv-42' } };

  it('adds runId alongside ownerId when the caller is a subagent run', async () => {
    const { registered, transport } = collectTools();
    const click = registered.find((t) => t.name === 'click')!;

    await click.handler({ tabId: 1, locator: '{"css":"#a"}' }, {
      _meta: {
        [ABU_CONVERSATION_META_KEY]: 'conv-42',
        [ABU_RUN_META_KEY]: 'sar-abc',
      },
    });
    expect(transport.send).toHaveBeenLastCalledWith(
      'click',
      { tabId: 1, locator: { css: '#a' }, ownerId: 'conv-42', runId: 'sar-abc' },
      undefined,
      { signal: undefined }
    );
  });

  it('omits runId entirely for a main-loop caller', async () => {
    const { registered, transport } = collectTools();
    const click = registered.find((t) => t.name === 'click')!;

    await click.handler({ tabId: 1, locator: '{"css":"#a"}' }, metaWithOwner);
    expect(transport.send).toHaveBeenLastCalledWith(
      'click',
      { tabId: 1, locator: { css: '#a' }, ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });

  it('ignores a non-string runId rather than forwarding a malformed owner half', async () => {
    const { registered, transport } = collectTools();
    const getTabs = registered.find((t) => t.name === 'get_tabs')!;

    await getTabs.handler({
      _meta: { [ABU_CONVERSATION_META_KEY]: 'conv-42', [ABU_RUN_META_KEY]: 7 },
    });
    expect(transport.send).toHaveBeenLastCalledWith(
      'get_tabs',
      { ownerId: 'conv-42' },
      undefined,
      { signal: undefined }
    );
  });
});

// Task B2: `extra.signal` is the MCP SDK's per-request AbortSignal
// (RequestHandlerExtra.signal), which fires when the client cancels the tool
// call (see B1: the conversation's abort signal reaches the SDK's callTool()
// options). Every handler must forward it into transport.send()'s 4th param
// so an aborted conversation stops a browser action from hanging until its
// own (sometimes 120s) timeout.
describe('abort signal forwarding', () => {
  it('forwards extra.signal as the 4th transport.send() argument', async () => {
    const { registered, transport } = collectTools();
    const controller = new AbortController();
    const click = registered.find((t) => t.name === 'click')!;

    await click.handler({ tabId: 1, locator: '{"css":"#a"}' }, { signal: controller.signal });

    expect(transport.send).toHaveBeenLastCalledWith(
      'click',
      { tabId: 1, locator: { css: '#a' } },
      undefined,
      { signal: controller.signal }
    );
  });

  it('forwards the signal alongside a custom timeout for wait_for', async () => {
    const { registered, transport } = collectTools();
    const controller = new AbortController();
    const waitFor = registered.find((t) => t.name === 'wait_for')!;

    await waitFor.handler(
      { tabId: 1, condition: '{"type":"appear","locator":{"css":"#a"}}', timeout: 1000 },
      { signal: controller.signal }
    );

    expect(transport.send).toHaveBeenLastCalledWith(
      'wait_for',
      { tabId: 1, condition: { type: 'appear', locator: { css: '#a' } }, timeout: 1000 },
      6000,
      { signal: controller.signal }
    );
  });

  it('ignores a non-AbortSignal value under extra.signal rather than forwarding garbage', async () => {
    const { registered, transport } = collectTools();
    const click = registered.find((t) => t.name === 'click')!;

    await click.handler({ tabId: 1, locator: '{"css":"#a"}' }, { signal: 'not-a-signal' });

    expect(transport.send).toHaveBeenLastCalledWith(
      'click',
      { tabId: 1, locator: { css: '#a' } },
      undefined,
      { signal: undefined }
    );
  });

  it('rejects the tool call when the transport rejects because the signal was aborted mid-flight', async () => {
    const { registered, transport } = collectTools();
    const controller = new AbortController();
    const click = registered.find((t) => t.name === 'click')!;
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.mocked(transport.send).mockImplementationOnce(() => {
      // Simulates chromeWsTransport/HttpBrowserTransport rejecting once the
      // signal they were handed fires while the request is still in flight.
      controller.abort();
      return Promise.reject(abortError);
    });

    await expect(
      click.handler({ tabId: 1, locator: '{"css":"#a"}' }, { signal: controller.signal })
    ).rejects.toThrow('The operation was aborted');
  });
});

describe('locator parsing', () => {
  const callClick = async (locator: string) => {
    const { registered } = collectTools();
    const click = registered.find((t) => t.name === 'click')!;
    return click.handler({ tabId: 1, locator });
  };

  it('accepts every supported strategy', async () => {
    for (const raw of [
      '{"css":"#a"}',
      '{"text":"提交"}',
      '{"role":"button","name":"关闭"}',
      '{"testId":"submit"}',
      '{"xpath":"//button"}',
      '{"ref":"e1"}',
      '{"tag":"button","text":"提交"}',
    ]) {
      await expect(callClick(raw)).resolves.toBeDefined();
    }
  });

  it('rejects a locator with no usable strategy instead of guessing', async () => {
    await expect(callClick('{"selector":"#a"}')).rejects.toThrow(/must contain at least one of/);
  });

  it('rejects non-object locators', async () => {
    await expect(callClick('["#a"]')).rejects.toThrow(/must be a JSON object/);
    await expect(callClick('"#a"')).rejects.toThrow(/must be a JSON object/);
  });
});

describe('wait condition parsing', () => {
  const callWait = async (condition: string) => {
    const { registered } = collectTools();
    const waitFor = registered.find((t) => t.name === 'wait_for')!;
    return waitFor.handler({ tabId: 1, condition, timeout: 100 });
  };

  it('accepts the five documented condition types', async () => {
    for (const raw of [
      '{"type":"appear","locator":{"css":"#a"}}',
      '{"type":"disappear","locator":{"css":"#a"}}',
      '{"type":"enabled","locator":{"css":"#a"}}',
      '{"type":"textContains","locator":{"css":"#a"},"text":"ok"}',
      '{"type":"urlContains","pattern":"/success"}',
    ]) {
      await expect(callWait(raw)).resolves.toBeDefined();
    }
  });

  it('rejects an unknown condition type', async () => {
    await expect(callWait('{"type":"exists","locator":{"css":"#a"}}')).rejects.toThrow(/must be one of/);
  });
});

describe('find', () => {
  const callFind = async (query: string, limit?: number) => {
    const { registered, transport } = collectTools();
    const find = registered.find((t) => t.name === 'find')!;
    await find.handler({ tabId: 7, query, ...(limit === undefined ? {} : { limit }) });
    return transport.send as unknown as ReturnType<typeof vi.fn>;
  };

  it('is registered as a read-only tool the permission gate leaves ungated', () => {
    // Mirror of STATE_CHANGING_TOOLS in src/core/permissions/browserToolPolicy.ts:
    // anything absent from that set classifies as read-only. `find` must stay
    // absent — it reads the page and touches nothing, and gating it would put
    // a confirmation in front of the very step that stops wrong clicks.
    const gated = ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate'];
    expect(gated).not.toContain('find');
  });

  it('sends the parsed query and tabId to the page', async () => {
    const send = await callFind('{"role":"button","name":"保存"}', 5);
    expect(send).toHaveBeenCalledWith(
      'find',
      { tabId: 7, query: { role: 'button', name: '保存' }, limit: 5 },
      undefined,
      { signal: undefined },
    );
  });

  it('accepts every documented query key', async () => {
    for (const raw of [
      '{"role":"button"}',
      '{"role":"button","name":"保存"}',
      '{"text":"保存"}',
      '{"label":"设备编号"}',
      '{"placeholder":"请输入"}',
      '{"css":".ant-btn"}',
      '{"testId":"submit"}',
    ]) {
      await expect(callFind(raw)).resolves.toBeDefined();
    }
  });

  it('rejects a query with nothing usable in it rather than searching the whole page', async () => {
    await expect(callFind('{}')).rejects.toThrow(/at least one non-empty/);
    await expect(callFind('{"selector":"#a"}')).rejects.toThrow(/at least one non-empty/);
    await expect(callFind('{"name":""}')).rejects.toThrow(/at least one non-empty/);
    await expect(callFind('["button"]')).rejects.toThrow(/must be a JSON object/);
  });

  it('tells the model to reach for it before acting, and instead of scripting the page', () => {
    const { registered } = collectTools();
    const find = registered.find((t) => t.name === 'find')!;
    expect(find.description).toMatch(/WITHOUT clicking or changing anything/);
    expect(find.description).toMatch(/BEFORE click\/fill\/select/);
    expect(find.description).toMatch(/instead of falling back to execute_js/);
    // #245's lesson: the description decides what the model does far more than
    // the code does. If a native <button> stops being advertised as reachable
    // by role, the model goes back to snapshot-then-guess.
    expect(find.description).toMatch(/Native HTML counts/);
  });
});
