/**
 * R2 (U4 re-review) — the browser-denial reporters must be stripped BY NAME
 * before a tool context crosses the sidecar wire.
 *
 * They already never arrived on the other side: `JSON.stringify` drops
 * function-valued properties, so the two `toWireToolContext` helpers appeared
 * to work. That is an incident, not a boundary. `reportBrowserDenial` /
 * `reportBrowserAllow` are a SHELL-OWNED authorization seam — the shell
 * re-stamps them from its own RunSession on every inbound context precisely so
 * a sidecar cannot report into the run's abort counter — and the moment either
 * one became a serializable value (a token, an id, an options object) it would
 * silently start travelling, with nothing failing.
 *
 * `toWireToolContext` is private in both hosts, and exporting an internal
 * helper only to test it would be its own smell, so this pins the source: both
 * destructuring lists must name both fields.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOSTS = ['agentLoopHost.ts', 'subagentHost.ts'] as const;
const STRIPPED = ['reportBrowserDenial', 'reportBrowserAllow'] as const;

describe('toWireToolContext strips the local-only reporters explicitly', () => {
  for (const host of HOSTS) {
    const source = readFileSync(fileURLToPath(new URL(`./${host}`, import.meta.url)), 'utf8');
    const body = /function toWireToolContext\([\s\S]*?\n}/.exec(source)?.[0];

    it(`${host} has a toWireToolContext to inspect`, () => {
      expect(body).toBeTruthy();
    });

    for (const field of STRIPPED) {
      it(`${host} names ${field} in the destructuring, not just relying on JSON.stringify`, () => {
        expect(body).toContain(`${field}: _${field}`);
      });
    }
  }
});
