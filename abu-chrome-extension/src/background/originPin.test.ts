/**
 * I2 — the origin pin for the ONE state-changing action on the extension
 * channel that never reaches the content script.
 *
 * `execute_js` runs through `chrome.scripting.executeScript` in this worker,
 * so the content script's own `assertOriginPin` cannot see it — and it is the
 * strongest capability of the set (arbitrary code with the page's full
 * authority in the user's real logged-in Chrome). It is pinned here against
 * the tab's LIVE url instead.
 *
 * The module registers `chrome.*` listeners at load, so the stub below has to
 * exist before the import. Only the surface the module touches at load time is
 * stubbed — `assertTabOriginPin` itself takes an injectable `getTab`, which is
 * what keeps these cases free of chrome plumbing.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const APPROVED = 'https://shop.example.com';

type AssertTabOriginPin = (
  tabId: number,
  payload: Record<string, unknown>,
  getTab?: (id: number) => Promise<{ url?: string }>,
) => Promise<void>;

let assertTabOriginPin: AssertTabOriginPin;
let normalizedOrigin: (href: string | undefined) => string | null;

beforeAll(async () => {
  const noopListener = { addListener: () => {} };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: { get: () => {}, set: () => {} } },
    tabs: { onActivated: noopListener, onRemoved: noopListener, onUpdated: noopListener },
    windows: { onFocusChanged: noopListener },
    downloads: { onCreated: noopListener, onChanged: noopListener },
    runtime: { onMessage: noopListener, lastError: undefined },
    alarms: { create: () => {}, onAlarm: noopListener },
    scripting: {},
  };
  const mod = await import('./index');
  assertTabOriginPin = mod.assertTabOriginPin;
  normalizedOrigin = mod.normalizedOrigin;
});

/** A tab that reports `url`; `null` models a tab whose url cannot be read. */
const tabAt = (url: string | null) => async () =>
  url === null ? Promise.reject(new Error('no such tab')) : { url };

describe('assertTabOriginPin (execute_js on the extension channel)', () => {
  it('passes when the tab is still on the approved origin', async () => {
    await expect(
      assertTabOriginPin(1, { unattended: true, expectedOrigin: APPROVED }, tabAt(`${APPROVED}/cart`)),
    ).resolves.toBeUndefined();
  });

  it('refuses after the tab drifted cross-origin, naming both ends', async () => {
    await expect(
      assertTabOriginPin(
        1,
        { unattended: true, expectedOrigin: APPROVED },
        tabAt('https://evil.example.com/'),
      ),
    ).rejects.toThrow(/no longer on the page this action was approved for.*https:\/\/evil\.example\.com/s);
  });

  it('treats a same-origin path change as no drift', async () => {
    await expect(
      assertTabOriginPin(
        1,
        { unattended: true, expectedOrigin: APPROVED },
        tabAt(`${APPROVED}/cart/step-2?x=1`),
      ),
    ).resolves.toBeUndefined();
  });

  it('fail-closed: an unattended call with no approved origin is refused', async () => {
    await expect(
      assertTabOriginPin(1, { unattended: true }, tabAt(`${APPROVED}/cart`)),
    ).rejects.toThrow(/sent no approved origin/);
  });

  it('an ATTENDED call is compared too (I3)', async () => {
    await expect(
      assertTabOriginPin(1, { expectedOrigin: APPROVED }, tabAt('https://evil.example.com/')),
    ).rejects.toThrow(/no longer on the page/);
  });

  it('an attended call carrying NO pin keeps its exact pre-U5 path', async () => {
    await expect(
      assertTabOriginPin(1, {}, tabAt('https://evil.example.com/')),
    ).resolves.toBeUndefined();
  });

  it('a tab whose url cannot be read is a mismatch, not a pass', async () => {
    await expect(
      assertTabOriginPin(1, { unattended: true, expectedOrigin: APPROVED }, tabAt(null)),
    ).rejects.toThrow(/an unknown page/);
  });
});

describe('normalizedOrigin agrees with the other ends of the pin', () => {
  it('strips a trailing FQDN dot, so one spelling cannot dodge the other', () => {
    expect(normalizedOrigin('https://shop.example.com./cart')).toBe(APPROVED);
  });

  it('drops a default port and keeps a non-default one', () => {
    expect(normalizedOrigin('https://shop.example.com:443/x')).toBe(APPROVED);
    expect(normalizedOrigin('https://shop.example.com:8443/x')).toBe('https://shop.example.com:8443');
  });

  it('returns null for non-http(s) and unparseable input', () => {
    expect(normalizedOrigin('about:blank')).toBeNull();
    expect(normalizedOrigin('not a url')).toBeNull();
    expect(normalizedOrigin(undefined)).toBeNull();
  });
});

/**
 * Three ends now speak the refusal: the Electron host, the extension's content
 * script, and this worker. A model that has to learn two dialects of the same
 * refusal will treat one of them as a novel error and retry into it, so the
 * sentences are pinned identical here rather than left to convention.
 */
describe('the refusal reads the same on every channel', () => {
  const SENTENCES = [
    'no longer on the page this action was approved for (approved ',
    'Take a fresh snapshot to re-read the current state before acting again; the earlier ',
    'sent no approved origin for the page, so the action could not be ',
  ];
  const SOURCES: Array<[string, URL]> = [
    ['electron/browserHost.cjs', new URL('../../../electron/browserHost.cjs', import.meta.url)],
    ['content/index.ts', new URL('../content/index.ts', import.meta.url)],
    ['background/index.ts', new URL('./index.ts', import.meta.url)],
  ];

  for (const [label, url] of SOURCES) {
    for (const sentence of SENTENCES) {
      it(`${label} carries: ${sentence.slice(0, 34)}…`, async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        expect(readFileSync(fileURLToPath(url), 'utf8')).toContain(sentence);
      });
    }
  }
});
