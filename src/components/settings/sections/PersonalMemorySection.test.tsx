// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { MemoryHeader, MemorySource, MemoryType } from '@/core/memdir/types';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import PersonalMemorySection from './PersonalMemorySection';

// A made-up disk: which folder holds which memories, and what each file says. Deleting and
// editing change it, so the list the page reads again is the list a real disk would give.
// Nothing here touches a real memory folder.
const disk = vi.hoisted(() => ({
  folders: new Map<string | null, { filename: string }[]>(),
  bodies: new Map<string, string>(),
  // Set to hold the next read of the list until the test lets it through.
  gate: null as Promise<void> | null,
}));
vi.mock('@/core/memdir/scan', () => ({
  scanMemoryFiles: vi.fn(async (workspacePath: string | null) => {
    if (disk.gate) await disk.gate;
    return [...(disk.folders.get(workspacePath) ?? [])];
  }),
  readMemoryFile: vi.fn(async (filePath: string) => {
    const content = disk.bodies.get(filePath);
    return content === undefined ? null : { content };
  }),
}));
vi.mock('@/core/memdir/write', () => ({
  deleteMemory: vi.fn(async (filename: string, workspacePath: string | null) => {
    disk.folders.set(workspacePath, (disk.folders.get(workspacePath) ?? []).filter((file) => file.filename !== filename));
  }),
  setMemoryPrivate: vi.fn(async () => undefined),
  setMemoryDescription: vi.fn(async () => undefined),
}));
// The real age text, with each call written down. A memory row asks for its age once every time
// it is drawn, so the calls say which rows were drawn again.
const ageCalls = vi.hoisted(() => ({ updated: [] as number[] }));
vi.mock('@/core/memdir/age', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/memdir/age')>();
  return {
    ...actual,
    memoryAge: (updated: number) => {
      ageCalls.updated.push(updated);
      return actual.memoryAge(updated);
    },
  };
});
import { readMemoryFile, scanMemoryFiles } from '@/core/memdir/scan';
import { deleteMemory, setMemoryDescription, setMemoryPrivate } from '@/core/memdir/write';

const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const DAY = 86_400_000;
const ALPHA = '/work/alpha';

function memory(filename: string, name: string, type: MemoryType, source: MemorySource, daysOld: number, more: Partial<MemoryHeader> = {}): MemoryHeader {
  return {
    filename,
    filePath: `/memory/${filename}`,
    name,
    description: `${name} note`,
    type,
    source,
    created: NOW - daysOld * DAY,
    updated: NOW - daysOld * DAY,
    accessCount: 0,
    private: false,
    ...more,
  };
}

const coffee = memory('user_coffee.md', 'Coffee order', 'user', 'agent_explicit', 1);
// Extracted automatically and untouched for 90 days.
const tone = memory('feedback_tone.md', 'Reply tone', 'feedback', 'auto_flush', 90);
// Untouched for 100 days, written by the user, already private.
const wiki = memory('reference_wiki.md', 'Team wiki', 'reference', 'user_manual', 100, { private: true });
const stack = memory('project_stack.md', 'Tech stack', 'project', 'auto_flush', 2);
// Its description gives a value away (it holds digits).
const passport = memory('user_passport.md', 'Passport', 'user', 'agent_explicit', 0, { description: 'Passport number 12345678' });

function fillDisk() {
  // Stored oldest first: the page orders each folder newest first.
  disk.folders = new Map<string | null, { filename: string }[]>([[null, [wiki, tone, coffee]], [ALPHA, [stack, passport]]]);
  disk.bodies = new Map([[coffee.filePath, 'Oat flat white, no sugar.'], [stack.filePath, 'React and Vite.']]);
  disk.gate = null;
}

