import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'fflate';
import { fetch } from '@tauri-apps/plugin-http';
import { exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
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
  };
});

import { installSkillFromNpm } from './npmInstaller';

const mockFetch = vi.mocked(fetch);
const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockHomeDir = vi.mocked(homeDir);

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
  return gzipSync(tar);
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
    serve(tgz({
      'package/SKILL.md': '---\nname: my-skill\n---\n# body',
      'package/README.md': '# readme',
    }));

    const result = await installSkillFromNpm('evil');

    expect(result.skillName).toBe('my-skill');
    expect(result.targetDir).toBe('/Users/test/.abu/skills/my-skill');
    expect(mockMkdir).toHaveBeenCalledWith('/Users/test/.abu/skills/my-skill', { recursive: true });
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
});
