/**
 * The dialog feature spans four packages that cannot import each other, and
 * three of the couplings between them are plain string/number duplication:
 *
 *   abu-browser-shared/types.ts   the shared constants (bridge + extension)
 *   electron/browserHost.cjs      a CommonJS MAIN-PROCESS module — it can
 *                                 import none of the above, so it redeclares
 *                                 the timeout, the untrusted notice and the
 *                                 refusal sentence
 *   browserSignals.ts             classifies a dialog-blocked failure by that
 *                                 refusal sentence
 *
 * Each of those drifting apart fails silently and differently: a changed
 * timeout makes the tool description lie about when a page is released; a
 * changed refusal sentence turns every dialog-blocked call into
 * `unknown_error` in the diagnostic bundle. `browserHost.cjs` is read as TEXT
 * (an Electron main module cannot be imported into vitest), with anchor
 * assertions so a refactor that breaks the parse fails here rather than
 * passing an empty match.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  JS_DIALOG_AUTO_DISMISS_MS,
  JS_DIALOG_UNTRUSTED_NOTICE,
} from '../../../abu-browser-shared/types';
import {
  DIALOG_BLOCKING_SENTENCE,
  classifyBrowserToolError,
  jsDialogSignals,
} from '../observability/browserSignals';
import { classifyBrowserTool } from '../permissions/browserToolPolicy';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST = fs.readFileSync(path.join(ROOT, 'electron/browserHost.cjs'), 'utf8');

function hostConstant(name: string): string {
  const match = new RegExp(`const ${name} =\\s*([\\s\\S]*?);\\n`).exec(HOST);
  expect(match, `browserHost.cjs no longer declares \`const ${name}\``).not.toBeNull();
  return match![1];
}

/** Rebuild a JS string literal (possibly `+`-concatenated across lines). */
function hostString(name: string): string {
  const raw = hostConstant(name);
  const parts = [...raw.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  expect(parts.length, `\`${name}\` in browserHost.cjs is not a string literal`).toBeGreaterThan(0);
  return parts.join('');
}

describe('the built-in browser and the shared contract agree', () => {
  it('waits exactly as long before dismissing a dialog as the tool descriptions promise', () => {
    expect(Number(hostConstant('DIALOG_AUTO_DISMISS_MS'))).toBe(JS_DIALOG_AUTO_DISMISS_MS);
  });

  it('wraps page-authored dialog text in the same sentence on both sides', () => {
    expect(hostString('DIALOG_UNTRUSTED_NOTICE')).toBe(JS_DIALOG_UNTRUSTED_NOTICE);
  });

  it('refuses a dialog-blocked action with the sentence the signal collector looks for', () => {
    expect(hostString('DIALOG_BLOCKING_PREFIX')).toBe(DIALOG_BLOCKING_SENTENCE);
  });

  it('routes both dialog actions in the built-in browser', () => {
    // Same anchor style as `browserToolRouting.test.ts`: read the real
    // branches, not a re-typed list.
    const branches = [...HOST.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]);
    expect(branches).toContain('get_dialog');
    expect(branches).toContain('handle_dialog');
    expect(branches).toContain('navigate');
  });
});

describe('a dialog-blocked failure is legible end to end', () => {
  // The exact string `dialogBlockedError()` builds, assembled from the host's
  // own constants so it cannot drift from what the runtime really sends.
  const refusal =
    `Error: ${DIALOG_BLOCKING_SENTENCE} the page opened (confirm). Nothing on this page runs `
    + 'until it is answered — no click, fill, snapshot or script. Call get_dialog to read it, '
    + `then handle_dialog to accept or dismiss it. ${JS_DIALOG_UNTRUSTED_NOTICE} `
    + 'Dialog text: "确定要提交吗"';

  it('classifies as its own error class, not as a generic unknown failure', () => {
    expect(classifyBrowserToolError(refusal)).toBe('dialog_pending');
  });

  it('records the dialog as opened, with its kind and none of its text', () => {
    const events = jsDialogSignals('click', refusal);

    expect(events).toEqual([{ kind: 'js_dialog', event: 'opened', dialogType: 'confirm' }]);
    // The message is page content. It travels to the MODEL, never into the
    // signal buffer that ends up in a diagnostic bundle.
    expect(JSON.stringify(events)).not.toContain('确定要提交吗');
  });
});

describe('the gate and the tools agree on which half of the pair changes the page', () => {
  it('reads for free and answers under approval', () => {
    expect(classifyBrowserTool('abu-browser__get_dialog')).toBe('read-only');
    expect(classifyBrowserTool('abu-browser__handle_dialog')).toBe('state-changing');
    // Both channels expose the same pair, so both must classify the same.
    expect(classifyBrowserTool('abu-browser-bridge__get_dialog')).toBe('read-only');
    expect(classifyBrowserTool('abu-browser-bridge__handle_dialog')).toBe('state-changing');
  });
});
