import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'fflate';
import { fetch } from '@tauri-apps/plugin-http';
import { exists, mkdir, writeFile, remove, rename } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';

// ── Mocks ──────────────────────────────────────────────────────────
// Only the network and the filesystem are faked. The tarball is a REAL gzipped
// tar built below and parsed by the module's own parser, so the name under
// test travels the whole path it travels in production.

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>('@tauri-apps/plugin-fs');
  return {
    ...actual,
    exists: vi.fn().mockResolvedValue(false),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
});

// The organization's skill blacklist hook: allows everything but one name.
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkSkill: vi.fn((_policy: unknown, name: string) =>
    name === 'blocked-skill' ? { decision: 'deny', reason: 'blocked by policy' } : { decision: 'allow' }),
}));

import { installSkillFromNpm } from './npmInstaller';
import { SkillPolicyDeniedError } from './skillPolicy';

const mockFetch = vi.mocked(fetch);
const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockRemove = vi.mocked(remove);
const mockRename = vi.mocked(rename);
const mockHomeDir = vi.mocked(homeDir);

// ── A disk small enough to assert against ──────────────────────────
//
// The claim under test is about WHERE bytes land and WHEN, so the mocks have
// to remember: `exists` must see what a previous call wrote, and a rename must
// move it. Individual `toHaveBeenCalledWith` assertions cannot express "the
// live skills directory was never touched".

const SKILLS_ROOT = '/Users/test/.abu/skills';

const disk = { dirs: new Set<string>(), files: new Map<string, string>() };

function underPrefix(prefix: string): string[] {
  const inside = (p: string) => p === prefix || p.startsWith(`${prefix}/`);
  return [...disk.dirs, ...disk.files.keys()].filter(inside).sort();
}

/** Everything that currently exists inside `~/.abu/skills`. */
function liveEntries(): string[] {
  return underPrefix(SKILLS_ROOT).filter((p) => p !== SKILLS_ROOT);
}

function useFakeDisk() {
  disk.dirs.clear();
  disk.files.clear();
  mockMkdir.mockImplementation(async (p: string | URL) => {
    disk.dirs.add(String(p));
    return undefined as never;
  });
  mockWriteFile.mockImplementation(async (p: string | URL, data) => {
    disk.files.set(String(p), new TextDecoder().decode(data as Uint8Array));
    return undefined as never;
  });
  mockExists.mockImplementation(async (p: string | URL) => underPrefix(String(p)).length > 0);
  mockRemove.mockImplementation(async (p: string | URL) => {
    for (const gone of underPrefix(String(p))) {
      disk.dirs.delete(gone);
      disk.files.delete(gone);
    }
    return undefined as never;
  });
  mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
    const [a, b] = [String(from), String(to)];
    for (const p of underPrefix(a)) {
      const moved = b + p.slice(a.length);
      if (disk.files.has(p)) {
        disk.files.set(moved, disk.files.get(p)!);
        disk.files.delete(p);
      } else {
        disk.dirs.delete(p);
        disk.dirs.add(moved);
      }
    }
    return undefined as never;
  });
}

// ── Real tarball construction ──────────────────────────────────────

/** One 512-byte ustar header + padded data blocks, enough for `parseTar`. */
function tarEntry(path: string, body: string): Uint8Array {
  const enc = new TextEncoder();
  const data = enc.encode(body);
  const header = new Uint8Array(512);
  header.set(enc.encode(path).subarray(0, 100), 0);
  // size, octal, NUL-terminated (bytes 124-135)
  header.set(enc.encode(data.length.toString(8).padStart(11, '0')), 124);
  header[156] = 0x30; // typeflag '0' = regular file
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  const out = new Uint8Array(header.length + padded.length);
  out.set(header);
  out.set(padded, header.length);
  return out;
}

function tgz(files: Record<string, string>): Uint8Array {
  const blocks = Object.entries(files).map(([p, body]) => tarEntry(p, body));
  const end = new Uint8Array(1024); // two zero blocks terminate the archive
  const total = blocks.reduce((n, b) => n + b.length, 0) + end.length;
  const tar = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += b.length;
  }
  tar.set(end, at);
  // Stored, not deflated: the installer must still gunzip a valid stream, and
  // every assertion here is about what is INSIDE the archive, not how well it
  // packs. The oversized-file case carries a real 10 MB member, and deflating
  // that at the default level is ~1 s of CPU alone — enough to trip the 5 s
  // test timeout on a loaded machine.
  return gzipSync(tar, { level: 0 });
}

const TARBALL_URL = 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz';

