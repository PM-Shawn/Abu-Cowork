/**
 * Tauri Capabilities Regression Guard
 *
 * Background: on macOS, Tauri's `tauri-plugin-fs` resolves scope path
 * variables (`$DESKTOP`, `$DOCUMENT`, `$DOWNLOAD`, ...) the moment the
 * plugin initializes. Because those three variables point to folders
 * that macOS TCC protects, declaring them in the scope caused macOS to
 * throw the "Abu wants to access Desktop folder" permission dialog the
 * instant the app launched — before the user did anything.
 *
 * Fix (this test guards): those paths are already covered by `$HOME/**`
 * on macOS and the Windows default layout, so removing the explicit
 * entries eliminates the startup prompt without losing access. macOS
 * TCC now fires only on first real file I/O to these folders, which is
 * the intended UX.
 *
 * Exception: Windows users frequently relocate Downloads off the C:
 * drive, putting it outside `$HOME/**`. To cover that case we allow
 * `$DOWNLOAD` scope additions, but only inside a capability gated by
 * `"platforms": ["windows"]` so macOS never loads them.
 *
 * If a future change re-adds `$DESKTOP`/`$DOCUMENT`/`$DOWNLOAD` paths
 * to a macOS-active capability, this test fails and points future
 * contributors to this explanation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const CAPABILITIES_DIR = path.resolve(__dirname, '../../src-tauri/capabilities');
const CAPABILITIES_PATH = path.join(CAPABILITIES_DIR, 'default.json');

interface PermissionObject {
  identifier?: string;
  allow?: Array<{ path?: string }>;
  deny?: Array<{ path?: string }>;
}

type Permission = string | PermissionObject;

interface Capabilities {
  identifier?: string;
  platforms?: string[];
  permissions: Permission[];
}

function loadCapabilities(): Capabilities {
  return JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf-8'));
}

function loadAllCapabilities(): Capabilities[] {
  return fs
    .readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CAPABILITIES_DIR, f), 'utf-8')) as Capabilities);
}

function appliesToMacOS(cap: Capabilities): boolean {
  // Missing `platforms` field = all platforms. Otherwise must include "macOS".
  if (!cap.platforms) return true;
  return cap.platforms.includes('macOS');
}

function collectScopePaths(permissions: Permission[]): string[] {
  const paths: string[] = [];
  for (const perm of permissions) {
    if (typeof perm !== 'object' || perm === null) continue;
    const allow = perm.allow;
    if (!Array.isArray(allow)) continue;
    for (const entry of allow) {
      if (entry && typeof entry.path === 'string') {
        paths.push(entry.path);
      }
    }
  }
  return paths;
}

function permissionScopePaths(
  permissions: Permission[],
  identifier: string
): string[] {
  for (const perm of permissions) {
    if (typeof perm !== 'object' || perm === null) continue;
    if (perm.identifier !== identifier) continue;
    const allow = perm.allow;
    if (!Array.isArray(allow)) return [];
    return allow
      .map((e) => (e && typeof e.path === 'string' ? e.path : ''))
      .filter((p): p is string => Boolean(p));
  }
  return [];
}

function permissionDenyPaths(
  permissions: Permission[],
  identifier: string
): string[] {
  for (const perm of permissions) {
    if (typeof perm !== 'object' || perm === null) continue;
    if (perm.identifier !== identifier) continue;
    const deny = perm.deny;
    if (!Array.isArray(deny)) return [];
    return deny
      .map((e) => (e && typeof e.path === 'string' ? e.path : ''))
      .filter((p): p is string => Boolean(p));
  }
  return [];
}

describe('tauri capabilities — startup TCC regression guard', () => {
  const FORBIDDEN_ROOTS = ['$DESKTOP', '$DOCUMENT', '$DOWNLOAD'];

  it('does not declare $DESKTOP / $DOCUMENT / $DOWNLOAD scope paths in any macOS-active capability', () => {
    const offenders = loadAllCapabilities()
      .filter(appliesToMacOS)
      .flatMap((cap) => {
        const paths = collectScopePaths(cap.permissions);
        return paths
          .filter((p) => FORBIDDEN_ROOTS.some((root) => p.startsWith(root)))
          .map((p) => `${cap.identifier ?? '<no id>'}: ${p}`);
      });
    expect(offenders).toEqual([]);
  });

  it('still declares $HOME/** so Desktop/Documents/Downloads remain reachable through the home directory', () => {
    const paths = collectScopePaths(loadCapabilities().permissions);
    expect(paths).toContain('$HOME/**');
  });
});

// On macOS/Linux, Tauri's tauri-plugin-fs defaults require_literal_leading_dot
// to true (see tauri::scope::fs and tauri-plugin-fs commands.rs). That means a
// glob pattern like "$HOME/**" does NOT match path components starting with a
// dot, so it cannot reach "~/Documents/foo/.abu/...". To allow workspace .abu
// directories anywhere under $HOME, we must list .abu literally in the
// pattern: "$HOME/**/.abu" (the directory itself) and "$HOME/**/.abu/**" (its
// contents).
//
// On Windows the dot rule defaults to false, so "$HOME/**" already covers
// those paths — these explicit entries are redundant there but harmless.
//
// Symptom that originally surfaced this: project-instructions modal failed to
// save ABU.md to a workspace under "~/Documents/...", with the Tauri error
// "forbidden path: .../.abu, ... allow-exists permission".
describe('tauri capabilities — workspace .abu reachability under $HOME', () => {
  const REQUIRED_BOTH = [
    'fs:allow-read-text-file',
    'fs:allow-read-file',
    'fs:allow-write-text-file',
    'fs:allow-write-file',
    'fs:allow-read-dir',
    'fs:allow-exists',
    'fs:allow-mkdir',
    'fs:allow-stat',
    'fs:allow-copy-file',
    'fs:allow-rename',
    'fs:allow-watch',
  ] as const;

  it.each(REQUIRED_BOTH)(
    '%s declares both $HOME/**/.abu and $HOME/**/.abu/**',
    (identifier) => {
      const paths = permissionScopePaths(loadCapabilities().permissions, identifier);
      expect(paths).toContain('$HOME/**/.abu');
      expect(paths).toContain('$HOME/**/.abu/**');
    }
  );

  it('fs:allow-remove can delete .abu contents but never the .abu dir itself (deny-guarded)', () => {
    const permissions = loadCapabilities().permissions;
    const allow = permissionScopePaths(permissions, 'fs:allow-remove');
    const deny = permissionDenyPaths(permissions, 'fs:allow-remove');
    // Broad $HOME/** allow lets the file-tree delete workspace files anywhere
    // under home (workspaces live there), and .abu *contents* are removable...
    expect(allow).toContain('$HOME/**/.abu/**');
    // ...but the .abu DIRECTORY itself must be protected — deleting it would
    // wipe project memory/skills irrecoverably. With the broad allow, that
    // guard now lives in `deny` rather than by omission from `allow`.
    expect(allow).not.toContain('$HOME/**/.abu');
    expect(deny).toContain('$HOME/.abu');
    expect(deny).toContain('$HOME/**/.abu');
  });
});
