// @vitest-environment happy-dom
/**
 * 「市场」 for the Skills tab: everything that arrived from outside the user's
 * own files — builtin, plugin-shipped and organization-pushed skills.
 *
 * These tests pin the two things a user can get wrong here: which skills count
 * as "not mine", and what the `···` menu offers. A plugin's skill has no
 * uninstall of its own — it leaves with its plugin — so offering one would
 * promise a removal this panel cannot perform.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { launchTrial } = vi.hoisted(() => ({ launchTrial: vi.fn() }));
vi.mock('@/components/toolbox/useTrialLauncher', () => ({ useTrialLauncher: () => launchTrial }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

import { getI18n } from '@/i18n';
import type { Skill, SkillMetadata } from '@/types';
import { skillLoader } from '@/core/skill/loader';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import ExternalSkillsPanel from './ExternalSkillsPanel';

const tb = () => getI18n().toolbox;

const meta = (name: string, source: SkillMetadata['source'], description = `${name} does things`): SkillMetadata =>
  ({ name, description, source });

const CATALOG: SkillMetadata[] = [
  meta('pdf-fill', 'builtin'),
  meta('weather-report', 'plugin'),
  meta('expense-policy', 'enterprise'),
  meta('my-notes', 'user'),
  meta('team-rules', 'project'),
  meta('cross-client', 'standard'),
  meta('auto-thing', 'workspace-auto'),
];

const full = (m: SkillMetadata): Skill => ({
  ...m,
  content: `# ${m.name}\nbody of ${m.name}`,
  filePath: `/skills/${m.name}/SKILL.md`,
  skillDir: `/skills/${m.name}`,
});

function rowFor(name: string): HTMLElement {
  const row = screen.getAllByTestId('external-skill-row').find((el) => within(el).queryByText(name));
  if (!row) throw new Error(`no external-skill-row for ${name}`);
  return row;
}

function openMenu(name: string): HTMLElement {
  const row = rowFor(name);
  fireEvent.click(within(row).getByTestId('skill-item-menu'));
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  useDiscoveryStore.setState({ skills: CATALOG });
  useSettingsStore.setState({ activeExtensionsTab: 'skills', disabledSkills: [] });
  vi.spyOn(skillLoader, 'getSkill').mockImplementation((name: string) => {
    const m = CATALOG.find((s) => s.name === name);
    return m ? full(m) : undefined;
  });
  vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([]);
  vi.spyOn(skillLoader, 'loadSupportingFile').mockResolvedValue(null);
});

describe('ExternalSkillsPanel', () => {
  it('shows skills without the plugin-market promotion', () => {
    render(<ExternalSkillsPanel searchQuery="" />);
    expect(screen.queryByText(tb().skillsMarketHintTitle)).toBeNull();
    expect(screen.queryByTestId('skills-market-go-plugins')).toBeNull();
    expect(screen.getAllByTestId('external-skill-row')).toHaveLength(3);
  });

  it('shows only the empty state when no external skills are installed', () => {
    useDiscoveryStore.setState({ skills: [meta('my-notes', 'user')] });
    render(<ExternalSkillsPanel searchQuery="" />);
    expect(screen.queryByTestId('skills-market-go-plugins')).toBeNull();
    expect(screen.getByText(tb().noSkillsFound)).toBeTruthy();
    expect(screen.queryAllByTestId('external-skill-row')).toHaveLength(0);
  });

  it('lists only skills that came from outside, each with its source badge', () => {
    render(<ExternalSkillsPanel searchQuery="" />);
    const rows = screen.getAllByTestId('external-skill-row');
    expect(rows).toHaveLength(3);
    expect(within(rowFor('pdf-fill')).getByText(tb().skillSourceBuiltin)).toBeTruthy();
    expect(within(rowFor('weather-report')).getByText(tb().skillSourcePlugin)).toBeTruthy();
    expect(within(rowFor('expense-policy')).getByText(tb().organizationSource)).toBeTruthy();
    for (const mine of ['my-notes', 'team-rules', 'cross-client', 'auto-thing']) {
      expect(screen.queryByText(mine)).toBeNull();
    }
  });

  it('offers only 立即试用 / 查看 on a plugin-shipped skill', () => {
    render(<ExternalSkillsPanel searchQuery="" />);
    const row = openMenu('weather-report');
    expect(within(row).getByTestId('skill-item-menu-trial').textContent).toBe(tb().menuTrial);
    expect(within(row).getByTestId('skill-item-menu-view').textContent).toBe(tb().menuView);
    expect(within(row).queryByTestId('skill-item-menu-uninstall')).toBeNull();
    expect(within(row).queryByTestId('skill-item-menu-delete')).toBeNull();
    expect(within(row).queryByTestId('skill-item-menu-remove')).toBeNull();
  });

  it('offers the same two actions on a builtin skill', () => {
    render(<ExternalSkillsPanel searchQuery="" />);
    const row = openMenu('pdf-fill');
    expect(within(row).getByTestId('skill-item-menu-trial')).toBeTruthy();
    expect(within(row).getByTestId('skill-item-menu-view')).toBeTruthy();
    expect(within(row).queryByTestId('skill-item-menu-uninstall')).toBeNull();
  });

  it('hands the skill name and description to the trial launcher', () => {
    render(<ExternalSkillsPanel searchQuery="" />);
    const row = openMenu('weather-report');
    fireEvent.click(within(row).getByTestId('skill-item-menu-trial'));
    expect(launchTrial).toHaveBeenCalledWith({
      name: 'weather-report',
      description: 'weather-report does things',
    });
  });

  it('opens the read-only detail from 查看', () => {
    render(<ExternalSkillsPanel searchQuery="" />);
    const row = openMenu('weather-report');
    fireEvent.click(within(row).getByTestId('skill-item-menu-view'));
    const detail = screen.getByTestId('skill-detail');
    expect(within(detail).getByText('weather-report does things')).toBeTruthy();
    expect(screen.getByTestId('markdown').textContent).toContain('body of weather-report');
  });

  /**
   * Silencing a skill is exactly what a user wants from a builtin or a
   * plugin-shipped one — the skills they did not choose. The row therefore
   * carries the same Toggle a 我的 card does, driven by the same
   * `settingsStore.disabledSkills`, so a skill's enabled state means one thing
   * no matter which half of the tab it is looked at from.
   */
  it('reflects the skill\'s enabled state in a toggle on the row', () => {
    useSettingsStore.setState({ disabledSkills: ['weather-report'] });
    render(<ExternalSkillsPanel searchQuery="" />);
    expect(within(rowFor('pdf-fill')).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(rowFor('weather-report')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('toggles through the same settingsStore action 「我的」 uses', () => {
    const toggleSkillEnabled = vi.spyOn(useSettingsStore.getState(), 'toggleSkillEnabled');
    render(<ExternalSkillsPanel searchQuery="" />);
    fireEvent.click(within(rowFor('pdf-fill')).getByRole('switch'));
    expect(toggleSkillEnabled).toHaveBeenCalledWith('pdf-fill');
    expect(useSettingsStore.getState().disabledSkills).toContain('pdf-fill');
    fireEvent.click(within(rowFor('pdf-fill')).getByRole('switch'));
    expect(useSettingsStore.getState().disabledSkills).not.toContain('pdf-fill');
  });

  it('narrows the list by the search query', () => {
    render(<ExternalSkillsPanel searchQuery="weather" />);
    expect(screen.getAllByTestId('external-skill-row')).toHaveLength(1);
    expect(screen.getByText('weather-report')).toBeTruthy();
  });
});
