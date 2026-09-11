// @vitest-environment happy-dom
/**
 * The editor used to write `~/.abu/agents/<name>/AGENT.md` unconditionally and
 * delete the old folder on rename. Before this guard, 手动创建 with an existing
 * expert's name silently replaced that expert (prompt and team identity gone),
 * and renaming A onto B's name replaced B and deleted A. A user agent named
 * like a builtin also shadowed it for every team pointing at `builtin:<name>`.
 * A new or renamed agent must therefore refuse any name another agent already
 * uses — compared case-insensitively, because the folders live on
 * case-insensitive file systems — without ever colliding with itself.
 *
 * Saving now never deletes: it writes in place, or moves the agent's own
 * folder to its name (itemStorage.test.ts). The last block runs the real
 * storage layer to pin what an edit does when the folder is not named after
 * the agent.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SubagentDefinition, SubagentMetadata } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { exists, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { agentRegistry } from '@/core/agent/registry';
import { getI18n } from '@/i18n';
import AgentEditor from './AgentEditor';

const reviewer: SubagentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
  roleId: 'role-reviewer',
};

const known: SubagentMetadata[] = [
  { name: 'reviewer', description: 'Reviews code' },
  { name: 'writer', description: 'Writes docs' },
  // A disabled plugin's agent: its AGENT.md is still on disk.
  { name: 'weather-bot', description: 'Weather', source: { kind: 'plugin', plugin: 'weather@official' } },
];

const saveButton = (): HTMLButtonElement =>
  screen.getByText(getI18n().toolbox.agentSave).closest('button')! as HTMLButtonElement;
const nameInput = (): HTMLInputElement => screen.getByPlaceholderText('my-agent') as HTMLInputElement;
const takenHint = () => screen.queryByText(getI18n().toolbox.agentNameTakenHint);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(agentRegistry, 'getAvailableAgents').mockReturnValue(known);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentEditor — a new or renamed agent cannot take another agent\'s name', () => {
  it('blocks creating an agent under an existing agent\'s name: hint shown, save disabled, nothing written', async () => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'writer' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
    // Disabled plugins' agents count too — their files are still there.
    expect(agentRegistry.getAvailableAgents).toHaveBeenCalledWith({ includeDisabledPlugins: true });
  });

  it('blocks a disabled plugin\'s agent name', () => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'weather-bot' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks a builtin\'s name even before discovery has listed any agent', () => {
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([]);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'abu' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks renaming onto another agent\'s name', async () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'writer' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
  });

  it('compares case-insensitively (the folders are case-insensitive)', () => {
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'Writer', description: '' }]);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'writer' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('allows renaming an agent to its own name in a different letter case, overwriting its own folder', async () => {
    const upper: SubagentDefinition = { ...reviewer, name: 'Reviewer', filePath: '/Users/tester/.abu/agents/Reviewer/AGENT.md' };
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'Reviewer', description: '' }, known[1]]);
    render(<AgentEditor agent={upper} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    // The default name mode lower-cases what is typed.
    fireEvent.change(nameInput(), { target: { value: 'reviewer' } });

    expect(takenHint()).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    const [, , savedName, , oldPath, options] = vi.mocked(saveItemToAbuDir).mock.calls[0];
    expect(savedName).toBe('reviewer');
    expect(oldPath).toBe(upper.filePath);
    expect(options).toEqual({ mustBeNew: false });
  });

  it('saves an agent whose unchanged name is, of course, its own', async () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);

    expect(takenHint()).toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveItemToAbuDir).mock.calls[0][5]).toEqual({ mustBeNew: false });
  });

  it('allows a unique name, and asks the disk to refuse if one appeared meanwhile', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-agent' } });

    expect(takenHint()).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [folder, , savedName, , , options] = vi.mocked(saveItemToAbuDir).mock.calls[0];
    expect([folder, savedName]).toEqual(['agents', 'fresh-agent']);
    expect(options).toEqual({ mustBeNew: true });
  });

  it('shows the hint and does not close when the disk refuses the name at save time', async () => {
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'ITEM_EXISTS' }));
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-agent' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(takenHint()).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
  });
});

describe('AgentEditor — a save failure is never silent', () => {
  const failedHint = () => screen.queryByText(getI18n().toolbox.itemSaveFailed);
  const formatHint = () => screen.queryByText(getI18n().toolbox.nameFormatHint);

  it('shows a save-failed message under Save, stays open, and clears it on a successful retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={onSave} />);

    expect(failedHint()).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(failedHint()).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false); // the user can retry

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(failedHint()).toBeNull();
  });

  it('shows the name-format hint when the disk refuses the name as not a folder name', async () => {
    // An unchanged name is never re-validated, so a hand-edited frontmatter
    // name reaches the save as it is; the storage layer refuses it.
    const handEdited: SubagentDefinition = { ...reviewer, name: 'team/reviewer' };
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'team/reviewer', description: '' }]);
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(Object.assign(new Error('invalid'), { code: 'ITEM_NAME_INVALID' }));
    render(<AgentEditor agent={handEdited} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);

    expect(formatHint()).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(formatHint()).not.toBeNull());
    expect(failedHint()).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });
});

describe('AgentEditor — editing an existing agent saves through its own folder (real storage layer)', () => {
  const HOME = '/Users/tester';
  const failedHint = () => screen.queryByText(getI18n().toolbox.itemSaveFailed);

  beforeEach(async () => {
    // The fs underneath stays the global plugin-fs mock.
    const actual = await vi.importActual<{ saveItemToAbuDir: typeof saveItemToAbuDir }>('@/utils/itemStorage');
    vi.mocked(saveItemToAbuDir).mockImplementation(actual.saveItemToAbuDir);
    vi.mocked(homeDir).mockResolvedValue(HOME);
  });

  afterEach(() => {
    vi.mocked(saveItemToAbuDir).mockImplementation(async () => undefined);
    vi.mocked(exists).mockResolvedValue(false);
  });

  /** `exists` answers true for exactly these paths. */
  const onDisk = (...paths: string[]) => vi.mocked(exists).mockImplementation(async (p) => paths.includes(String(p)));

  it('an ordinary edit (folder named after the agent) writes in place — no move, no removal', async () => {
    onDisk(`${HOME}/.abu/agents/reviewer`, `${HOME}/.abu/agents/reviewer/AGENT.md`);
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, expect.stringContaining('name: reviewer'));
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('a project-level agent is only copied into ~/.abu — its own folder is never moved or removed', async () => {
    const projectAgent: SubagentDefinition = { ...reviewer, filePath: '/work/repo/.abu/agents/reviewer/AGENT.md' };
    onDisk('/work/repo/.abu/agents/reviewer');
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={projectAgent} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, expect.any(String));
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('an agent whose folder is not named after it is moved to its name when that folder is free', async () => {
    const mismatched: SubagentDefinition = { ...reviewer, name: 'writer', filePath: `${HOME}/.abu/agents/old-writer/AGENT.md` };
    onDisk(`${HOME}/.abu/agents/old-writer`);
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={mismatched} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(rename).toHaveBeenCalledWith(`${HOME}/.abu/agents/old-writer`, `${HOME}/.abu/agents/writer`);
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/writer/AGENT.md`, expect.stringContaining('name: writer'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('when its name\'s folder holds another agent, the save fails visibly and that agent\'s file is untouched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mismatched: SubagentDefinition = { ...reviewer, name: 'writer', filePath: `${HOME}/.abu/agents/old-writer/AGENT.md` };
    onDisk(`${HOME}/.abu/agents/old-writer`, `${HOME}/.abu/agents/writer`, `${HOME}/.abu/agents/writer/AGENT.md`);
    // What the host does for a move onto a non-empty folder (fsHost rename → fs.renameSync).
    vi.mocked(rename).mockRejectedValueOnce(new Error('ENOTEMPTY: directory not empty'));
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={mismatched} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(failedHint()).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
