import { describe, expect, it } from 'vitest';
import {
  QUERY_JS_READONLY_NOTE,
  QUERY_JS_WORKER_RESOURCE_LIMITS,
  evaluateQueryJsOnHtml,
} from './queryJs.js';

const html = `
  <html>
    <body>
      <main id="root">
        <h1>Report</h1>
        <button data-action="save">Save</button>
        <ul>
          <li data-id="a">Alpha</li>
          <li data-id="b">Beta</li>
        </ul>
      </main>
    </body>
  </html>
`;

describe('evaluateQueryJsOnHtml', () => {
  it('configures bounded worker heap and stack limits', () => {
    expect(QUERY_JS_WORKER_RESOURCE_LIMITS).toEqual({
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      codeRangeSizeMb: 16,
      stackSizeMb: 4,
    });
  });

  it('reads structured data from the detached DOM copy', async () => {
    const result = await evaluateQueryJsOnHtml(
      html,
      `({
        heading: document.querySelector('h1').textContent,
        ids: [...document.querySelectorAll('li')].map((node) => node.getAttribute('data-id')),
        button: document.querySelector('button')
      })`,
    );

    expect(result).toContain('"heading": "Report"');
    expect(result).toContain('"ids"');
    expect(result).toContain('"tagName": "button"');
    expect(result).toContain(QUERY_JS_READONLY_NOTE);
  });

  it('allows mutations only inside the disposable copy', async () => {
    const changed = await evaluateQueryJsOnHtml(
      html,
      `document.querySelector('h1').textContent = 'Changed';
       document.querySelector('h1').textContent`,
    );
    const fresh = await evaluateQueryJsOnHtml(html, `document.querySelector('h1').textContent`);

    expect(changed).toContain('"Changed"');
    expect(fresh).toContain('"Report"');
  });

  it('rejects HTML over the configured limit with selector guidance', async () => {
    await expect(
      evaluateQueryJsOnHtml('<main>too wide</main>', '1', { htmlLimitBytes: 8 }),
    ).rejects.toThrow(/Pass `selector`/);
  });

  it('truncates oversized output and keeps the read-only note', async () => {
    const result = await evaluateQueryJsOnHtml(
      '<main></main>',
      '`' + 'x'.repeat(500) + '`',
      { outputLimitChars: 220 },
    );

    expect(result.length).toBeLessThanOrEqual(220);
    expect(result).toContain('[Truncated: output exceeded 220 characters');
    expect(result).toContain(QUERY_JS_READONLY_NOTE);
  });

  it('terminates infinite loops in the worker', async () => {
    await expect(
      evaluateQueryJsOnHtml(html, 'while (true) {}', { timeoutMs: 100 }),
    ).rejects.toThrow(/query_js timed out/);
  });

  it('does not expose Node or network globals through common escape routes', async () => {
    const result = await evaluateQueryJsOnHtml(
      html,
      `({
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        fetch: typeof globalThis.fetch,
        fs: typeof globalThis.fs,
        getBuiltinModule: typeof globalThis.getBuiltinModule,
        LinkeDOM: typeof globalThis.LinkeDOM,
        bootstrapAtob: typeof globalThis.atob,
        hardenCtorEscape: (() => {
          try { return harden.constructor('return globalThis')() === globalThis; }
          catch (error) { return error.name + ': ' + error.message; }
        })(),
        consoleCtorEscape: (() => {
          try { return console.log.constructor('return globalThis')() === globalThis; }
          catch (error) { return error.name + ': ' + error.message; }
        })(),
        defaultViewProcess: typeof document.defaultView.process,
        defaultViewFetch: typeof document.defaultView.fetch,
        rebuiltProcess: (() => {
          try { return typeof (new document.constructor()).defaultView.process; }
          catch (error) { return error.name + ': ' + error.message; }
        })(),
        documentCtorEscape: (() => {
          try { return document.constructor.constructor('return process')(); }
          catch (error) { return error.name + ': ' + error.message; }
        })(),
        domMethodCtorEscape: (() => {
          try { return document.querySelector.constructor('return process')(); }
          catch (error) { return error.name + ': ' + error.message; }
        })(),
        functionEscape: (() => {
          try { return Function('return globalThis.process')(); }
          catch (error) { return error.name + ': ' + error.message; }
        })()
      })`,
    );

    expect(result).toContain('"process": "undefined"');
    expect(result).toContain('"require": "undefined"');
    expect(result).toContain('"fetch": "undefined"');
    expect(result).toContain('"fs": "undefined"');
    expect(result).toContain('"getBuiltinModule": "undefined"');
    expect(result).toContain('"LinkeDOM": "undefined"');
    expect(result).toContain('"bootstrapAtob": "undefined"');
    expect(result).toMatch(/"hardenCtorEscape": "TypeError: .*not a valid constructor/);
    expect(result).toMatch(/"consoleCtorEscape": "TypeError: .*not a valid constructor/);
    expect(result).toContain('"defaultViewProcess": "undefined"');
    expect(result).toContain('"defaultViewFetch": "undefined"');
    expect(result).toContain('"rebuiltProcess": "undefined"');
    expect(result).toContain('not a valid constructor');
    expect(result).toContain('"functionEscape": null');
  });

  it('rejects direct eval and dynamic import syntax', async () => {
    await expect(evaluateQueryJsOnHtml(html, 'eval("1 + 1")')).rejects.toThrow(/SES_EVAL_REJECTED/);
    await expect(evaluateQueryJsOnHtml(html, 'import("node:fs")')).rejects.toThrow(/SES_IMPORT_REJECTED/);
  });

  it('rejects Promise and thenable results instead of crossing guest callbacks into the host', async () => {
    await expect(evaluateQueryJsOnHtml(html, 'Promise.resolve(1)')).rejects.toThrow(
      /only supports synchronous completion values/,
    );
    await expect(
      evaluateQueryJsOnHtml(html, '({ then(resolve) { resolve(1); } })'),
    ).rejects.toThrow(/only supports synchronous completion values/);
  });

  it('does not let prototype pollution escape a query', async () => {
    await evaluateQueryJsOnHtml(html, `Object.prototype.polluted = 'yes'; 'done'`).catch(() => undefined);
    const result = await evaluateQueryJsOnHtml(html, `({ polluted: Object.prototype.polluted ?? null })`);

    expect(result).toContain('"polluted": null');
  });
});
