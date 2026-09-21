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

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

import { getI18n } from '@/i18n';
import type { Skill, SkillMetadata } from '@/types';
import { skillLoader } from '@/core/skill/loader';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useSettingsStore } from '@/stores/settingsStore';
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
    fireEvent.keyDown(window, { key: 'Escape' });
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
    render(<SkillsSection source={name === 'pdf-fill' ? 'market' : 'mine'} />);
    fireEvent.click(await screen.findByText(name));
    expect(screen.getByTestId('skill-detail')).toBeVisible();
    fireEvent.click(screen.getByTestId('skill-detail-menu'));
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
    render(<SkillsSection source="mine" />);
    fireEvent.click(await screen.findByText(name));
    fireEvent.click(screen.getByTestId('skill-detail-menu'));
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
});
