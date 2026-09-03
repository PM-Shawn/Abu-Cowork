import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, resolve } from '@tauri-apps/api/path';
import { AgentRegistry } from './registry';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
const mockHomeDir = vi.mocked(homeDir);
const mockResolve = vi.mocked(resolve);

/** What the non-blocking read hands back where the real host would block. */
const BYTES_FROM_A_PIPE = '---\nname: from-a-pipe\n---\n# body';

/** Every path the read mock was asked for, in call order. */
let readTextTargets: string[] = [];

/**
 * Point the mocked plugin-fs surface at the real filesystem, as fsHost does.
 *
 * `readTextFile` FOLLOWS a symlink — the privileged host resolves the final
 * component — which is the whole reason a linked manifest may not be treated as
 * one the directory owns. It refuses only to issue a BLOCKING read: a faithful
 * `readFileSync` on a writer-less pipe never returns and would hang this run
 * rather than fail it, so a regression is turned into an assertion instead.
 */
function useRealFs() {
  readTextTargets = [];
  mockReadDir.mockImplementation(async (p: string | URL) =>
    readdirSync(String(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })) as never,
  );
  mockReadTextFile.mockImplementation(async (p: string | URL) => {
    readTextTargets.push(String(p));
    if (!lstatSync(String(p)).isFile()) return BYTES_FROM_A_PIPE;
    return readFileSync(String(p), 'utf8');
  });
  mockExists.mockImplementation(async (p: string | URL) => existsSync(String(p)));
  // `lstat` is the one call routed with `followFinalSymlink: false`.
  mockLstat.mockImplementation(async (p: string | URL) => {
    const info = lstatSync(String(p));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
    } as never;
  });
}

/**
 * `discoverAgents` scans `.abu/agents` inside the OPENED WORKSPACE, so every
 * manifest it reads is repository content that arrived by `git clone` — which
 * materialises a mode-120000 entry as a real symlink. The manifest names the
 * agent and supplies its system prompt, so a linked one puts a file the
 * directory does not own into the prompt; a FIFO is worse than wrong, because
 * `readTextFile` lands on `fs.readFileSync` inside
 * `ipcMain.handle('tauri:invoke')` — on the MAIN process event loop — where a
 * writer-less pipe never returns.
 */
describe('AgentRegistry.discoverAgents over a real tree', () => {
  let root: string;
  let workspaceAgents: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-agent-registry-'));
    workspaceAgents = join(root, 'cloned-repo', '.abu', 'agents');
    mkdirSync(workspaceAgents, { recursive: true });

    // $HOME lives inside the fixture so the user-level scan root cannot reach
    // the developer's real ~/.abu/agents, and there is no bundled resource dir.
    mockHomeDir.mockResolvedValue(join(root, 'home'));
    mockResolve.mockResolvedValue(workspaceAgents);
    // `resolveResource` is absent from the global path mock, so the registry's
    // own try/catch around it settles the bundled-agents dir as "none".
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Names of the discovered agents that are not one of the built-ins. */
  async function discoveredFromDisk(): Promise<string[]> {
    const registry = new AgentRegistry();
    const all = await registry.discoverAgents();
    return all
      .filter((a) => registry.getAgent(a.name)?.filePath !== '__builtin__')
      .map((a) => a.name);
  }

  it('adopts an agent whose AGENT.md the directory owns', async () => {
    mkdirSync(join(workspaceAgents, 'helper'), { recursive: true });
    writeFileSync(join(workspaceAgents, 'helper', 'AGENT.md'), '---\nname: helper\n---\n# body');

    expect(await discoveredFromDisk()).toEqual(['helper']);
  });

  it('does not adopt an agent whose AGENT.md is a symlink', async () => {
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'AGENT.md'), '---\nname: stolen\n---\n# from outside');
    mkdirSync(join(workspaceAgents, 'linked'), { recursive: true });
    symlinkSync(join(root, 'elsewhere', 'AGENT.md'), join(workspaceAgents, 'linked', 'AGENT.md'));

    expect(await discoveredFromDisk()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not read an AGENT.md that is a FIFO', async () => {
    mkdirSync(join(workspaceAgents, 'pipey'), { recursive: true });
    const fifo = join(workspaceAgents, 'pipey', 'AGENT.md');
    execFileSync('mkfifo', [fifo]);

    expect(await discoveredFromDisk()).toEqual([]);
    // The read that would have frozen the main process was never issued.
    expect(readTextTargets).not.toContain(fifo);
  });
});
