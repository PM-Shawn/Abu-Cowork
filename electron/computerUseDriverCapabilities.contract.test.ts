/**
 * L3 driver capability contract — the helper declares, the Host normalizes,
 * the renderer parses. Same vocabulary in all three, and the declaration the
 * real Windows helper makes must agree with what earlier contract slices
 * established (element refs §2.5, empty values §2.7).
 *
 * Research note: research/computer-use-design-2026-09-11/11-m1-execution-receipt-contract.md §2.8
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseDriverCapabilities, type ComputerDriverCapabilities } from '../src/core/computer-use/windowProtocol';

const require_ = createRequire(import.meta.url);
const { normalizeDriverCapabilities, legacyDriverCapabilities } = require_('./nativeHelperManager.cjs') as {
  normalizeDriverCapabilities: (hello: unknown, platform?: string | null) => ComputerDriverCapabilities;
  legacyDriverCapabilities: (platform: string) => ComputerDriverCapabilities;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const helperExe = path.join(here, 'native-helper/target/release/native-helper.exe');

const IDENTITIES = ['runtime-id', 'session-index', 'none'] satisfies ComputerDriverCapabilities['elements']['identity'][];
const EMPTY_VALUES = ['string', 'null', 'unknown'] satisfies ComputerDriverCapabilities['elements']['empty_value'][];

function helloWith(driver: unknown) {
  return { platform: 'windows', capabilities: { driver } };
}

describe('driver capability contract', () => {
  it('the helper source declares the Windows driver with the vocabulary the Host and renderer accept', () => {
    const rust = readFileSync(path.join(here, 'native-helper/src/main.rs'), 'utf8');
    expect(rust).toContain('"driver": driver_capabilities(),');
    expect(rust).toContain('"id": "windows-uia"');
    expect(rust).toContain('"identity": "runtime-id"');
    expect(rust).toContain('"empty_value": "string"');
    // The declared value is the self-check result, never a literal promise.
    expect(rust).toContain('"dpi_awareness": windows_backend::dpi_awareness()');
    expect(rust).toContain('windows_backend::initialize_dpi_awareness()');
    for (const key of ['foreground_required', 'background_element_actions', 'unicode_text', 'clipboard_paste', 'chords', 'ime_aware',
      'physical_input_monitoring', 'occluded_window', 'excludes_own_window', 'dpi_awareness', 'can_activate_window']) {
      expect(rust, key).toContain(`"${key}"`);
    }
  });

  it('Host normalization and renderer parsing agree on every field of a declaration', () => {
    const declaration = {
      id: 'windows-uia',
      input: { foreground_required: true, background_element_actions: false, unicode_text: true, clipboard_paste: true, chords: true, ime_aware: false, physical_input_monitoring: true },
      capture: { display: 'wgc-monitor', occluded_window: false, excludes_own_window: true, dpi_awareness: 'per-monitor-v2' },
      elements: { identity: 'runtime-id', empty_value: 'string', actions: ['Invoke', 'SetValue'] },
      boundaries: ['secure-desktop', 'higher-integrity'],
      activation: { can_activate_window: true },
    };
    const host = normalizeDriverCapabilities(helloWith(declaration));
    const renderer = parseDriverCapabilities(host);
    expect(renderer).toEqual(host);
    expect(renderer?.declared).toBe(true);
    // The renderer also accepts the Host's legacy table unchanged.
    const legacy = legacyDriverCapabilities('win32');
    expect(parseDriverCapabilities(legacy)).toEqual(legacy);
    expect(parseDriverCapabilities(undefined)).toBeNull();
    expect(parseDriverCapabilities({ input: {} })).toBeNull();
  });

  it('both tiers fall back to the same conservative values for unknown enums', () => {
    const odd = helloWith({ id: 'x', elements: { identity: 'weird', empty_value: 'weird' } });
    const host = normalizeDriverCapabilities(odd);
    expect(host.elements.identity).toBe('session-index');
    expect(host.elements.empty_value).toBe('unknown');
    expect(IDENTITIES).toContain(host.elements.identity);
    expect(EMPTY_VALUES).toContain(host.elements.empty_value);
    expect(parseDriverCapabilities({ id: 'x', elements: { identity: 'weird', empty_value: 'weird' } })?.elements)
      .toEqual({ identity: 'session-index', empty_value: 'unknown', actions: [] });
    const dpi = helloWith({ id: 'x', capture: { dpi_awareness: 'v3' } });
    expect(normalizeDriverCapabilities(dpi).capture.dpi_awareness).toBe('unknown');
    expect(parseDriverCapabilities({ id: 'x', capture: { dpi_awareness: 'v3' } })?.capture.dpi_awareness).toBe('unknown');
  });

  it.runIf(process.platform === 'win32' && existsSync(helperExe))(
    'the built Windows helper declares what slices 1–3 established',
    async () => {
      const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
        let buffer = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('hello timed out')); }, 8000);
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const nl = buffer.indexOf('\n');
          if (nl === -1) return;
          clearTimeout(timer);
          child.kill();
          resolve(JSON.parse(buffer.slice(0, nl)).result);
        });
        child.on('error', reject);
        child.stdin.write('{"id":1,"method":"hello","params":{}}\n');
      });
      const caps = normalizeDriverCapabilities(hello);
      expect(caps.declared).toBe(true);
      expect(caps.id).toBe('windows-uia');
      expect(caps.elements.identity).toBe('runtime-id'); // §2.5
      expect(caps.elements.empty_value).toBe('string'); // §2.7
      expect(caps.input.unicode_text).toBe(true); // §2.6
      expect(caps.input.clipboard_paste).toBe(true); // §2.6 paste fallback
      expect(caps.input.foreground_required).toBe(true);
      expect(caps.boundaries).toEqual(['secure-desktop', 'higher-integrity']);
      expect(caps.capture.dpi_awareness).toBe('per-monitor-v2'); // §2.8 startup self-check
    },
  );
});
