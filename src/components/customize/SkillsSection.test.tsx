// @vitest-environment happy-dom
/**
 * 「我的」 for the Skills tab. `source="mine"` narrows the list to skills
 * the user (or their project/team) put on disk. Plugin- and organization-shipped
 * skills used to land in the same bucket as hand-written ones — someone else's
 * work presented as yours — so this filter is the boundary that keeps the
 * heading honest. Builtin skills belong to 市场 for the same reason.
 *
 * `draft` is a member of the mine set but never shows as a card: drafts render
 * through SkillDraftsPanel, which reads the drafts store, not discovery.
 */

import { useState, type ReactElement } from 'react';
import { act, render as renderBare, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window is a design-system dialog, so the section renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock('@/core/skill/packager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/skill/packager')>()),
  packSkill: vi.fn(),
}));

// The history window reads the skill's change log; these tests only open it.
vi.mock('@/core/skill/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/skill/history')>()),
  readHistory: vi.fn(async () => []),
}));

import { Button } from '@/components/ds/button';
import { readHistory } from '@/core/skill/history';
import { remove, writeFile } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { packSkill } from '@/core/skill/packager';
import { useToastStore } from '@/stores/toastStore';
import { getI18n } from '@/i18n';
import type { Skill, SkillMetadata } from '@/types';
import { skillLoader } from '@/core/skill/loader';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { usePluginStore } from '@/stores/pluginStore';
import type { DraftRecord } from '@/core/skill/drafts';
import SkillsSection from './SkillsSection';

const tb = () => getI18n().toolbox;

const meta = (name: string, source: SkillMetadata['source']): SkillMetadata =>
  ({ name, description: `${name} does things`, source });

const CATALOG: SkillMetadata[] = [
  meta('my-notes', 'user'),
  // Shares a name with a builtin marketplace template while living in the
  // user's own directory — the case the inlined edit/delete condition missed.
  meta('docx', 'user'),
  meta('auto-thing', 'workspace-auto'),
  meta('cross-client', 'standard'),
  meta('team-rules', 'project'),
  meta('weather-report', 'plugin'),
  meta('expense-policy', 'enterprise'),
  meta('pdf-fill', 'builtin'),
];

const draft = (skillName: string): DraftRecord => ({
  id: skillName,
  skillName,
  skillDir: `/drafts/${skillName}`,
  skillMdPath: `/drafts/${skillName}/SKILL.md`,
  action: 'create',
  triggerReason: 'a 6-step task succeeded',
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_600_000_000,
});

