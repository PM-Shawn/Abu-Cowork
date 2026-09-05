/**
 * The two halves of `batch` validation must agree.
 *
 * A batch is checked twice, on purpose and in two packages that cannot import
 * each other:
 *
 *   src/core/permissions/browserToolPolicy.ts  — the GATE decides what to ask
 *                                                for, and what to refuse
 *   abu-browser-bridge/src/batch.ts            — the RUNNER decides what to
 *                                                actually put on the wire
 *
 * Two locks are the point (the gate must not depend on the runner to keep the
 * user's session safe), but two locks that disagree are a gap: a batch the
 * gate reads as "three harmless reads" and the runner reads as "and then a
 * click" would be a click nobody was asked about. So both are driven over the
 * same table of inputs here, and the same file pins that the origin each half
 * computes is the same origin — a batch that pinned a different origin than
 * the one the gate approved would be checking the wrong page.
 */

import { describe, expect, it } from 'vitest';
import { parseBatchSteps, batchOrigin, MAX_BATCH_STEPS } from '../../../abu-browser-bridge/src/batch.js';
import {
  MAX_BROWSER_BATCH_STEPS,
  classifyBrowserTool,
  normalizeBrowserOrigin,
  refuseBrowserBatch,
} from '../permissions/browserToolPolicy';

const BATCH = 'abu-browser__batch';

/** Does the RUNNER accept these steps? */
function runnerAccepts(steps: unknown): boolean {
  try {
    parseBatchSteps(steps);
    return true;
  } catch {
    return false;
  }
}

const CASES: Array<{ label: string; steps: unknown; accepted: boolean }> = [
  { label: 'a plain form fill', steps: [
    { action: 'fill', locator: { css: '#a' }, value: '1' },
    { action: 'click', locator: { css: '#go' } },
  ], accepted: true },
  { label: 'reads only', steps: [
    { action: 'find', query: { role: 'button' } },
    { action: 'read', selector: '#x' },
  ], accepted: true },
  { label: 'a scripting step', steps: [{ action: 'execute_js', code: '1' }], accepted: false },
  { label: 'a scripting step hidden among reads', steps: [
    { action: 'find', query: { role: 'button' } },
    { action: 'query_js', code: '1' },
  ], accepted: false },
  { label: 'a navigate step', steps: [{ action: 'navigate', url: 'https://x.example' }], accepted: false },
  { label: 'an unknown step type', steps: [{ action: 'hover', locator: { css: '#a' } }], accepted: false },
  { label: 'a step that is not an object', steps: ['click'], accepted: false },
  { label: 'a step with no action', steps: [{ locator: { css: '#a' } }], accepted: false },
  { label: 'an empty run', steps: [], accepted: false },
  { label: 'not a list at all', steps: { action: 'click' }, accepted: false },
  { label: 'one step too many', steps: Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({
    action: 'click', locator: { css: '#a' },
  })), accepted: false },
  { label: 'exactly the maximum', steps: Array.from({ length: MAX_BATCH_STEPS }, () => ({
    action: 'click', locator: { css: '#a' },
  })), accepted: true },
];

describe('the gate and the runner read a batch the same way', () => {
  it('agrees on the step ceiling', () => {
    expect(MAX_BROWSER_BATCH_STEPS).toBe(MAX_BATCH_STEPS);
  });

  it.each(CASES)('$label', ({ steps, accepted }) => {
    const gateRefusal = refuseBrowserBatch(BATCH, { steps });
    expect(gateRefusal === null).toBe(accepted);
    expect(runnerAccepts(steps)).toBe(accepted);
  });

  it.each(CASES)('$label — same verdict when the steps arrive as the JSON string the schema asks for', ({ steps, accepted }) => {
    const asString = JSON.stringify(steps);
    expect(refuseBrowserBatch(BATCH, { steps: asString }) === null).toBe(accepted);
    expect(runnerAccepts(asString)).toBe(accepted);
  });

  it('refuses on both sides when the JSON does not parse', () => {
    expect(refuseBrowserBatch(BATCH, { steps: '[{"action":' })).toBe('malformed');
    expect(runnerAccepts('[{"action":')).toBe(false);
  });
});

describe('the gate classifies what the runner will actually do', () => {
  it('calls a batch state-changing exactly when the runner would touch the page', () => {
    const pageTouching = ['fill', 'select', 'click', 'keyboard'];
    const looking = ['find', 'read', 'wait_for'];

    for (const action of pageTouching) {
      const steps = [{ action, locator: { css: '#a' }, value: 'v', key: 'Enter', query: { role: 'button' } }];
      expect(classifyBrowserTool(BATCH, { steps })).toBe('state-changing');
      expect(runnerAccepts(steps)).toBe(true);
    }
    for (const action of looking) {
      const steps = [{
        action,
        selector: '#a',
        query: { role: 'button' },
        condition: { type: 'appear', locator: { css: '#a' } },
      }];
      expect(classifyBrowserTool(BATCH, { steps })).toBe('read-only');
      expect(runnerAccepts(steps)).toBe(true);
    }
  });

  it('treats a batch it cannot read as state-changing, never as a free read', () => {
    for (const steps of [undefined, '[', '{}', [], [{ action: 'hover' }], [{}]]) {
      expect(classifyBrowserTool(BATCH, { steps })).toBe('state-changing');
    }
  });
});

describe('both halves pin the same origin', () => {
  it.each([
    'https://erp.example.com/form?a=1',
    'https://ERP.Example.COM./form',
    'https://user:pw@erp.example.com:443/form',
    'http://erp.example.com:8080/form',
    'http://127.0.0.1:5173/',
    'about:blank',
    'file:///tmp/x.html',
    'data:text/html,<b>x</b>',
    'not a url',
  ])('%s', (url) => {
    expect(batchOrigin(url)).toBe(normalizeBrowserOrigin(url));
  });
});
