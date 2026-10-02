// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import SoulSection from './SoulSection';

// The personality file is a made-up string here; nothing reads or writes ~/.abu/SOUL.md.
const DEFAULT_TEMPLATE = '# Tone\nShort and direct.';
const soulFile = vi.hoisted(() => ({ content: '' }));
vi.mock('@/core/agent/soulConfig', () => ({
  loadSoul: vi.fn(async () => soulFile.content),
  saveSoul: vi.fn(async () => undefined),
  getDefaultSoulTemplate: () => '# Tone\nShort and direct.',
}));
import { loadSoul, saveSoul } from '@/core/agent/soulConfig';

const originals = useSettingsStore.getState();
const setProactivity = vi.fn();
const show = () => render(<SoulSection />, { wrapper: DesignSystemProvider });
const editor = () => screen.findByPlaceholderText('用 markdown 描述阿布的性格...');
const card = (name: RegExp) => screen.getByRole('button', { name });
// The question that restoring the default asks, and its two answers.
const question = () => screen.findByRole('alertdialog', { name: '恢复默认性格' });
const answer = async (name: string) => fireEvent.click(within(await question()).getByRole('button', { name }));
// Reading the file and a save each take a promise turn or two.
const settled = async () => { for (let turn = 0; turn < 6; turn += 1) await act(async () => { await Promise.resolve(); }); };

