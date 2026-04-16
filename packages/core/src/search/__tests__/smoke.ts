import assert from 'node:assert/strict';
import { MemoryFetchAdapter } from '../../mocks';
import {
  createBingProvider,
  createBraveProvider,
  createTavilyProvider,
  createSearXNGProvider,
  createSearchProvider,
} from '../providers';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
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

function jsonResp(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function main() {
  console.log('Search providers:');

  await test('Bing 解析 + 域名提取', async () => {
    const fetch = new MemoryFetchAdapter();
    fetch.on(/bing\.microsoft\.com/, () =>
      jsonResp({
        webPages: {
          value: [
            {
              name: 'A',
              url: 'https://www.example.com/page',
              snippet: 's',
              datePublished: '2026-01-01',
            },
          ],
        },
      })
    );
    const p = createBingProvider(fetch, 'k');
    const r = await p.search('q', { count: 5, market: 'zh-CN' });
    assert.equal(r.results[0].source, 'example.com');
    assert.equal(r.results[0].publishedDate, '2026-01-01');
  });

  await test('Brave 解析', async () => {
    const fetch = new MemoryFetchAdapter();
    fetch.on(/search\.brave\.com/, () =>
      jsonResp({ web: { results: [{ title: 't', url: 'https://b.io/x', description: 'd' }] } })
    );
    const r = await createBraveProvider(fetch, 'k').search('q', { count: 3, market: 'us' });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].source, 'b.io');
  });

  await test('Tavily POST 带 body', async () => {
    const fetch = new MemoryFetchAdapter();
    fetch.on(/tavily/, () =>
      jsonResp({ results: [{ title: 't', url: 'https://t.com', content: 'c' }] })
    );
    const r = await createTavilyProvider(fetch, 'k').search('q', { count: 2, market: 'x' });
    assert.equal(r.results[0].source, 't.com');
    assert.equal(fetch.calls[0].init?.method, 'POST');
  });

  await test('SearXNG 尊重 count 限制', async () => {
    const fetch = new MemoryFetchAdapter();
    fetch.on(/search/, () =>
      jsonResp({
        results: [
          { title: 'a', url: 'https://a.com', content: '' },
          { title: 'b', url: 'https://b.com', content: '' },
          { title: 'c', url: 'https://c.com', content: '' },
        ],
      })
    );
    const r = await createSearXNGProvider(fetch, 'https://s.local').search('q', {
      count: 2,
      market: '',
    });
    assert.equal(r.results.length, 2);
  });

  await test('工厂按 type 选 provider', async () => {
    const fetch = new MemoryFetchAdapter();
    const p = createSearchProvider(fetch, 'tavily', 'k');
    assert.ok(typeof p.search === 'function');
  });

  await test('HTTP 错误抛出', async () => {
    const fetch = new MemoryFetchAdapter();
    fetch.on(/bing/, () => new Response('quota exceeded', { status: 403 }));
    const p = createBingProvider(fetch, 'k');
    await assert.rejects(p.search('q', { count: 1, market: 'us' }), /403/);
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
