// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The skill detail window: the skill's own text, the files that ship with it,
 * and a viewer that reads one file at a time.
 */
import type { ReactElement } from 'react';
import { act, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { Button } from '@/components/ds/button';

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

import { getI18n } from '@/i18n';
import { skillLoader } from '@/core/skill/loader';
import type { Skill } from '@/types';
import SkillDetailPanel from './SkillDetailPanel';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const panel = () => getI18n().panel;

const skill: Skill = {
  name: 'weekly-digest',
  description: 'Writes the weekly digest',
  source: 'user',
  content: '# Weekly digest\n\nCollect the week.',
  filePath: '/skills/weekly-digest/SKILL.md',
  skillDir: '/skills/weekly-digest',
};

let listSupportingFiles: ReturnType<typeof vi.spyOn>;
let loadSupportingFile: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  listSupportingFiles = vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue(['notes.txt', 'guide.md', 'scripts/run.sh']);
  loadSupportingFile = vi.spyOn(skillLoader, 'loadSupportingFile').mockImplementation(async (_name: string, path: string) => `content of ${path}`);
});

describe('SkillDetailPanel', () => {
  it('renders no window without a skill', () => {
    render(<SkillDetailPanel skill={null} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('skill-detail')).toBeNull();
    expect(listSupportingFiles).not.toHaveBeenCalled();
  });

  it('shows the name, the description and the skill text', async () => {
    listSupportingFiles.mockResolvedValue([]);
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    const detail = await screen.findByTestId('skill-detail');
    expect(detail).toHaveTextContent('weekly-digest');
    expect(detail).toHaveTextContent('Writes the weekly digest');
    expect(screen.getByTestId('markdown')).toHaveTextContent('Collect the week.');
    // Without supporting files the viewer names the one file it shows.
    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
  });

  it('lists the files the skill ships with, folders first', async () => {
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(listSupportingFiles).toHaveBeenCalledWith('weekly-digest');
    expect(screen.getByText('guide.md')).toBeInTheDocument();
    expect(screen.getByText('scripts')).toBeInTheDocument();
    // A folder is closed until it is pressed.
    expect(screen.queryByText('run.sh')).toBeNull();
  });

  it('opens a folder and reads the file that is pressed', async () => {
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    await user.click(await screen.findByText('scripts'));
    await user.click(screen.getByText('run.sh'));

    await waitFor(() => expect(loadSupportingFile).toHaveBeenCalledWith('weekly-digest', 'scripts/run.sh'));
    expect(await screen.findByText('content of scripts/run.sh')).toBeInTheDocument();
    // Not a Markdown file: shown as it is written.
    expect(screen.queryByTestId('markdown')).toBeNull();
  });

  it('reads a Markdown file and shows it rendered, then as written, then rendered again', async () => {
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    await user.click(await screen.findByText('guide.md'));
    await waitFor(() => expect(loadSupportingFile).toHaveBeenCalledWith('weekly-digest', 'guide.md'));
    expect(await screen.findByTestId('markdown')).toHaveTextContent('content of guide.md');

    await user.click(screen.getByRole('button', { name: panel().sourceMode }));
    expect(screen.queryByTestId('markdown')).toBeNull();
    expect(screen.getByText('content of guide.md').tagName).toBe('PRE');

    await user.click(screen.getByRole('button', { name: panel().previewMode }));
    expect(screen.getByTestId('markdown')).toHaveTextContent('content of guide.md');
  });

  it('returns to the skill text when SKILL.md is pressed', async () => {
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    await user.click(await screen.findByText('notes.txt'));
    expect(await screen.findByText('content of notes.txt')).toBeInTheDocument();

    await user.click(screen.getAllByText('SKILL.md')[0]);

    expect(await screen.findByTestId('markdown')).toHaveTextContent('Collect the week.');
    expect(loadSupportingFile).toHaveBeenCalledTimes(1);
  });

  it('shows an empty file list when the files cannot be read', async () => {
    listSupportingFiles.mockRejectedValue(new Error('gone'));
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    expect(await screen.findByTestId('markdown')).toHaveTextContent('Collect the week.');
    expect(screen.queryByText('notes.txt')).toBeNull();
  });

  it('renders the actions and the footer its owner passes', async () => {
    render(
      <SkillDetailPanel
        skill={skill}
        onClose={vi.fn()}
        headerActions={<Button data-probe="header">header action</Button>}
        footer={<Button data-probe="footer">footer action</Button>}
      />,
    );
    expect(await screen.findByRole('button', { name: 'header action' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'footer action' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={onClose} />);
    await screen.findByTestId('skill-detail');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SkillDetailPanel · design-system controls', () => {
  it('is a window named after the skill, with a named close button', async () => {
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'weekly-digest' });
    expect(within(dialog).getByRole('button', { name: getI18n().common.close })).toBeInTheDocument();
    // The heading inside adds the word for what it is.
    expect(within(dialog).getByRole('heading', { level: 2, name: 'weekly-digest Skill' })).toBeInTheDocument();
  });

  it('names the two view buttons in the interface language and says which one is on', async () => {
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    const preview = await screen.findByRole('button', { name: panel().previewMode });
    const source = screen.getByRole('button', { name: panel().sourceMode });
    expect(preview).toHaveAttribute('aria-pressed', 'true');
    expect(source).toHaveAttribute('aria-pressed', 'false');

    await user.click(source);

    expect(preview).toHaveAttribute('aria-pressed', 'false');
    expect(source).toHaveAttribute('aria-pressed', 'true');
  });

  it('lists each file as a button, says which one is shown and whether a folder is open', async () => {
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    const skillFile = await screen.findByRole('button', { name: 'SKILL.md' });
    const notes = screen.getByRole('button', { name: 'notes.txt' });
    const folder = screen.getByRole('button', { name: 'scripts' });
    expect(skillFile).toHaveAttribute('aria-current', 'true');
    expect(skillFile).toHaveClass('bg-fill-selected');
    expect(notes).not.toHaveAttribute('aria-current');
    expect(folder).toHaveAttribute('aria-expanded', 'false');

    await user.click(folder);
    await user.click(notes);

    expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect(notes).toHaveAttribute('aria-current', 'true');
    expect(skillFile).not.toHaveAttribute('aria-current');
  });

  it('says it is loading, with one spinner, while a file is read', async () => {
    let finish: (content: string) => void = () => {};
    loadSupportingFile.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'notes.txt' }));

    const waiting = screen.getAllByRole('status');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toHaveTextContent(getI18n().common.loading);

    await act(async () => { finish('the notes'); });

    expect(await screen.findByText('the notes')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps showing the skill and the file on screen while the window fades out', async () => {
    const user = userEvent.setup();
    const view = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} footer={<Button>footer action</Button>} />);
    await user.click(await screen.findByRole('button', { name: 'notes.txt' }));
    await screen.findByText('content of notes.txt');

    // happy-dom reports no animation, so Radix removes a closed layer at once. With this, the
    // closed window has an exit animation: it stays on the page, as it does in the app while it fades out.
    const real = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const computed = real(element, pseudo);
      return new Proxy(computed, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    view.rerender(<SkillDetailPanel skill={null} onClose={vi.fn()} footer={<Button>footer action</Button>} />);

    const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
    expect(closing).not.toBeNull();
    expect(closing).toHaveTextContent('Writes the weekly digest');
    expect(closing).toHaveTextContent('content of notes.txt');
    expect(closing).toHaveTextContent('footer action');
    styles.mockRestore();
  });

  it('opens on the skill text again when the same skill is opened a second time', async () => {
    const user = userEvent.setup();
    const view = render(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'notes.txt' }));
    await screen.findByText('content of notes.txt');

    view.rerender(<SkillDetailPanel skill={null} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.rerender(<SkillDetailPanel skill={skill} onClose={vi.fn()} />);

    expect(await screen.findByTestId('markdown')).toHaveTextContent('Collect the week.');
    expect(await screen.findByRole('button', { name: 'SKILL.md' })).toHaveAttribute('aria-current', 'true');
  });
});
