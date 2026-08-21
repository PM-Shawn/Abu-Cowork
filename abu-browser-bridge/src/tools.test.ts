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
import { registerTools, type BrowserTransport } from './tools.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
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
    send: vi.fn(async () => ({ ok: true, data: {} })),
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
      'get_downloads',
      'get_tabs',
      'keyboard',
      'navigate',
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
    expect(js.description).toMatch(/extract_text/);
    expect(js.description).toMatch(/select/);
  });

  it('forwards the snapshot scoping options to the page', async () => {
    const { registered, transport } = collectTools();
    const snapshot = registered.find((t) => t.name === 'snapshot')!;

    await snapshot.handler({ tabId: 7, selector: '.ant-form', maxChars: 5000 });

    expect(transport.send).toHaveBeenCalledWith('snapshot', {
      tabId: 7,
      selector: '.ant-form',
      maxChars: 5000,
    });
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