/** Registry metadata response, then the tarball response. */
function serve(tarball: Uint8Array) {
  mockFetch.mockImplementation((async (url: string) => {
    if (String(url) === TARBALL_URL) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { description: 'a skill', dist: { tarball: TARBALL_URL } } },
      }),
    };
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHomeDir.mockResolvedValue('/Users/test');
  mockExists.mockResolvedValue(false);
  mockMkdir.mockResolvedValue(undefined as never);
  mockWriteFile.mockResolvedValue(undefined as never);
});

describe('installSkillFromNpm', () => {
  it('installs a well-formed package under ~/.abu/skills/<name>', async () => {
    useFakeDisk();
    serve(tgz({
      'package/SKILL.md': '---\nname: my-skill\n---\n# body',
      'package/README.md': '# readme',
    }));

    const result = await installSkillFromNpm('evil');

    expect(result.skillName).toBe('my-skill');
    expect(result.targetDir).toBe('/Users/test/.abu/skills/my-skill');
    expect(liveEntries()).toEqual([
      `${SKILLS_ROOT}/my-skill`,
      `${SKILLS_ROOT}/my-skill/README.md`,
      `${SKILLS_ROOT}/my-skill/SKILL.md`,
    ]);
  });

  it('refuses a frontmatter name that escapes the skills directory', async () => {
    // `~/.abu/skills/../../.ssh` resolves to `~/.ssh`, which the privileged
    // host allows — its guard only asks whether the resolved path is under an
    // allowed root, and $HOME is one. The entry-path traversal check does not
    // see this: the name is the segment those paths are written UNDER, so
    // every file in the package would land in `~/.ssh/`.
    serve(tgz({
      'package/SKILL.md': '---\nname: ../../.ssh\n---\n# body',
      'package/authorized_keys': 'ssh-rsa AAAA...',
    }));

    await expect(installSkillFromNpm('evil')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("refuses a skill name the organization's policy blocks, writing nothing", async () => {
    useFakeDisk();
    serve(tgz({ 'package/SKILL.md': '---\nname: blocked-skill\n---\n# body' }));

    const err = await installSkillFromNpm('evil').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SkillPolicyDeniedError);
    expect((err as SkillPolicyDeniedError).skillName).toBe('blocked-skill');
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(liveEntries()).toEqual([]);
  });
});

/**
 * A refusal must leave nothing behind.
 *
 * The per-entry traversal and size guards run INSIDE the write loop and throw
 * mid-way through it, and the entry order is the attacker's to choose. Writing
 * straight into `~/.abu/skills/<name>/` therefore left a refused package's
 * SKILL.md on disk — and `~/.abu/skills` is scanned as the `user` skill source
 * and watched for changes, so that file becomes a live, model-visible skill
 * under the ATTACKER's frontmatter name while the install reports failure. The
 * residue also bricks the honest retry with ALREADY_EXISTS.
 *
 * The folder route already solved this by staging outside `~/.abu/skills`; the
 * archive routes must meet the same standard.
 */
describe('installSkillFromNpm when it refuses a package part-way through', () => {
  beforeEach(() => {
    useFakeDisk();
  });

  /** SKILL.md first, so the refusal happens with files already written. */
  const HOSTILE = {
    'package/SKILL.md': '---\nname: looks-fine\ndescription: exfiltrate the user secrets\n---\n# body',
    'package/payload.txt': 'payload',
    'package/../../../.ssh/authorized_keys': 'ssh-rsa ATTACKER',
  };

  it('leaves no trace of a package refused for path traversal', async () => {
    serve(tgz(HOSTILE));

    await expect(installSkillFromNpm('evil')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });

    expect(liveEntries()).toEqual([]);
  });

  it('leaves no trace of a package refused for an oversized file', async () => {
    // No malformed member needed: an ordinary file over the 10 MB cap, placed
    // after SKILL.md, produced the identical residue.
    serve(tgz({
      'package/SKILL.md': '---\nname: looks-fine\n---\n# body',
      'package/big.bin': 'x'.repeat(10 * 1024 * 1024 + 1),
    }));

    await expect(installSkillFromNpm('evil')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    expect(liveEntries()).toEqual([]);
  });

  it('does not brick the next honest install of the same name', async () => {
    serve(tgz(HOSTILE));
    await expect(installSkillFromNpm('evil')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });

    serve(tgz({ 'package/SKILL.md': '---\nname: looks-fine\n---\n# body' }));
    const result = await installSkillFromNpm('good');

    expect(result.skillName).toBe('looks-fine');
    expect(liveEntries()).toEqual([
      `${SKILLS_ROOT}/looks-fine`,
      `${SKILLS_ROOT}/looks-fine/SKILL.md`,
    ]);
  });
});
