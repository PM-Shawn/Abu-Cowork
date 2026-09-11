import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parentPort as rawParentPort, workerData as rawWorkerData } from 'node:worker_threads';
import 'ses';

const parentPort = rawParentPort;
const workerData = rawWorkerData;
const MAX_STRING_CHARS = 20_000;

function bundledLinkedomIifeSource() {
  return typeof __ABU_BUNDLED_LINKEDOM_WORKER_IIFE_SOURCE__ === 'string'
    ? __ABU_BUNDLED_LINKEDOM_WORKER_IIFE_SOURCE__
    : '';
}

function stripAmbientAuthority() {
  for (const name of [
    'process',
    'fetch',
    'WebSocket',
    'EventSource',
    'BroadcastChannel',
    'MessageChannel',
    'MessagePort',
    'Worker',
    'SharedWorker',
    'importScripts',
    'require',
    'getBuiltinModule',
  ]) {
    Reflect.deleteProperty(globalThis, name);
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    } catch {
      /* already non-configurable */
    }
  }
}

async function readLinkedomIifeSource() {
  const bundled = bundledLinkedomIifeSource();
  if (bundled) return bundled;
  try {
    return readFileSync(new URL('./linkedomWorker.iife.js', import.meta.url), 'utf8');
  } catch {
    const { build } = await import('esbuild');
    const result = await build({
      // fileURLToPath, not URL.pathname: the latter yields "/D:/..." on
      // Windows, which esbuild cannot resolve.
      entryPoints: [fileURLToPath(new URL('../node_modules/linkedom/worker.js', import.meta.url))],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'LinkeDOM',
      target: 'es2022',
      legalComments: 'none',
      logLevel: 'silent',
    });
    return result.outputFiles[0].text;
  }
}

function guestBootstrapSource(linkedomIifeSource) {
  const sesSafeIifeSource = linkedomIifeSource
    .replaceAll('<!--', '<\\x21--')
    .replaceAll('-->', '--\\x3e')
    .replace(/^\s*var LinkeDOM =/u, 'globalThis.LinkeDOM =');
  return `
    globalThis.console = harden({
      log() {},
      info() {},
      warn() {},
      error() {},
    });
    globalThis.atob = harden((input) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      let str = String(input).replace(/[\\t\\n\\f\\r ]+/g, '');
      if (str.length % 4 === 1) throw new Error('Invalid base64 input');
      let output = '';
      for (let block = 0, charCode = 0, idx = 0, map = chars; str.charAt(idx | 0) || (map = '=', idx % 1); output += String.fromCharCode(255 & block >> (-2 * idx & 6))) {
        const next = map.indexOf(str.charAt(idx += 3 / 4));
        if (next < 0) throw new Error('Invalid base64 input');
        block = block << 6 | next;
      }
      return output;
    });
    ${sesSafeIifeSource}
    globalThis.LinkeDOM = harden(globalThis.LinkeDOM);
    globalThis.__ABU_PARSE_HTML__ = harden((html) => {
      const view = globalThis.LinkeDOM.parseHTML(html);
      globalThis.document = view.document;
      return true;
    });
  `;
}

const guestSerializerSource = `
  (() => {
    const MAX_DEPTH = 8;
    const MAX_ARRAY_ITEMS = 2000;
    const MAX_OBJECT_KEYS = 200;
    const MAX_STRING_CHARS = ${MAX_STRING_CHARS};
    const trimString = (value) => value.length > MAX_STRING_CHARS
      ? value.slice(0, MAX_STRING_CHARS) + '...[truncated ' + (value.length - MAX_STRING_CHARS) + ' chars]'
      : value;
    const isDomNode = (value) => value && typeof value === 'object' && typeof value.nodeType === 'number';
    const isArrayLike = (value) => (
      value &&
      typeof value === 'object' &&
      typeof value.length === 'number' &&
      Number.isInteger(value.length) &&
      value.length >= 0 &&
      value.length <= 100000 &&
      typeof value !== 'function'
    );
    const domNodeToJson = (value) => {
      const text = typeof value.textContent === 'string' ? value.textContent.trim() : '';
      return {
        nodeType: value.nodeType,
        tagName: typeof value.tagName === 'string' ? value.tagName.toLowerCase() : undefined,
        id: typeof value.id === 'string' && value.id ? value.id : undefined,
        className: typeof value.className === 'string' && value.className ? value.className : undefined,
        textContent: trimString(text),
        outerHTML: typeof value.outerHTML === 'string' ? trimString(value.outerHTML) : undefined,
      };
    };
    const convert = (value, seen = new WeakSet(), depth = 0) => {
      if (value === null || value === undefined) return value ?? null;
      if (typeof value === 'string') return trimString(value);
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'symbol' || typeof value === 'function') return String(value);
      if (typeof value.then === 'function') {
        throw new TypeError('query_js only supports synchronous completion values');
      }
      if (depth >= MAX_DEPTH) return '[Max depth reached]';
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      if (isDomNode(value)) return domNodeToJson(value);
      if (Array.isArray(value) || isArrayLike(value)) {
        const out = Array.from(value).slice(0, MAX_ARRAY_ITEMS).map((item) => convert(item, seen, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) out.push('[Truncated ' + (value.length - MAX_ARRAY_ITEMS) + ' items]');
        return out;
      }
      if (value instanceof Map) {
        return Array.from(value.entries())
          .slice(0, MAX_OBJECT_KEYS)
          .map(([key, item]) => [convert(key, seen, depth + 1), convert(item, seen, depth + 1)]);
      }
      if (value instanceof Set) {
        return Array.from(value.values()).slice(0, MAX_ARRAY_ITEMS).map((item) => convert(item, seen, depth + 1));
      }
      const out = {};
      const keys = Object.keys(value);
      for (const key of keys.slice(0, MAX_OBJECT_KEYS)) out[key] = convert(value[key], seen, depth + 1);
      const extra = keys.length - MAX_OBJECT_KEYS;
      if (extra > 0) out.__truncatedKeys = extra;
      return out;
    };
    return JSON.stringify(convert(globalThis.__ABU_QUERY_RESULT__), null, 2);
  })()
`;

async function main() {
  const { html, code } = workerData || {};
  if (typeof html !== 'string') throw new Error('query_js worker requires HTML');
  if (typeof code !== 'string' || !code.trim()) throw new Error('query_js requires code');

  const linkedomIifeSource = await readLinkedomIifeSource();
  stripAmbientAuthority();
  lockdown();

  // No host object or function is endowed. The DOM library, inert console,
  // document, user code, and result serializer all originate in this realm.
  const compartment = new Compartment({});
  compartment.evaluate(guestBootstrapSource(linkedomIifeSource));
  compartment.globalThis.__ABU_PARSE_HTML__(html);
  compartment.globalThis.__ABU_PARSE_HTML__ = undefined;
  compartment.globalThis.LinkeDOM = undefined;
  compartment.globalThis.atob = undefined;

  // Deliberately do not await a guest Promise/thenable: promise assimilation
  // would hand host-realm resolve/reject callbacks into guest code. DOM reads
  // are synchronous, and the serializer rejects async completion values.
  const result = compartment.evaluate(code);
  compartment.globalThis.__ABU_QUERY_RESULT__ = result;
  const json = compartment.evaluate(guestSerializerSource);
  compartment.globalThis.__ABU_QUERY_RESULT__ = undefined;
  return json;
}

main()
  .then((json) => parentPort?.postMessage({ ok: true, json }))
  .catch((error) => {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  });