const originals = useSettingsStore.getState();
const show = () => render(<PersonalMemorySection />, { wrapper: DesignSystemProvider });
async function showList() {
  const view = show();
  await screen.findByText('Coffee order');
  return view;
}
// The memory titles in the order the page shows them.
const TITLES = ['Coffee order', 'Reply tone', 'Team wiki', 'Passport', 'Tech stack'];
function shownTitles(): string[] {
  return TITLES
    .map((title) => screen.queryByText(title))
    .filter((element): element is HTMLElement => element !== null)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((element) => element.textContent ?? '');
}
const group = (name: RegExp) => screen.getByRole('button', { name });
const toolbar = (name: string) => screen.getByRole('button', { name });
const deletedFiles = () => vi.mocked(deleteMemory).mock.calls.map(([filename, workspacePath]) => `${workspacePath ?? 'global'}:${filename}`);
// The row's delete button and the two answers of the question it asks.
const deleteButton = () => screen.getByRole('button', { name: '删除' });
const question = (title: string) => screen.findByRole('alertdialog', { name: title });
const answer = async (title: string, name: string) => fireEvent.click(within(await question(title)).getByRole('button', { name }));
// What the page does after a write: one promise turn for the write, a few for reading the list again.
const settled = async () => { for (let turn = 0; turn < 8; turn += 1) await act(async () => { await Promise.resolve(); }); };

