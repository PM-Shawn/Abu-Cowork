/**
 * Element-ref contract — the helper mints an opaque element identity, the
 * Host only checks its shape, the renderer only compares it. Three places
 * hold an assumption about that string; this test keeps them the same.
 *
 * Research note: research/computer-use-design-2026-09-11/11-m1-execution-receipt-contract.md §2.5
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { sanitizeAxElements } = require_('./computerUseActionPolicy.cjs') as {
  sanitizeAxElements: (result: unknown) => Map<number, { id: number; ref: string | null; role: string; label: string }>;
};
const here = path.dirname(fileURLToPath(import.meta.url));

describe('element-ref contract', () => {
  it('the helper mints "e:" + 16 hex digits from the UIA runtime id, or nothing', () => {
    const rust = readFileSync(path.join(here, 'native-helper/src/windows/uia/snapshot.rs'), 'utf8');
    expect(rust).toContain('Some(format!("e:{hash:016x}"))');
    expect(rust).toMatch(/if runtime_id\.is_empty\(\) \{\s+return None;/);
    const types = readFileSync(path.join(here, 'native-helper/src/windows/uia/types.rs'), 'utf8');
    expect(types).toContain('#[serde(rename = "ref")]');
  });

  it('the Host passes exactly that shape through and drops anything else', () => {
    const elements = sanitizeAxElements({
      elements: [
        { id: 1, ref: 'e:0123456789abcdef', role: 'AXButton', label: 'OK' },
        { id: 2, ref: 'E:0123456789ABCDEF', role: 'AXButton', label: 'upper case' },
        { id: 3, ref: 'e:0123', role: 'AXButton', label: 'too short' },
        { id: 4, ref: 'e:0123456789abcdef0', role: 'AXButton', label: 'too long' },
        { id: 5, ref: 42, role: 'AXButton', label: 'not a string' },
        { id: 6, role: 'AXButton', label: 'absent' },
      ],
    });
    expect(elements.get(1)?.ref).toBe('e:0123456789abcdef');
    for (const id of [2, 3, 4, 5, 6]) expect(elements.get(id)?.ref, String(id)).toBeNull();
  });
});