describe('SoulSection', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    soulFile.content = '';
    vi.mocked(loadSoul).mockClear();
    vi.mocked(saveSoul).mockReset();
    vi.mocked(saveSoul).mockResolvedValue(undefined);
    setProactivity.mockClear();
    useSettingsStore.setState((state) => ({ soul: { ...state.soul, proactivity: 'companion' }, setProactivity }));
  });
  afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({ soul: originals.soul, setProactivity: originals.setProactivity });
  });

  describe('the page', () => {
    it('shows one loading sign and nothing else until the file has been read', async () => {
      let finish: (content: string) => void = () => undefined;
      vi.mocked(loadSoul).mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      show();
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(1);
      expect(screen.queryByRole('heading', { name: '性格' })).toBeNull();
      await act(async () => { finish('# Mine'); });
      expect(await editor()).toHaveValue('# Mine');
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(0);
    });

    it('keeps the title, the explanation, the proactivity picker above the text, and the file note', async () => {
      show();
      const field = await editor();
      expect(screen.getByRole('heading', { level: 3, name: '性格' })).toBeInTheDocument();
      expect(screen.getByText('阿布出厂自带性格，你可以按自己的喜好调整')).toBeInTheDocument();
      const picker = screen.getByRole('heading', { level: 4, name: '主动度' });
      expect(picker.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText('文件位置：~/.abu/SOUL.md（高级用户可直接编辑）')).toBeInTheDocument();
    });

    it('shows the saved personality, or the default one when nothing was saved', async () => {
      soulFile.content = '# Mine\nPlayful.';
      const first = show();
      expect(await editor()).toHaveValue('# Mine\nPlayful.');
      expect(screen.getByText('15 / 2000')).toBeInTheDocument();
      first.unmount();

      soulFile.content = '';
      show();
      expect(await editor()).toHaveValue(DEFAULT_TEMPLATE);
      // Nothing to restore while the text is the default one.
      expect(screen.queryByRole('button', { name: '恢复默认' })).toBeNull();
    });
  });

  describe('editing', () => {
    it('saves what was typed once typing has paused, and says so', async () => {
      const field = await (show(), editor());
      vi.useFakeTimers();
      fireEvent.change(field, { target: { value: '# Mine' } });
      fireEvent.change(field, { target: { value: '# Mine\nPlayful.' } });
      expect(saveSoul).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(799); });
      expect(saveSoul).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(vi.mocked(saveSoul).mock.calls).toEqual([['# Mine\nPlayful.']]);
      expect(screen.getByText('已保存')).toBeInTheDocument();
      // The note goes away by itself.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.queryByText('已保存')).toBeNull();
    });

    it('says it is saving while the file is being written', async () => {
      let finish: () => void = () => undefined;
      vi.mocked(saveSoul).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      const field = await (show(), editor());
      vi.useFakeTimers();
      fireEvent.change(field, { target: { value: '# Mine' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(screen.getByText('保存中...')).toBeInTheDocument();
      // Only words: nothing spins beside them.
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(0);
      await act(async () => { finish(); });
      expect(screen.getByText('已保存')).toBeInTheDocument();
    });

    it('does not save text that is back to what the file holds', async () => {
      soulFile.content = '# Mine';
      const field = await (show(), editor());
      vi.useFakeTimers();
      fireEvent.change(field, { target: { value: '# Mine!' } });
      fireEvent.change(field, { target: { value: '# Mine' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(saveSoul).not.toHaveBeenCalled();
    });

    it('counts the characters', async () => {
      const field = await (show(), editor());
      fireEvent.change(field, { target: { value: 'x'.repeat(2001) } });
      expect(screen.getByText('2001 / 2000')).toBeInTheDocument();
    });
  });

  describe('restoring the default', () => {
    it('writes nothing until the question is answered with 确认', async () => {
      soulFile.content = '# Mine';
      const user = userEvent.setup();
      show();
      await editor();
      await user.click(screen.getByRole('button', { name: '恢复默认' }));
      expect(within(await question()).getByText('当前自定义内容将被清除，恢复为出厂默认性格。确定要继续吗？')).toBeInTheDocument();
      expect(saveSoul).not.toHaveBeenCalled();

      await answer('取消');
      await settled();
      expect(saveSoul).not.toHaveBeenCalled();
      expect(await editor()).toHaveValue('# Mine');
    });

    it('clears the saved personality and shows the default text once confirmed', async () => {
      soulFile.content = '# Mine';
      const user = userEvent.setup();
      show();
      await editor();
      await user.click(screen.getByRole('button', { name: '恢复默认' }));
      await answer('确认');
      await settled();
      // An empty file is what "use the default" is stored as.
      expect(vi.mocked(saveSoul).mock.calls).toEqual([['']]);
      expect(await editor()).toHaveValue(DEFAULT_TEMPLATE);
      expect(screen.getByText('已保存')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '恢复默认' })).toBeNull();
    });

    it('drops a save that was still waiting for typing to pause', async () => {
      soulFile.content = '# Mine';
      const field = await (show(), editor());
      vi.useFakeTimers();
      fireEvent.change(field, { target: { value: '# Mine, edited' } });
      fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
      // The clock is stopped, so the question is looked up without waiting for it.
      const asked = screen.getByRole('alertdialog', { name: '恢复默认性格' });
      fireEvent.click(within(asked).getByRole('button', { name: '确认' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(vi.mocked(saveSoul).mock.calls).toEqual([['']]);
    });
  });

  describe('proactivity', () => {
    it('shows the three choices with their words, the current one marked', async () => {
      show();
      await editor();
      expect(screen.getByText('阿布在对话中要不要主动提议沉淀技能。害羞只在你明说时才建，伙伴明确可帮上时主动提议（推荐），管家每次成功任务都考虑提议。')).toBeInTheDocument();
      expect(card(/害羞/)).toHaveTextContent('🌱害羞你让我做才提议');
      expect(card(/伙伴/)).toHaveTextContent('🌿伙伴明确能帮上时主动提议（推荐）');
      expect(card(/管家/)).toHaveTextContent('🌳管家积极沉淀，每个成功任务都考虑建 skill');
    });

    it.each([
      [/害羞/, 'shy'],
      [/伙伴/, 'companion'],
      [/管家/, 'butler'],
    ] as const)('pressing %s sets %s', async (name, level) => {
      const user = userEvent.setup();
      show();
      await editor();
      await user.click(card(name));
      expect(setProactivity.mock.calls).toEqual([[level]]);
    });
  });

  describe('on the design system', () => {
    it('shows one spinner that says it is loading', async () => {
      let finish: (content: string) => void = () => undefined;
      vi.mocked(loadSoul).mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      show();
      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent('加载中...');
      await act(async () => { finish(''); });
      await editor();
    });

    it('asks before restoring in a question whose button says 确认', async () => {
      soulFile.content = '# Mine';
      const user = userEvent.setup();
      show();
      await editor();
      await user.click(screen.getByRole('button', { name: '恢复默认' }));
      const asked = await screen.findByRole('alertdialog', { name: '恢复默认性格' });
      expect(within(asked).getAllByRole('button').map((button) => button.textContent)).toEqual(['取消', '确认']);
    });

    it('marks the chosen proactivity card as pressed, and only that one', async () => {
      useSettingsStore.setState((state) => ({ soul: { ...state.soul, proactivity: 'butler' } }));
      show();
      await editor();
      expect(card(/害羞/)).toHaveAttribute('aria-pressed', 'false');
      expect(card(/伙伴/)).toHaveAttribute('aria-pressed', 'false');
      expect(card(/管家/)).toHaveAttribute('aria-pressed', 'true');
      expect(card(/管家/)).toHaveClass('bg-fill-selected');
      expect(card(/害羞/)).not.toHaveClass('bg-fill-selected');
    });

    it('changes nothing when an arrow key is pressed on a card; Enter and Space choose it', async () => {
      const user = userEvent.setup();
      show();
      await editor();
      card(/害羞/).focus();
      await user.keyboard('{ArrowRight}{ArrowLeft}{ArrowDown}{ArrowUp}');
      expect(setProactivity).not.toHaveBeenCalled();
      expect(card(/害羞/)).toHaveFocus();

      await user.keyboard('{Enter}');
      expect(setProactivity.mock.calls).toEqual([['shy']]);
      card(/管家/).focus();
      await user.keyboard(' ');
      expect(setProactivity.mock.calls).toEqual([['shy'], ['butler']]);
    });
  });
});
