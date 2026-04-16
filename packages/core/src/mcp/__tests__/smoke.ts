import assert from 'node:assert/strict';
import {
  MemoryProcessAdapter,
  MemoryFetchAdapter,
  MemoryLoggerAdapter,
  FakeClockAdapter,
} from '../../mocks';
import { MCPClientManager, StdioProcessTransport, expandConfigEnvVars } from '../index';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

async function main() {
  console.log('mcp POC:');

  await test('envExpansion 基本替换', () => {
    const r = expandConfigEnvVars(
      {
        command: '${BIN}',
        args: ['--token=${TOKEN}', '--fallback=${MISSING:-default}'],
        env: { NODE_ENV: '${NODE_ENV:-production}' },
      },
      { BIN: '/usr/bin/node', TOKEN: 'abc' }
    );
    assert.equal(r.command, '/usr/bin/node');
    assert.equal(r.args?.[0], '--token=abc');
    assert.equal(r.args?.[1], '--fallback=default');
    assert.equal(r.env?.NODE_ENV, 'production');
  });

  await test('StdioProcessTransport 启动子进程 + 收发 JSON-RPC', async () => {
    const process = new MemoryProcessAdapter();
    let capturedStdin = '';
    process.register('my-mcp-server', (h) => {
      h.onStdin((data) => {
        capturedStdin += data;
        // Echo back a response
        const msg = JSON.parse(data.trim());
        h.stdout(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\n'
        );
      });
    });

    const transport = new StdioProcessTransport(process, {
      command: 'my-mcp-server',
      args: [],
      env: {},
    });

    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);
    await transport.start();

    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(capturedStdin.includes('tools/list'));
    assert.equal(received.length, 1);
    assert.deepEqual((received[0] as { result: unknown }).result, { tools: [] });

    await transport.close();
  });

  await test('MCPClientManager 通过注入的 SDK connectServer', async () => {
    const process = new MemoryProcessAdapter();
    const fetch = new MemoryFetchAdapter();
    const logger = new MemoryLoggerAdapter();
    const clock = new FakeClockAdapter(1_700_000_000_000);

    // 模拟最小 MCP SDK Client
    class FakeClient {
      constructor(_info: unknown, _caps: unknown) {}
      async connect(_transport: unknown): Promise<void> {}
      async close(): Promise<void> {}
      async listTools() {
        return {
          tools: [
            {
              name: 'echo',
              description: 'echoes input',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        };
      }
      async callTool(params: { name: string; arguments: Record<string, unknown> }) {
        return { content: [{ type: 'text', text: `echo:${String(params.arguments.text)}` }] };
      }
    }

    const mgr = new MCPClientManager({
      process,
      fetch,
      logger,
      clock,
      sdk: { Client: FakeClient as unknown as typeof import('@modelcontextprotocol/sdk/client/index.js').Client },
    });

    // Register a no-op stdio process (we won't actually read its stdout; FakeClient doesn't use transport)
    process.register('fake-server', () => {});

    await mgr.connectServer({ name: 'testsvr', command: 'fake-server', args: [], env: {} });

    const tools = mgr.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'testsvr__echo');

    const result = await mgr.callTool('testsvr', 'echo', { text: 'hi' });
    assert.equal(result, 'echo:hi');

    await mgr.disconnectAll();
    assert.equal(mgr.getConnectedServers().length, 0);
  });

  await test('callTool 超时触发（FakeClock 驱动）', async () => {
    const process = new MemoryProcessAdapter();
    const fetch = new MemoryFetchAdapter();
    const logger = new MemoryLoggerAdapter();
    const clock = new FakeClockAdapter(0);

    class HangClient {
      constructor(_i: unknown, _c: unknown) {}
      async connect(): Promise<void> {}
      async close(): Promise<void> {}
      async listTools() {
        return {
          tools: [
            {
              name: 'slow',
              description: 's',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
          ],
        };
      }
      async callTool(): Promise<unknown> {
        return new Promise(() => {
          // never resolves
        });
      }
    }

    const mgr = new MCPClientManager({
      process,
      fetch,
      logger,
      clock,
      sdk: { Client: HangClient as unknown as typeof import('@modelcontextprotocol/sdk/client/index.js').Client },
    });
    process.register('hang-srv', () => {});
    await mgr.connectServer({
      name: 'h',
      command: 'hang-srv',
      args: [],
      env: {},
      timeout: 1000,
    });

    const promise = mgr.callTool('h', 'slow', {});
    // Advance fake clock past timeout
    clock.advance(2000);

    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'should have thrown');
    assert.ok(caught instanceof Error && /timed out/i.test(caught.message), `got: ${String(caught)}`);

    await mgr.disconnectAll();
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