describe('PersonalMemorySection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    initLanguage('zh-CN');
    fillDisk();
    vi.mocked(scanMemoryFiles).mockClear();
    vi.mocked(readMemoryFile).mockClear();
    vi.mocked(deleteMemory).mockClear();
    vi.mocked(setMemoryPrivate).mockClear();
    vi.mocked(setMemoryDescription).mockClear();
    useWorkspaceStore.setState({ recentPaths: [ALPHA] });
    // The privacy check has run: these tests are about the page, not about that window.
    useSettingsStore.setState({ hasRunSensitiveAudit_v015: true, shouldRunMemoryAudit: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({
      hasRunSensitiveAudit_v015: originals.hasRunSensitiveAudit_v015,
      shouldRunMemoryAudit: originals.shouldRunMemoryAudit,
    });
    useWorkspaceStore.setState({ recentPaths: [] });
  });

  describe('the list', () => {
    it('keeps the title, the explanation and the count', async () => {
      await showList();
      expect(screen.getByRole('heading', { level: 3, name: '记忆' })).toBeInTheDocument();
      expect(screen.getByText('阿布记住的关于你的偏好和习惯，跨所有项目生效。')).toBeInTheDocument();
      expect(screen.getByText('5 条记忆')).toBeInTheDocument();
    });

    it('groups memories by where they live, global first, newest first inside a group', async () => {
      await showList();
      expect(vi.mocked(scanMemoryFiles).mock.calls).toEqual([[null], [ALPHA]]);
      expect(group(/全局记忆/)).toHaveTextContent('全局记忆(3)');
      expect(group(/alpha/)).toHaveTextContent('alpha(2)');
      expect(shownTitles()).toEqual(TITLES);
      expect(group(/全局记忆/).compareDocumentPosition(group(/alpha/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows each memory with its type, its age and its markers', async () => {
      await showList();
      // user, feedback, reference, user, project.
      expect(screen.getAllByText('偏好')).toHaveLength(2);
      expect(screen.getByText('反馈')).toBeInTheDocument();
      expect(screen.getByText('事实')).toBeInTheDocument();
      expect(screen.getByText('场景')).toBeInTheDocument();
      expect(screen.getByText('更新于 昨天')).toBeInTheDocument();
      expect(screen.getByText('更新于 今天')).toBeInTheDocument();
      // Two memories are older than 60 days; one is private.
      const stale = screen.getAllByText('陈旧');
      expect(stale).toHaveLength(2);
      for (const badge of stale) expect(badge.closest('[title]')).toHaveAttribute('title', '超过 60 天未更新，引用前请验证仍然适用');
      expect(document.querySelectorAll('[title="私密记忆 · 不会被自动注入对话"]')).toHaveLength(1);
      expect(screen.getByText('Team wiki').closest('div')).toContainElement(document.querySelector('[title="私密记忆 · 不会被自动注入对话"]') as HTMLElement);
    });

    it('folds a group away and unfolds it again', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(group(/全局记忆/));
      expect(shownTitles()).toEqual(['Passport', 'Tech stack']);
      // The count still says how many it holds.
      expect(group(/全局记忆/)).toHaveTextContent('全局记忆(3)');
      await user.click(group(/全局记忆/));
      expect(shownTitles()).toEqual(TITLES);
    });

    it('skips a workspace whose memories cannot be read', async () => {
      useWorkspaceStore.setState({ recentPaths: ['/work/locked', ALPHA] });
      vi.mocked(scanMemoryFiles).mockImplementationOnce(async () => [...(disk.folders.get(null) ?? [])] as MemoryHeader[]);
      vi.mocked(scanMemoryFiles).mockImplementationOnce(async () => { throw new Error('unreadable'); });
      await showList();
      expect(shownTitles()).toEqual(TITLES);
    });

    it('shows one loading sign while the list is being read, and nothing else', async () => {
      let open: () => void = () => undefined;
      disk.gate = new Promise<void>((resolve) => { open = resolve; });
      show();
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(1);
      expect(screen.queryByText('Coffee order')).toBeNull();
      expect(screen.queryByText('项目记忆 · 暂无')).toBeNull();
      disk.gate = null;
      await act(async () => { open(); });
      await screen.findByText('Coffee order');
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(0);
    });

    it('says so when there is nothing remembered yet', async () => {
      disk.folders = new Map();
      show();
      expect(await screen.findByText('项目记忆 · 暂无')).toBeInTheDocument();
      expect(screen.getByText('对话时 AI 会自动积累记忆，或你可以让 AI "记住这个"')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '批量整理' })).toBeNull();
    });
  });

  describe('the privacy check', () => {
    it('asks for the one-time check when the page opens before it has run', async () => {
      useSettingsStore.setState({ hasRunSensitiveAudit_v015: false });
      await showList();
      expect(useSettingsStore.getState().shouldRunMemoryAudit).toBe(true);
    });

    it('asks for nothing once the check has run', async () => {
      await showList();
      expect(useSettingsStore.getState().shouldRunMemoryAudit).toBe(false);
    });
  });

  describe('one memory', () => {
    it('opens to show what the file says and where it came from, and reads the file once', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Coffee order'));
      expect(await screen.findByText('Oat flat white, no sugar.')).toBeInTheDocument();
      expect(vi.mocked(readMemoryFile).mock.calls).toEqual([[coffee.filePath]]);
      expect(screen.getByText('AI 主动记忆')).toBeInTheDocument();
      expect(screen.getByText('私密记忆')).toBeInTheDocument();

      await user.click(screen.getByText('Coffee order'));
      expect(screen.queryByText('Oat flat white, no sugar.')).toBeNull();
      await user.click(screen.getByText('Coffee order'));
      expect(screen.getByText('Oat flat white, no sugar.')).toBeInTheDocument();
      expect(readMemoryFile).toHaveBeenCalledTimes(1);
    });

    it('shows the description when the file cannot be read, and only one memory open at a time', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Reply tone'));
      expect(await screen.findByText('Reply tone note')).toBeInTheDocument();
      expect(screen.getByText('自动提取')).toBeInTheDocument();
      await user.click(screen.getByText('Team wiki'));
      expect(await screen.findByText('Team wiki note')).toBeInTheDocument();
      expect(screen.queryByText('Reply tone note')).toBeNull();
      expect(screen.getByText('手动添加')).toBeInTheDocument();
    });

    it('turns private on for the memory in its own folder and reads the list again', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Tech stack'));
      const privateSwitch = await screen.findByRole('switch');
      expect(privateSwitch).not.toBeChecked();
      vi.mocked(scanMemoryFiles).mockClear();
      await user.click(privateSwitch);
      await settled();
      expect(vi.mocked(setMemoryPrivate).mock.calls).toEqual([[stack.filename, true, ALPHA]]);
      expect(vi.mocked(scanMemoryFiles).mock.calls).toEqual([[null], [ALPHA]]);
      // Its description names a topic only, so nothing more is asked.
      expect(screen.queryByText('当前描述可能含敏感内容')).toBeNull();
    });

    it('turns private off for a private memory', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Team wiki'));
      const privateSwitch = await screen.findByRole('switch');
      expect(privateSwitch).toBeChecked();
      await user.click(privateSwitch);
      await settled();
      expect(vi.mocked(setMemoryPrivate).mock.calls).toEqual([[wiki.filename, false, null]]);
    });

    it('offers a topic-only description when a memory made private has a telling one, and saves the edited text', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Passport'));
      await user.click(await screen.findByRole('switch'));
      expect(await screen.findByText('当前描述可能含敏感内容')).toBeInTheDocument();
      // The description appears as the opened text and once more as the struck-through current one.
      expect(screen.getAllByText('Passport number 12345678')).toHaveLength(2);
      const field = screen.getByPlaceholderText('只写主题，例如"个人证件"、"银行账户"');
      // The suggestion is the memory's title.
      expect(field).toHaveValue('Passport');

      fireEvent.change(field, { target: { value: '  Travel documents  ' } });
      await user.click(screen.getByRole('button', { name: '保存' }));
      await settled();
      expect(vi.mocked(setMemoryDescription).mock.calls).toEqual([[passport.filename, 'Travel documents', ALPHA]]);
      expect(screen.queryByText('当前描述可能含敏感内容')).toBeNull();
    });

    it('saves nothing for an empty description, and nothing when the suggestion is declined', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Passport'));
      await user.click(await screen.findByRole('switch'));
      const field = await screen.findByPlaceholderText('只写主题，例如"个人证件"、"银行账户"');
      fireEvent.change(field, { target: { value: '   ' } });
      expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: '保持原样' }));
      expect(screen.queryByText('当前描述可能含敏感内容')).toBeNull();
      expect(setMemoryDescription).not.toHaveBeenCalled();
    });

    it('deletes nothing until the question is answered with 删除', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Tech stack'));
      await user.click(deleteButton());
      await question('删除记忆');
      expect(deleteMemory).not.toHaveBeenCalled();

      await answer('删除记忆', '取消');
      await settled();
      expect(deleteMemory).not.toHaveBeenCalled();
      expect(screen.getByText('Tech stack')).toBeInTheDocument();
    });

    it('deletes that memory from its own folder once confirmed, and reads the list again', async () => {
      const user = userEvent.setup();
      await showList();
      await user.click(screen.getByText('Tech stack'));
      await user.click(deleteButton());
      await answer('删除记忆', '删除');
      await waitFor(() => expect(screen.queryByText('Tech stack')).toBeNull());
      expect(vi.mocked(deleteMemory).mock.calls).toEqual([[stack.filename, ALPHA]]);
      expect(screen.getByText('4 条记忆')).toBeInTheDocument();
    });
  });

  describe('tidying up many at once', () => {
    async function tidy() {
      const user = userEvent.setup();
      await showList();
      await user.click(toolbar('批量整理'));
      return user;
    }

    it('starts with nothing ticked and cannot delete', async () => {
      await tidy();
      expect(screen.getByText('已选 0 条')).toBeInTheDocument();
      expect(toolbar('删除选中')).toBeDisabled();
      expect(screen.queryByText('5 条记忆')).toBeNull();
    });

    it('ticks what each of the three shortcuts stands for, and unticks everything', async () => {
      const user = await tidy();
      await user.click(toolbar('勾选自动提取且陈旧'));
      expect(screen.getByText('已选 1 条')).toBeInTheDocument();
      await user.click(toolbar('勾选所有陈旧记忆'));
      expect(screen.getByText('已选 2 条')).toBeInTheDocument();
      await user.click(toolbar('全选'));
      expect(screen.getByText('已选 5 条')).toBeInTheDocument();
      await user.click(toolbar('清空选择'));
      expect(screen.getByText('已选 0 条')).toBeInTheDocument();
      expect(toolbar('删除选中')).toBeDisabled();
    });

    it('ticks and unticks one memory when its row is pressed, without opening it', async () => {
      const user = await tidy();
      await user.click(screen.getByText('Coffee order'));
      expect(screen.getByText('已选 1 条')).toBeInTheDocument();
      expect(readMemoryFile).not.toHaveBeenCalled();
      await user.click(screen.getByText('Coffee order'));
      expect(screen.getByText('已选 0 条')).toBeInTheDocument();
    });

    it('leaves with nothing ticked, and nothing is still ticked on the way back in', async () => {
      const user = await tidy();
      await user.click(toolbar('全选'));
      await user.click(toolbar('退出整理'));
      expect(screen.getByText('5 条记忆')).toBeInTheDocument();
      expect(deleteMemory).not.toHaveBeenCalled();
      await user.click(toolbar('批量整理'));
      expect(screen.getByText('已选 0 条')).toBeInTheDocument();
    });

    it('deletes nothing until the question is answered with 删除', async () => {
      const user = await tidy();
      await user.click(toolbar('勾选所有陈旧记忆'));
      await user.click(toolbar('删除选中'));
      const asked = await question('批量删除记忆');
      expect(within(asked).getByText('将永久删除 2 条记忆，此操作不可撤销')).toBeInTheDocument();
      expect(deleteMemory).not.toHaveBeenCalled();

      await answer('批量删除记忆', '取消');
      await settled();
      expect(deleteMemory).not.toHaveBeenCalled();
      expect(screen.getByText('已选 2 条')).toBeInTheDocument();
    });

    it('deletes exactly the ticked memories, each from its own folder, then leaves tidying', async () => {
      const user = await tidy();
      await user.click(toolbar('勾选自动提取且陈旧'));
      await user.click(screen.getByText('Passport'));
      await user.click(toolbar('删除选中'));
      await answer('批量删除记忆', '删除');
      await waitFor(() => expect(screen.getByText('3 条记忆')).toBeInTheDocument());
      expect(deletedFiles()).toEqual([`global:${tone.filename}`, `${ALPHA}:${passport.filename}`]);
      expect(shownTitles()).toEqual(['Coffee order', 'Team wiki', 'Tech stack']);
    });

    it('goes on to the next memory when one cannot be deleted', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(deleteMemory).mockImplementationOnce(async () => { throw new Error('busy'); });
      const user = await tidy();
      await user.click(toolbar('勾选所有陈旧记忆'));
      await user.click(toolbar('删除选中'));
      await answer('批量删除记忆', '删除');
      await waitFor(() => expect(screen.getByText('4 条记忆')).toBeInTheDocument());
      expect(deletedFiles()).toEqual([`global:${tone.filename}`, `global:${wiki.filename}`]);
      logged.mockRestore();
    });
  });

  describe('on the design system', () => {
    // The page reads the list again when the recent workspaces change.
    async function readListAgain() {
      act(() => { useWorkspaceStore.setState({ recentPaths: [ALPHA, '/work/beta'] }); });
      await settled();
    }
    const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) });
    const tickedTitles = () => TITLES.filter((title) => box(title).getAttribute('aria-checked') === 'true');
    const typeTag = (label: string) => screen.getAllByText(label)[0];

    describe('deleting', () => {
      it('names the memory in the question', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(screen.getByText('Tech stack'));
        await user.click(screen.getByRole('button', { name: '删除' }));
        const asked = await screen.findByRole('alertdialog', { name: '删除记忆' });
        expect(within(asked).getByText('Tech stack')).toBeInTheDocument();
        expect(within(asked).getByRole('button', { name: '删除' })).toBeInTheDocument();
      });

      it('deletes nothing when the memory has left the list while the question was open', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(screen.getByText('Tech stack'));
        await user.click(screen.getByRole('button', { name: '删除' }));
        const asked = await screen.findByRole('alertdialog', { name: '删除记忆' });
        disk.folders.set(ALPHA, [passport]);
        await readListAgain();
        expect(screen.getByText('4 条记忆')).toBeInTheDocument();
        expect(screen.queryByText('Tech stack', { selector: 'button *' })).toBeNull();

        fireEvent.click(within(asked).getByRole('button', { name: '删除' }));
        await settled();
        expect(deleteMemory).not.toHaveBeenCalled();
      });

      it('deletes nothing when the file has become another memory while the question was open', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(screen.getByText('Tech stack'));
        await user.click(screen.getByRole('button', { name: '删除' }));
        const asked = await screen.findByRole('alertdialog', { name: '删除记忆' });
        disk.folders.set(ALPHA, [{ ...stack, name: 'Release plan' }, passport]);
        await readListAgain();

        fireEvent.click(within(asked).getByRole('button', { name: '删除' }));
        await settled();
        expect(deleteMemory).not.toHaveBeenCalled();
      });

      it('deletes only the ticked memories that are still there when the question is answered', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(toolbar('批量整理'));
        await user.click(box('Reply tone'));
        await user.click(box('Passport'));
        await user.click(toolbar('删除选中'));
        const asked = await screen.findByRole('alertdialog', { name: '批量删除记忆' });
        expect(within(asked).getByText('将永久删除 2 条记忆，此操作不可撤销')).toBeInTheDocument();
        disk.folders.set(ALPHA, [stack]);
        await readListAgain();

        fireEvent.click(within(asked).getByRole('button', { name: '删除' }));
        await settled();
        expect(deletedFiles()).toEqual([`global:${tone.filename}`]);
      });
    });

    describe('looks', () => {
      it.each(['orange', 'purple', 'teal', 'blue'])('no type tag is %s', async (palette) => {
        await showList();
        for (const label of ['偏好', '场景', '反馈', '事实']) expect(typeTag(label).className).not.toContain(palette);
      });

      it('gives all four types the same neutral tag', async () => {
        await showList();
        const looks = ['偏好', '场景', '反馈', '事实'].map((label) => typeTag(label).className);
        expect(new Set(looks).size).toBe(1);
        expect(typeTag('偏好')).toHaveClass('bg-fill');
      });

      it('shows one spinner that says it is loading', async () => {
        let open: () => void = () => undefined;
        disk.gate = new Promise<void>((resolve) => { open = resolve; });
        show();
        const spinners = document.querySelectorAll('[data-ds-spinner]');
        expect(spinners).toHaveLength(1);
        expect(spinners[0].parentElement).toHaveTextContent('加载中...');
        expect(screen.getByRole('status')).toHaveTextContent('加载中...');
        disk.gate = null;
        await act(async () => { open(); });
        await screen.findByText('Coffee order');
      });
    });

    describe('reading and keys', () => {
      it('explains the three kinds of memory in a panel that Escape closes', async () => {
        const user = userEvent.setup();
        await showList();
        expect(screen.queryByText('个人记忆（本页）')).toBeNull();
        await user.click(screen.getByRole('button', { name: '阿布的三层记忆' }));
        for (const name of ['个人记忆（本页）', '项目记忆（右侧面板）', '项目指令（右侧面板）']) {
          expect(screen.getByText(name)).toHaveClass('font-medium');
          expect(screen.getByText(name)).toHaveClass('text-label');
        }
        expect(screen.getByText(/^提示：个人记忆和项目记忆/)).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByText('个人记忆（本页）')).toBeNull());
      });

      // The button is an icon: its name shows when the keyboard reaches it.
      it('shows the name of the explanation button when the keyboard reaches it', async () => {
        const user = userEvent.setup();
        await showList();
        const info = screen.getByRole('button', { name: '阿布的三层记忆' });
        await user.tab();
        expect(info).toHaveFocus();
        expect(await screen.findByRole('tooltip')).toHaveTextContent('阿布的三层记忆');
        // It still opens the panel.
        await user.keyboard('{Enter}');
        expect(await screen.findByText('个人记忆（本页）')).toBeInTheDocument();
      });

      it('says whether a group and a memory are open, and opens a memory from the keyboard', async () => {
        const user = userEvent.setup();
        await showList();
        expect(group(/全局记忆/)).toHaveAttribute('aria-expanded', 'true');
        await user.click(group(/全局记忆/));
        expect(group(/全局记忆/)).toHaveAttribute('aria-expanded', 'false');

        const row = screen.getByRole('button', { name: /Tech stack/ });
        expect(row).toHaveAttribute('aria-expanded', 'false');
        row.focus();
        await user.keyboard('{Enter}');
        expect(row).toHaveAttribute('aria-expanded', 'true');
        expect(await screen.findByText('React and Vite.')).toBeInTheDocument();
      });

      it('names the private switch after the words beside it', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(screen.getByText('Tech stack'));
        expect(await screen.findByRole('switch', { name: '私密记忆' })).not.toBeChecked();
      });

      it('shows which memories each shortcut ticked', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(toolbar('批量整理'));
        expect(screen.getAllByRole('checkbox')).toHaveLength(5);
        await user.click(toolbar('勾选自动提取且陈旧'));
        expect(tickedTitles()).toEqual(['Reply tone']);
        await user.click(toolbar('勾选所有陈旧记忆'));
        expect(tickedTitles()).toEqual(['Reply tone', 'Team wiki']);
        await user.click(toolbar('全选'));
        expect(tickedTitles()).toEqual(TITLES);
        await user.click(toolbar('清空选择'));
        expect(tickedTitles()).toEqual([]);
        // The box takes Space; nothing else on the row reacts to it.
        box('Passport').focus();
        await user.keyboard(' ');
        expect(tickedTitles()).toEqual(['Passport']);
      });
    });

    describe('a long list stays still', () => {
      // How many days old each row drawn since the last call is; every memory here has its own age.
      const drawnAgain = () => ageCalls.updated.splice(0).map((updated) => Math.round((NOW - updated) / DAY));
      const many =(count: number) => Array.from({ length: count }, (_, index) => memory(`user_note_${index}.md`, `Note ${index}`, 'user', 'agent_explicit', index + 1));

      it('draws only the ticked row again when one memory is ticked', async () => {
        disk.folders = new Map<string | null, { filename: string }[]>([[null, many(40)]]);
        const user = userEvent.setup();
        show();
        await screen.findByText('Note 0');
        await user.click(toolbar('批量整理'));
        drawnAgain();
        await user.click(box('Note 7 '));
        // Note 7 is 8 days old.
        expect(drawnAgain()).toEqual([8]);
      });

      it('draws only the rows that open and close when a memory is opened', async () => {
        disk.folders = new Map<string | null, { filename: string }[]>([[null, many(40)]]);
        const user = userEvent.setup();
        show();
        await screen.findByText('Note 0');
        await user.click(screen.getByText('Note 3'));
        await screen.findByText('Note 3 note');
        drawnAgain();
        await user.click(screen.getByText('Note 9'));
        await screen.findByText('Note 9 note');
        // Notes 3 and 9 are 4 and 10 days old.
        expect(new Set(drawnAgain())).toEqual(new Set([4, 10]));
      });

      it('draws only the row being edited again while its description is typed', async () => {
        const user = userEvent.setup();
        await showList();
        await user.click(screen.getByText('Passport'));
        await user.click(await screen.findByRole('switch'));
        const field = await screen.findByPlaceholderText('只写主题，例如"个人证件"、"银行账户"');
        drawnAgain();
        fireEvent.change(field, { target: { value: 'Travel' } });
        fireEvent.change(field, { target: { value: 'Travel documents' } });
        // The passport memory was written today.
        expect(new Set(drawnAgain())).toEqual(new Set([0]));
      });
    });
  });
});