const full = (m: SkillMetadata): Skill => ({
  ...m,
  content: `# ${m.name}`,
  filePath: `/skills/${m.name}/SKILL.md`,
  skillDir: `/skills/${m.name}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  useDiscoveryStore.setState({ skills: CATALOG });
  useSkillDraftsStore.setState({ drafts: [] });
  // Past the one-time onboarding card, so the drafts list itself renders.
  useSettingsStore.setState({ soul: { proactivity: 'companion', draftsOnboardingShown: true } });
  vi.spyOn(skillLoader, 'getSkill').mockImplementation((name: string) => {
    const m = CATALOG.find((s) => s.name === name);
    return m ? full(m) : undefined;
  });
  vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([]);
  vi.spyOn(skillLoader, 'loadSupportingFile').mockResolvedValue(null);
});

describe('SkillsSection · source="mine"', () => {
  it('lists the user\'s own, project and standard skills', async () => {
    render(<SkillsSection source="mine" />);
    for (const name of ['my-notes', 'auto-thing', 'cross-client', 'team-rules']) {
      expect(await screen.findByText(name)).toBeTruthy();
    }
  });

  it('lists everything installed — the bundled skills included — with provenance on the cards', async () => {
    render(<SkillsSection source="mine" />);
    await screen.findByText('my-notes');
    // Bundled skills ship installed, so they are the user's too; 市场 lists
    // the same ones marked 已安装.
    expect(screen.getByText('pdf-fill')).toBeTruthy();
    // Installed by this user through a plugin, or pushed by their organization:
    // theirs, so on 「我的」, each with its provenance on the card.
    const pluginCard = screen.getByText('weather-report').closest('[role="button"]') as HTMLElement;
    expect(within(pluginCard).getByTestId('source-badge').getAttribute('data-source-kind')).toBe('plugin');
    const orgCard = screen.getByText('expense-policy').closest('[role="button"]') as HTMLElement;
    expect(within(orgCard).getByTestId('source-badge').getAttribute('data-source-kind')).toBe('enterprise');
    expect(within(screen.getByText('my-notes').closest('[role="button"]') as HTMLElement).queryByTestId('source-badge')).toBeNull();
  });

  it('offers 创建技能 from the empty shelf when nothing is installed at all', async () => {
    useDiscoveryStore.setState({ skills: [] });
    render(<SkillsSection source="mine" />);
    expect(await screen.findByText(tb().skillsMineEmptyTitle)).toBeTruthy();
    expect(screen.getByTestId('skills-mine-create')).toBeTruthy();
  });

  it('shows the bundled skills with their switch, and 市场 with 已安装 instead', async () => {
    // The switch decides whether Abu may use a skill, so it sits on what the
    // user has; the market row only says the skill is already installed.
    useDiscoveryStore.setState({ skills: [meta('pdf-fill', 'builtin')] });
    const mine = render(<SkillsSection source="mine" />);
    await screen.findByText('pdf-fill');
    expect(screen.queryByTestId('skill-installed-badge')).toBeNull();
    mine.unmount();

    render(<SkillsSection source="market" />);
    await screen.findByText('pdf-fill');
    expect(screen.getByTestId('skill-installed-badge').textContent).toBe(tb().installedMark);
  });

  /**
   * Drafts are the whole point of 阿布沉淀: skills Abu wrote and is waiting on a
   * verdict for. A user who has written nothing themselves is exactly the user
   * most likely to have unreviewed drafts, so an empty 我的 must not swallow
   * them — `draft` is in MINE_SOURCES, and 市场 will never show them either.
   */
  it('shows pending drafts even when the user has authored nothing', async () => {
    useDiscoveryStore.setState({ skills: [meta('pdf-fill', 'builtin')] });
    useSkillDraftsStore.setState({ drafts: [draft('meeting-notes')] });
    render(<SkillsSection source="mine" />);
    expect(await screen.findByText(tb().categoryAgentEvolved)).toBeTruthy();
    expect(screen.getByText('meeting-notes')).toBeTruthy();
    expect(screen.queryByText(tb().skillsMineEmptyTitle)).toBeNull();
  });

  it('opens the shared detail panel on a card', async () => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    const detail = screen.getByTestId('skill-detail');
    expect(within(detail).getByText('my-notes does things')).toBeTruthy();
    // Escape closes it — the panel still owns the modal chrome after the split.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('skill-detail')).toBeNull();
  });

  it('keeps every source, one shelf each', async () => {
    const { rerender } = render(<SkillsSection source="mine" />);
    expect(await screen.findByText('my-notes')).toBeTruthy();
    expect(screen.getByText('weather-report')).toBeTruthy();
    rerender(<SkillsSection source="market" />);
    expect(await screen.findByText('pdf-fill')).toBeTruthy();
    expect(screen.queryByText('weather-report')).toBeNull();
    expect(screen.queryByText('my-notes')).toBeNull();
  });
  it.each(['pdf-fill', 'weather-report', 'expense-policy'])('retains detail actions but not independent removal for %s', async (name) => {
    // Plugin and 企业下发 skills live on the 我的 shelf; bundled skills on 市场.
    const user = userEvent.setup();
    render(<SkillsSection source={name === 'pdf-fill' ? 'market' : 'mine'} />);
    fireEvent.click(await screen.findByText(name));
    expect(screen.getByTestId('skill-detail')).toBeVisible();
    await user.click(screen.getByTestId('skill-detail-menu'));
    expect(screen.getByText(tb().exportSkill)).toBeVisible();
    expect(screen.getByText(tb().historyMenuLabel)).toBeVisible();
    expect(screen.queryByText(tb().skillEdit)).toBeNull();
    expect(screen.queryByText(tb().deleteItem)).toBeNull();
  });

  it('tells a plugin skill\'s detail where it came from and how it leaves', async () => {
    usePluginStore.setState({
      installed: [{ key: 'weather@market', marketplace: 'market', name: 'weather', version: '1.0.0', installedAt: '2026-09-01T00:00:00.000Z', contributed: { skills: ['weather-report'], mcpServers: [], agents: [], teams: [] } }],
      activationByKey: { 'weather@market': { enabled: true, root: '/skills/weather-report', skillDirs: ['/skills/weather-report'], legacySkills: false, agentFiles: [], mcpServers: [] } },
      activationReady: true,
    });
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('weather-report'));
    expect(screen.getByTestId('skill-plugin-origin').textContent).toContain('weather');
  });

});

/**
 * The list deliberately includes skills whose owning plugin is switched off, so
 * they stay discoverable. The card must not also claim they are active: the
 * model's strict getAvailableSkills() has already dropped them, so a green
 * switch and a live 试用 button would be the UI lying about what Abu can see.
 */
describe('SkillsSection · disabled plugin ownership', () => {
  const activation = (enabled: boolean) => ({
    'weather@market': {
      enabled, root: '/skills/weather-report', skillDirs: ['/skills/weather-report'],
      legacySkills: false, agentFiles: [], mcpServers: [],
    },
  });
  const switchFor = (name: string) => {
    const card = screen.getByText(name).closest('[role="button"]');
    if (!card) throw new Error(`no card for ${name}`);
    return within(card as HTMLElement).getByRole('switch');
  };

  it('shows the skill as off and locks its switch while the owning plugin is disabled', async () => {
    usePluginStore.setState({ activationByKey: activation(false), activationReady: true });
    render(<SkillsSection source="mine" />);
    await screen.findByText('weather-report');
    const toggle = switchFor('weather-report');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    // A skill nobody owns, on the same shelf, is unaffected.
    expect(switchFor('my-notes').getAttribute('aria-checked')).toBe('true');
    expect((switchFor('my-notes') as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks the trial button and says why', async () => {
    usePluginStore.setState({ activationByKey: activation(false), activationReady: true });
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('weather-report'));
    expect(screen.getByText(tb().skillPluginDisabled)).toBeTruthy();
    expect((screen.getByText(tb().menuTrial).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the switch on once the owning plugin is enabled', async () => {
    usePluginStore.setState({ activationByKey: activation(true), activationReady: true });
    render(<SkillsSection source="mine" />);
    await screen.findByText('weather-report');
    const toggle = switchFor('weather-report');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * Regression: the edit/delete condition was inlined at two call sites and lost
 * isSystemSkill's template-name branch, so a user-directory skill named after a
 * builtin template became editable and deletable.
 */
describe('SkillsSection · system skill protection', () => {
  const openMenu = async (name: string) => {
    // Both skills here are the user's own — the 我的 shelf.
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText(name));
    await user.click(screen.getByTestId('skill-detail-menu'));
  };

  it('withholds edit and delete from a user skill that shares a builtin template name', async () => {
    await openMenu('docx');
    expect(screen.getByText(tb().exportSkill)).toBeVisible();
    expect(screen.queryByText(tb().skillEdit)).toBeNull();
    expect(screen.queryByText(tb().deleteItem)).toBeNull();
  });

  it('still offers them for an ordinary user skill', async () => {
    await openMenu('my-notes');
    expect(screen.getByText(tb().skillEdit)).toBeVisible();
    expect(screen.getByText(tb().deleteItem)).toBeVisible();
  });
});

/**
 * A skill is a folder on the user's disk. These hold what the page does to it:
 * which folder a delete removes, what an export writes and where.
 */
describe('SkillsSection · files on disk', () => {
  const refresh = vi.fn(async () => undefined);
  const addToast = vi.fn();
  const order: string[] = [];
  // The stores' own actions, put back after each test: the other groups use the real ones.
  const real = {
    discovery: useDiscoveryStore.getState().refresh,
    toast: useToastStore.getState().addToast,
    chat: { startNewConversation: useChatStore.getState().startNewConversation, setPendingInput: useChatStore.getState().setPendingInput },
    settings: { closeExtensions: useSettingsStore.getState().closeExtensions, toggleSkillEnabled: useSettingsStore.getState().toggleSkillEnabled },
  };

  afterEach(() => {
    useDiscoveryStore.setState({ refresh: real.discovery });
    useToastStore.setState({ addToast: real.toast });
    useChatStore.setState(real.chat);
    useSettingsStore.setState({ ...real.settings, disabledSkills: [] });
    usePluginStore.setState({ activationByKey: {}, activationReady: false });
    vi.mocked(remove).mockReset().mockResolvedValue(undefined);
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveDialog).mockReset().mockResolvedValue(null);
  });

  beforeEach(() => {
    order.length = 0;
    refresh.mockImplementation(async () => { order.push('refresh'); });
    vi.mocked(remove).mockImplementation(async () => { order.push('remove'); });
    vi.mocked(writeFile).mockImplementation(async () => { order.push('writeFile'); });
    vi.mocked(packSkill).mockImplementation(async () => { order.push('packSkill'); return new Uint8Array([1, 2, 3]); });
    vi.mocked(saveDialog).mockResolvedValue(null);
    useDiscoveryStore.setState({ refresh });
    useToastStore.setState({ addToast });
  });

  const openDetail = async (name: string) => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText(name));
    return screen.getByTestId('skill-detail');
  };
  // The window's own delete button, and the question's button that says yes.
  const deleteButton = () => within(screen.getByRole('dialog')).getByRole('button', { name: tb().deleteItem });
  const question = () => screen.getByRole('alertdialog');
  const answerDelete = () => fireEvent.click(within(question()).getByRole('button', { name: getI18n().common.delete }));

  it('asks first, naming the skill, and removes nothing until the answer', async () => {
    await openDetail('my-notes');
    fireEvent.click(deleteButton());

    const asked = await screen.findByRole('alertdialog');
    expect(asked).toHaveTextContent(tb().deleteItem);
    expect(asked).toHaveTextContent('my-notes');
    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('deletes the folder of the skill on screen, then reads the skills again and closes the window', async () => {
    await openDetail('my-notes');
    fireEvent.click(deleteButton());
    await screen.findByRole('alertdialog');
    answerDelete();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('/skills/my-notes', { recursive: true });
    expect(order).toEqual(['remove', 'refresh']);
    await waitFor(() => expect(screen.queryByTestId('skill-detail')).toBeNull());
  });

  it('removes nothing when the question is cancelled, and keeps the window', async () => {
    await openDetail('my-notes');
    fireEvent.click(deleteButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: getI18n().common.cancel }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('skill-detail')).toBeInTheDocument();
  });

  it('removes nothing when the skill is gone by the time the question is answered', async () => {
    await openDetail('my-notes');
    fireEvent.click(deleteButton());
    await screen.findByRole('alertdialog');
    // Removed from the file manager, or by Abu in a task, while the question was open.
    vi.mocked(skillLoader.getSkill).mockImplementation((name: string) => {
      const m = CATALOG.find((s) => s.name === name && s.name !== 'my-notes');
      return m ? full(m) : undefined;
    });
    answerDelete();

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('removes nothing when the name leads to another file by the time the question is answered', async () => {
    await openDetail('my-notes');
    fireEvent.click(deleteButton());
    await screen.findByRole('alertdialog');
    // The user's file went away and a plugin's skill of the same name answers to it now.
    vi.mocked(skillLoader.getSkill).mockImplementation((name: string) => {
      const m = CATALOG.find((s) => s.name === name);
      if (!m) return undefined;
      return name === 'my-notes' ? { ...full(m), source: 'plugin', filePath: '/plugins/notes/skills/my-notes/SKILL.md', skillDir: '/plugins/notes/skills/my-notes' } : full(m);
    });
    answerDelete();

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it('ends the question with the page: nothing is removed once the page has left', async () => {
    const view = render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    fireEvent.click(deleteButton());
    await screen.findByRole('alertdialog');

    view.unmount();

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the window and reads nothing again when the delete fails', async () => {
    vi.mocked(remove).mockRejectedValue(new Error('busy'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openDetail('my-notes');
    fireEvent.click(deleteButton());
    await screen.findByRole('alertdialog');
    answerDelete();

    await waitFor(() => expect(logged).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('skill-detail')).toBeInTheDocument();
    logged.mockRestore();
  });

  it('exports the skill folder to the file the user picked', async () => {
    const user = userEvent.setup();
    vi.mocked(saveDialog).mockResolvedValue('/exports/my-notes.askill');
    await openDetail('my-notes');
    await user.click(screen.getByTestId('skill-detail-menu'));
    await user.click(await screen.findByRole('menuitem', { name: tb().exportSkill }));

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(saveDialog).toHaveBeenCalledWith({
      defaultPath: 'my-notes.askill',
      filters: [{ name: 'Skill Package', extensions: ['askill'] }],
    });
    expect(packSkill).toHaveBeenCalledTimes(1);
    expect(packSkill).toHaveBeenCalledWith('/skills/my-notes');
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('/exports/my-notes.askill', new Uint8Array([1, 2, 3]));
    expect(order).toEqual(['packSkill', 'writeFile']);
    expect(addToast).toHaveBeenCalledWith({ type: 'success', title: tb().exportSuccess, message: '"my-notes"' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('writes nothing when the user cancels the file picker', async () => {
    const user = userEvent.setup();
    await openDetail('my-notes');
    await user.click(screen.getByTestId('skill-detail-menu'));
    await user.click(await screen.findByRole('menuitem', { name: tb().exportSkill }));

    await waitFor(() => expect(saveDialog).toHaveBeenCalledTimes(1));
    expect(packSkill).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('reports a failed export and leaves the skill alone', async () => {
    vi.mocked(saveDialog).mockResolvedValue('/exports/my-notes.askill');
    vi.mocked(writeFile).mockRejectedValue(new Error('read-only'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    await openDetail('my-notes');
    await user.click(screen.getByTestId('skill-detail-menu'));
    await user.click(await screen.findByRole('menuitem', { name: tb().exportSkill }));

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: tb().exportFailed, message: 'Error: read-only' });
    expect(remove).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('starts a task with the skill from the window and leaves the page', async () => {
    const startNewConversation = vi.fn();
    const setPendingInput = vi.fn();
    const closeExtensions = vi.fn();
    useChatStore.setState({ startNewConversation, setPendingInput });
    useSettingsStore.setState({ closeExtensions });
    await openDetail('my-notes');
    fireEvent.click(screen.getByText(tb().menuTrial).closest('button') as HTMLButtonElement);

    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(setPendingInput).toHaveBeenCalledWith('/my-notes ', { startsTask: true });
    expect(closeExtensions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('skill-detail')).toBeNull());
  });

  it('switches a skill off and on from its card without opening the window', async () => {
    const toggleSkillEnabled = vi.fn();
    useSettingsStore.setState({ toggleSkillEnabled, disabledSkills: [] });
    render(<SkillsSection source="mine" />);
    const card = (await screen.findByText('my-notes')).closest('[role="button"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('switch'));

    expect(toggleSkillEnabled).toHaveBeenCalledTimes(1);
    expect(toggleSkillEnabled).toHaveBeenCalledWith('my-notes');
    expect(screen.queryByTestId('skill-detail')).toBeNull();
  });

  it('says why the switch of a disabled plugin\'s skill cannot be used', async () => {
    usePluginStore.setState({
      activationByKey: { 'weather@market': { enabled: false, root: '/skills/weather-report', skillDirs: ['/skills/weather-report'], legacySkills: false, agentFiles: [], mcpServers: [] } },
      activationReady: true,
    });
    render(<SkillsSection source="mine" />);
    const card = (await screen.findByText('weather-report')).closest('[role="button"]') as HTMLElement;
    const toggle = within(card).getByRole('switch') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.closest('[title]')?.getAttribute('title')).toBe(tb().skillPluginDisabled);
  });
});

describe('SkillsSection · shadowed built-ins on 市场', () => {
  it('keeps a covered built-in on 市场, marked, whether the winner is the user\'s or a plugin\'s copy', () => {
    // Both winners live under 我的 — the user's docx and the plugin's
    // weather-report — which is where the badge's hint sends the user.
    vi.spyOn(skillLoader, 'getShadowedSkills').mockReturnValue([
      full(meta('docx', 'builtin')),
      full(meta('weather-report', 'builtin')),
    ]);
    render(<SkillsSection source="market" />);
    for (const name of ['docx', 'weather-report']) {
      const covered = screen.getByTestId(`skill-shadowed-${name}`);
      expect(within(covered).getByText(tb().skillShadowedBadge)).toBeInTheDocument();
    }
    // The live copies are not on this shelf.
    expect(screen.getAllByText('weather-report')).toHaveLength(1);
  });

  it('shows the covered mark as a neutral label with the reason on hover, and a switch that cannot be used', () => {
    vi.spyOn(skillLoader, 'getShadowedSkills').mockReturnValue([full(meta('docx', 'builtin'))]);
    render(<SkillsSection source="market" />);
    const covered = screen.getByTestId('skill-shadowed-docx');
    const mark = within(covered).getByText(tb().skillShadowedBadge);
    expect(mark).toHaveClass('bg-fill');
    expect(mark.closest('[title]')?.getAttribute('title')).toBe(tb().skillShadowedHint);
    const toggle = within(covered).getByRole('switch', { name: 'docx' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});

describe('SkillsSection · design-system controls', () => {
  const card = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

  it.each([
    ['auto-thing', 'skillSourceWorkspaceAuto'],
    ['team-rules', 'skillSourceProject'],
    ['cross-client', 'skillSourceStandard'],
  ] as const)('labels the source of %s with a neutral tag', async (name, key) => {
    render(<SkillsSection source="mine" />);
    await screen.findByText(name);
    const label = within(card(name)).getByText(tb()[key]);
    expect(label).toHaveClass('bg-fill');
    expect(label).toHaveClass('text-label-secondary');
  });

  it('carries no clay colour on a source label', async () => {
    render(<SkillsSection source="mine" />);
    await screen.findByText('auto-thing');
    expect(within(card('auto-thing')).getByText(tb().skillSourceWorkspaceAuto).className).not.toContain('clay');
  });

  it('carries no slate colour on a source label', async () => {
    render(<SkillsSection source="mine" />);
    await screen.findByText('cross-client');
    expect(within(card('cross-client')).getByText(tb().skillSourceStandard).className).not.toContain('slate');
  });

  it('carries no purple colour on the label beside the drafts heading', async () => {
    // No accepted skill of Abu's on the shelf: its card carries a label with the same words.
    useDiscoveryStore.setState({ skills: [meta('my-notes', 'user')] });
    useSkillDraftsStore.setState({ drafts: [draft('meeting-notes')] });
    render(<SkillsSection source="mine" />);
    const label = await screen.findByText(tb().categoryAgentEvolvedBadge);
    expect(label.className).not.toContain('purple');
    expect(label).toHaveClass('bg-fill');
  });

  it('names each card switch after its skill', async () => {
    render(<SkillsSection source="mine" />);
    await screen.findByText('my-notes');
    expect(within(card('my-notes')).getByRole('switch', { name: 'my-notes' })).toBeInTheDocument();
    expect(within(card('team-rules')).getByRole('switch', { name: 'team-rules' })).toBeInTheDocument();
  });

  it('says nothing was found when a search matches no skill', async () => {
    useSettingsStore.getState().setExtensionsSearchQuery('skills', 'no-such-skill');
    render(<SkillsSection source="mine" />);
    expect(await screen.findByText(tb().noSkillsFound)).toBeInTheDocument();
    expect(screen.queryByTestId('skills-mine-create')).toBeNull();
    useSettingsStore.getState().setExtensionsSearchQuery('skills', '');
  });

  it('names the detail window after the skill, with a switch and a delete button of their own names', async () => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    const detail = screen.getByRole('dialog', { name: 'my-notes' });
    expect(within(detail).getByRole('switch', { name: 'my-notes' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: tb().deleteItem })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: tb().menuTrial })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: getI18n().common.close })).toBeInTheDocument();
  });

  it('opens a menu of export and history from the window; the user\'s own skill adds edit', async () => {
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    const trigger = screen.getByTestId('skill-detail-menu');
    expect(trigger).toHaveAccessibleName('Actions for my-notes');
    await user.click(trigger);

    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      tb().exportSkill, tb().historyMenuLabel, tb().skillEdit,
    ]);
  });

  it('offers export and history only for a skill that is not the user\'s own', async () => {
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('pdf-fill'));
    await user.click(screen.getByTestId('skill-detail-menu'));

    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      tb().exportSkill, tb().historyMenuLabel,
    ]);
  });

  it('closes only the menu on the first Escape, the window on the second', async () => {
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    await user.click(screen.getByTestId('skill-detail-menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.getByTestId('skill-detail')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('skill-detail')).toBeNull());
  });

  it('replaces the detail window with the history window', async () => {
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    await user.click(screen.getByTestId('skill-detail-menu'));
    await user.click(screen.getByRole('menuitem', { name: tb().historyMenuLabel }));

    const history = await screen.findByRole('dialog', { name: `${tb().historyModalTitle} — my-notes` });
    expect(history).toBeInTheDocument();
    expect(screen.queryByTestId('skill-detail')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(readHistory).toHaveBeenCalledWith('/skills/my-notes');
  });

  it('puts the focus on the card when the history window closes', async () => {
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    await user.click(screen.getByTestId('skill-detail-menu'));
    await user.click(screen.getByRole('menuitem', { name: tb().historyMenuLabel }));
    await screen.findByRole('dialog', { name: `${tb().historyModalTitle} — my-notes` });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(card('my-notes')).toHaveFocus());
  });
});

describe('SkillsSection · the editor takes the place of the list', () => {
  const card = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;
  const back = () => screen.getByRole('button', { name: getI18n().schedule.backToList });

  it('opens the editor from the window\'s menu with the focus on its way back, and returns it to the card', async () => {
    const user = userEvent.setup();
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    await user.click(screen.getByTestId('skill-detail-menu'));
    await user.click(screen.getByRole('menuitem', { name: tb().skillEdit }));

    await waitFor(() => expect(screen.getByPlaceholderText('my-skill')).toHaveValue('my-notes'));
    expect(screen.queryByTestId('skill-detail')).toBeNull();
    await waitFor(() => expect(back()).toHaveFocus());

    await user.click(back());

    await screen.findByText('team-rules');
    await waitFor(() => expect(card('my-notes')).toHaveFocus());
  });

  it('keeps the focus on the way back once the window that opened the editor has gone', async () => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(screen.getByTestId('skill-detail-menu'), { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));
      // The menu goes, the editor opens, and the window it replaced hands its focus back last.
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });

      expect(screen.getByPlaceholderText('my-skill')).toHaveValue('my-notes');
      expect(back()).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a blank editor from the page\'s create entry and returns the focus to the control that asked', async () => {
    const user = userEvent.setup();
    function Page() {
      const [trigger, setTrigger] = useState(0);
      return (
        <>
          <Button data-testid="skill-create-trigger" onClick={() => setTrigger((count) => count + 1)}>add</Button>
          <SkillsSection source="mine" manualCreateTrigger={trigger} />
        </>
      );
    }
    render(<Page />);
    await screen.findByText('my-notes');
    await user.click(screen.getByTestId('skill-create-trigger'));

    await waitFor(() => expect(screen.getByPlaceholderText('my-skill')).toHaveValue(''));
    await waitFor(() => expect(back()).toHaveFocus());

    await user.click(back());

    await screen.findByText('my-notes');
    expect(screen.getByTestId('skill-create-trigger')).toHaveFocus();
  });

  it('opens a blank editor from the empty shelf and returns the focus to its button', async () => {
    const user = userEvent.setup();
    useDiscoveryStore.setState({ skills: [] });
    render(<SkillsSection source="mine" />);
    await user.click(await screen.findByTestId('skills-mine-create'));

    await waitFor(() => expect(back()).toHaveFocus());
    await user.click(back());

    await waitFor(() => expect(screen.getByTestId('skills-mine-create')).toHaveFocus());
  });
});

describe('SkillsSection · after a skill is deleted', () => {
  const card = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;
  const realRefresh = useDiscoveryStore.getState().refresh;

  afterEach(() => {
    useDiscoveryStore.setState({ refresh: realRefresh });
    vi.mocked(remove).mockReset().mockResolvedValue(undefined);
  });

  // The skill's folder is removed and the next reading of the skills no longer lists it.
  function deletable(catalog: SkillMetadata[], name: string) {
    let gone = false;
    vi.mocked(skillLoader.getSkill).mockImplementation((asked: string) => {
      const m = catalog.find((s) => s.name === asked);
      return m && !(gone && asked === name) ? full(m) : undefined;
    });
    useDiscoveryStore.setState({
      skills: catalog,
      refresh: async () => {
        gone = true;
        useDiscoveryStore.setState({ skills: catalog.filter((s) => s.name !== name) });
      },
    });
  }

  const deleteFromWindow = async (name: string) => {
    fireEvent.click(await screen.findByText(name));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: tb().deleteItem }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: getI18n().common.delete }));
  };

  it('puts the focus on the card that took its place', async () => {
    deletable(CATALOG, 'my-notes');
    render(<SkillsSection source="mine" />);
    await deleteFromWindow('my-notes');

    await waitFor(() => expect(screen.queryByText('my-notes')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // docx was the second card and is the first now.
    await waitFor(() => expect(card('docx')).toHaveFocus());
  });

  it('puts the focus on the card before it when it was the last one', async () => {
    const catalog = [meta('first-skill', 'user'), meta('last-skill', 'user')];
    deletable(catalog, 'last-skill');
    render(<SkillsSection source="mine" />);
    await deleteFromWindow('last-skill');

    await waitFor(() => expect(screen.queryByText('last-skill')).toBeNull());
    await waitFor(() => expect(card('first-skill')).toHaveFocus());
  });

  it('puts the focus on the empty shelf\'s button when no card is left', async () => {
    const catalog = [meta('only-skill', 'user')];
    deletable(catalog, 'only-skill');
    render(<SkillsSection source="mine" />);
    await deleteFromWindow('only-skill');

    await waitFor(() => expect(screen.getByTestId('skills-mine-create')).toHaveFocus());
  });
});

/**
 * A design-system window stays on the page while it fades out, and keys still reach it.
 * What the window started must not start again from there.
 */
describe('SkillsSection · a window that is closing', () => {
  // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
  // layer has an exit animation: it stays on the page, as it does in the app while it fades out.
  let restoreStyles: (() => void) | null = null;
  function keepClosingLayersOnScreen() {
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    restoreStyles = () => spy.mockRestore();
  }
  const closingWindow = () => {
    const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
    if (!closing) throw new Error('No window is closing');
    return closing;
  };

  const startNewConversation = vi.fn();
  const setPendingInput = vi.fn();
  const closeExtensions = vi.fn();
  const real = {
    chat: { startNewConversation: useChatStore.getState().startNewConversation, setPendingInput: useChatStore.getState().setPendingInput },
    closeExtensions: useSettingsStore.getState().closeExtensions,
  };

  beforeEach(() => {
    useChatStore.setState({ startNewConversation, setPendingInput });
    useSettingsStore.setState({ closeExtensions });
  });
  afterEach(() => {
    useChatStore.setState(real.chat);
    useSettingsStore.setState({ closeExtensions: real.closeExtensions });
    restoreStyles?.();
    restoreStyles = null;
  });

  it('keeps showing the skill while it fades out', async () => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    keepClosingLayersOnScreen();
    fireEvent.keyDown(document, { key: 'Escape' });

    const closing = closingWindow();
    expect(within(closing).getByTestId('skill-detail')).toHaveTextContent('my-notes does things');
    expect(within(closing).getByText(tb().menuTrial)).toBeInTheDocument();
  });

  it('starts one task when the trial button is pressed again during the fade', async () => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    keepClosingLayersOnScreen();
    const trial = screen.getByText(tb().menuTrial).closest('button') as HTMLButtonElement;
    fireEvent.click(trial);
    expect(closingWindow()).toBeInTheDocument();

    fireEvent.click(within(closingWindow()).getByText(tb().menuTrial).closest('button') as HTMLButtonElement);

    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(setPendingInput).toHaveBeenCalledTimes(1);
    expect(closeExtensions).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when delete is pressed during the fade', async () => {
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    keepClosingLayersOnScreen();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(within(closingWindow()).getByText(tb().deleteItem).closest('button') as HTMLButtonElement);
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
