// @vitest-environment happy-dom
/**
 * 「我的」 for the Skills tab. `sourceFilter="mine"` narrows the list to skills
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
import SkillsSection from './SkillsSection';

const tb = () => getI18n().toolbox;

const meta = (name: string, source: SkillMetadata['source']): SkillMetadata =>
  ({ name, description: `${name} does things`, source });

const CATALOG: SkillMetadata[] = [
  meta('my-notes', 'user'),
  meta('auto-thing', 'workspace-auto'),
  meta('cross-client', 'standard'),
  meta('team-rules', 'project'),
  meta('weather-report', 'plugin'),
  meta('expense-policy', 'enterprise'),
  meta('pdf-fill', 'builtin'),
];

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
  vi.spyOn(skillLoader, 'getSkill').mockImplementation((name: string) => {
    const m = CATALOG.find((s) => s.name === name);
    return m ? full(m) : undefined;
  });
  vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([]);
  vi.spyOn(skillLoader, 'loadSupportingFile').mockResolvedValue(null);
});

describe('SkillsSection · sourceFilter="mine"', () => {
  it('lists the user\'s own, project and standard skills', async () => {
    render(<SkillsSection sourceFilter="mine" />);
    for (const name of ['my-notes', 'auto-thing', 'cross-client', 'team-rules']) {
      expect(await screen.findByText(name)).toBeTruthy();
    }
  });

  it('drops plugin-, organization- and builtin-shipped skills', async () => {
    render(<SkillsSection sourceFilter="mine" />);
    await screen.findByText('my-notes');
    expect(screen.queryByText('weather-report')).toBeNull();
    expect(screen.queryByText('expense-policy')).toBeNull();
    expect(screen.queryByText('pdf-fill')).toBeNull();
  });

  it('says 还没有你创建的技能 when everything came from outside', async () => {
    useDiscoveryStore.setState({
      skills: [meta('weather-report', 'plugin'), meta('pdf-fill', 'builtin')],
    });
    render(<SkillsSection sourceFilter="mine" />);
    expect(await screen.findByText(tb().skillsMineEmptyTitle)).toBeTruthy();
  });

  it('opens the shared detail panel on a card', async () => {
    render(<SkillsSection sourceFilter="mine" />);
    fireEvent.click(await screen.findByText('my-notes'));
    const detail = screen.getByTestId('skill-detail');
    expect(within(detail).getByText('my-notes does things')).toBeTruthy();
    // Escape closes it — the panel still owns the modal chrome after the split.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('skill-detail')).toBeNull();
  });

  it('keeps every source without the filter', async () => {
    render(<SkillsSection />);
    expect(await screen.findByText('my-notes')).toBeTruthy();
    expect(screen.getByText('weather-report')).toBeTruthy();
    expect(screen.getByText('pdf-fill')).toBeTruthy();
  });
});
