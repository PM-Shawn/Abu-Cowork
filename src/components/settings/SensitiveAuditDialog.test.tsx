// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { SensitiveAuditResult, SensitivePatternId } from '@/core/memdir/sensitiveScan';
import type { MemoryHeader } from '@/core/memdir/types';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import PersonalMemorySection from './sections/PersonalMemorySection';
import SensitiveAuditDialog from './SensitiveAuditDialog';

// Made-up memories on a made-up disk: which folder holds which files, and which of them the
// privacy scan flags. Nothing here touches a real memory folder.
const disk = vi.hoisted(() => ({
  folders: new Map<string | null, unknown[]>(),
  flagged: new Map<string, string[]>(),
  unreadable: new Set<string>(),
}));
vi.mock('@/core/memdir/scan', () => ({
  scanMemoryFiles: vi.fn(async (workspacePath: string | null) => {
    if (workspacePath !== null && disk.unreadable.has(workspacePath)) throw new Error('unreadable');
    return [...(disk.folders.get(workspacePath) ?? [])];
  }),
  readMemoryFile: vi.fn(async () => null),
}));
vi.mock('@/core/memdir/sensitiveScan', () => ({
  auditMemories: vi.fn(async (headers: readonly MemoryHeader[]): Promise<SensitiveAuditResult[]> => headers
    .filter((header) => disk.flagged.has(header.filename))
    .map((header) => ({
      header,
      matches: (disk.flagged.get(header.filename) ?? []).map((patternId) => ({ patternId: patternId as SensitivePatternId, reason: '' })),
    }))),
}));
vi.mock('@/core/memdir/write', () => ({
  setMemoryPrivate: vi.fn(async () => undefined),
  setMemoryDescription: vi.fn(async () => undefined),
  deleteMemory: vi.fn(async () => undefined),
}));
import { scanMemoryFiles } from '@/core/memdir/scan';
import { setMemoryPrivate } from '@/core/memdir/write';

const WORKSPACE = '/work/alpha';

function memory(filename: string, name: string): MemoryHeader {
  return {
    filename,
    filePath: `/memory/${filename}`,
    name,
    description: `${name} description`,
    type: 'user',
    source: 'agent_explicit',
    created: 0,
    updated: 0,
    accessCount: 0,
    private: false,
  };
}

const passport = memory('user_passport.md', 'Passport');
const salary = memory('user_salary.md', 'Salary');
const coffee = memory('user_coffee.md', 'Coffee order');
const bank = memory('project_bank.md', 'Bank card');

const TITLE = '记忆安全检查';
const originals = useSettingsStore.getState();

// What the 记忆 page does when it opens: the settings window is on screen and the check is asked for.
function askForCheck() {
  act(() => { useSettingsStore.setState({ systemSettingsOpen: true, shouldRunMemoryAudit: true }); });
}
const show = () => render(<SensitiveAuditDialog />, { wrapper: DesignSystemProvider });
// Stands in for the settings window: a dialog that is open while the store says so.
function SettingsWindow() {
  const open = useSettingsStore((s) => s.systemSettingsOpen);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) useSettingsStore.setState({ systemSettingsOpen: false }); }} title="Settings" contentProps={{ 'data-settings-window': '' }}>
      <Button>Memory page</Button>
    </Dialog>
  );
}
const settingsWindow = () => document.querySelector('[data-settings-window]');
const checkWindow = () => screen.findByText(TITLE);
const entry = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) });
const later = () => screen.getByRole('button', { name: '稍后处理' });
const markAll = () => screen.getByRole('button', { name: '全部设为私密' });
// The scan and its answer take a few promise turns.
const settled = async () => { for (let turn = 0; turn < 8; turn += 1) await act(async () => { await Promise.resolve(); }); };

describe('SensitiveAuditDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    disk.folders = new Map<string | null, unknown[]>([[null, [passport, salary, coffee]], [WORKSPACE, [bank]]]);
    disk.flagged = new Map([
      [passport.filename, ['cn_id_card', 'mobile_phone']],
      [salary.filename, ['salary_keyword']],
      [bank.filename, ['bank_card']],
    ]);
    disk.unreadable = new Set();
    vi.mocked(scanMemoryFiles).mockClear();
    vi.mocked(setMemoryPrivate).mockReset();
    vi.mocked(setMemoryPrivate).mockResolvedValue(undefined);
    useWorkspaceStore.setState({ recentPaths: [WORKSPACE] });
    useSettingsStore.setState({ hasRunSensitiveAudit_v015: false, shouldRunMemoryAudit: false, systemSettingsOpen: false });
  });
  afterEach(() => {
    useSettingsStore.setState({
      hasRunSensitiveAudit_v015: originals.hasRunSensitiveAudit_v015,
      shouldRunMemoryAudit: originals.shouldRunMemoryAudit,
      systemSettingsOpen: originals.systemSettingsOpen,
    });
    useWorkspaceStore.setState({ recentPaths: [] });
  });

  describe('when the check runs', () => {
    it('scans nothing and shows nothing at startup, before the 记忆 page asks for the check', async () => {
      show();
      await settled();
      expect(scanMemoryFiles).not.toHaveBeenCalled();
      expect(screen.queryByText(TITLE)).toBeNull();
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);
    });

    it('never scans again once the check has been done', async () => {
      useSettingsStore.setState({ hasRunSensitiveAudit_v015: true });
      show();
      askForCheck();
      await settled();
      expect(scanMemoryFiles).not.toHaveBeenCalled();
      expect(screen.queryByText(TITLE)).toBeNull();
    });

    it('opens once the 记忆 page is shown for the first time', async () => {
      useSettingsStore.setState({ systemSettingsOpen: true });
      render(<><PersonalMemorySection /><SensitiveAuditDialog /></>, { wrapper: DesignSystemProvider });
      expect(await checkWindow()).toBeInTheDocument();
      expect(useSettingsStore.getState().shouldRunMemoryAudit).toBe(false);
    });

    it('scans the global folder and every recent workspace, skipping one that cannot be read', async () => {
      useWorkspaceStore.setState({ recentPaths: ['/work/locked', WORKSPACE] });
      disk.unreadable.add('/work/locked');
      show();
      askForCheck();
      await checkWindow();
      expect(vi.mocked(scanMemoryFiles).mock.calls).toEqual([[null], ['/work/locked'], [WORKSPACE]]);
      expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    });

    it('marks the check done without a window when nothing needs review', async () => {
      disk.flagged = new Map();
      show();
      askForCheck();
      await waitFor(() => expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(true));
      expect(useSettingsStore.getState().shouldRunMemoryAudit).toBe(false);
      expect(screen.queryByText(TITLE)).toBeNull();
      expect(setMemoryPrivate).not.toHaveBeenCalled();
    });
  });

  describe('what it shows', () => {
    it('lists every flagged memory with its file and reasons, all ticked, and counts them', async () => {
      show();
      askForCheck();
      await checkWindow();
      expect(screen.getByText('检测到 3 条记忆可能含有敏感信息，建议设为私密。私密记忆不会自动注入对话，但你主动询问时仍可查看。')).toBeInTheDocument();
      expect(screen.getAllByRole('checkbox')).toHaveLength(3);
      for (const name of ['Passport', 'Salary', 'Bank card']) expect(entry(name)).toBeChecked();
      expect(screen.queryByText('Coffee order')).toBeNull();
      expect(screen.getByText(passport.filename)).toBeInTheDocument();
      expect(screen.getByText('身份证号')).toBeInTheDocument();
      expect(screen.getByText('手机号')).toBeInTheDocument();
      expect(screen.getByText('薪资财务')).toBeInTheDocument();
      expect(screen.getByText('银行卡号')).toBeInTheDocument();
      expect(screen.getByText('已选 3 条')).toBeInTheDocument();
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);
    });

    it('unticks and reticks one memory and keeps the count in step', async () => {
      const user = userEvent.setup();
      show();
      askForCheck();
      await checkWindow();
      await user.click(entry('Salary'));
      expect(entry('Salary')).not.toBeChecked();
      expect(entry('Passport')).toBeChecked();
      expect(screen.getByText('已选 2 条')).toBeInTheDocument();
      await user.click(entry('Salary'));
      expect(entry('Salary')).toBeChecked();
      expect(screen.getByText('已选 3 条')).toBeInTheDocument();
    });

    it('cannot mark anything private while nothing is ticked', async () => {
      const user = userEvent.setup();
      show();
      askForCheck();
      await checkWindow();
      for (const name of ['Passport', 'Salary', 'Bank card']) await user.click(entry(name));
      expect(screen.getByText('已选 0 条')).toBeInTheDocument();
      expect(markAll()).toBeDisabled();
      expect(later()).toBeEnabled();
    });
  });

  describe('its two buttons', () => {
    it('稍后处理 changes no memory, marks the check done and closes the window', async () => {
      const user = userEvent.setup();
      show();
      askForCheck();
      await checkWindow();
      await user.click(later());
      expect(setMemoryPrivate).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(true);
      await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    });

    it('全部设为私密 marks every ticked memory private in its own folder, in order, then closes', async () => {
      const user = userEvent.setup();
      show();
      askForCheck();
      await checkWindow();
      await user.click(markAll());
      await waitFor(() => expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(true));
      expect(vi.mocked(setMemoryPrivate).mock.calls).toEqual([
        [passport.filename, true, null],
        [salary.filename, true, null],
        [bank.filename, true, WORKSPACE],
      ]);
      await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    });

    it('leaves an unticked memory as it is', async () => {
      const user = userEvent.setup();
      show();
      askForCheck();
      await checkWindow();
      await user.click(entry('Salary'));
      await user.click(markAll());
      await waitFor(() => expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(true));
      expect(vi.mocked(setMemoryPrivate).mock.calls).toEqual([
        [passport.filename, true, null],
        [bank.filename, true, WORKSPACE],
      ]);
    });

    it('goes on to the next memory when one cannot be marked, and still closes', async () => {
      const user = userEvent.setup();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(setMemoryPrivate).mockImplementation(async (filename) => {
        if (filename === salary.filename) throw new Error('disk full');
      });
      show();
      askForCheck();
      await checkWindow();
      await user.click(markAll());
      await waitFor(() => expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(true));
      expect(vi.mocked(setMemoryPrivate).mock.calls.map(([filename]) => filename)).toEqual([
        passport.filename, salary.filename, bank.filename,
      ]);
      await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
      logged.mockRestore();
    });

    it('takes no second press while memories are being marked', async () => {
      let finish: () => void = () => undefined;
      vi.mocked(setMemoryPrivate).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
      show();
      askForCheck();
      await checkWindow();
      fireEvent.click(markAll());
      await settled();
      expect(markAll()).toBeDisabled();
      expect(later()).toBeDisabled();
      fireEvent.click(markAll());
      fireEvent.click(later());
      expect(setMemoryPrivate).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);
      // Let the three writes finish so the window closes before the next test.
      for (let write = 0; write < 3; write += 1) { finish(); await settled(); }
      expect(setMemoryPrivate).toHaveBeenCalledTimes(3);
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(true);
    });
  });

  describe('what cannot close it', () => {
    it('stays open on Escape and on a press outside it, with the check not marked done', async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      render(<><p>Elsewhere</p><SensitiveAuditDialog /></>, { wrapper: DesignSystemProvider });
      askForCheck();
      const title = await checkWindow();
      await user.keyboard('{Escape}');
      await user.click(screen.getByText('Elsewhere'));
      fireEvent.pointerDown(document.body);
      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
      expect(title).toBeInTheDocument();
      expect(within(document.body).getAllByRole('checkbox')).toHaveLength(3);
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);
      expect(setMemoryPrivate).not.toHaveBeenCalled();
    });

    it('is a question over the settings window: no close button, and the window behind it stays', async () => {
      const user = userEvent.setup();
      render(<><SettingsWindow /><SensitiveAuditDialog /></>, { wrapper: DesignSystemProvider });
      askForCheck();
      const check = await screen.findByRole('alertdialog', { name: TITLE });
      expect(within(check).queryByRole('button', { name: '关闭' })).toBeNull();
      expect(within(check).getAllByRole('button').map((button) => button.textContent)).toEqual(['稍后处理', '全部设为私密']);
      await user.keyboard('{Escape}');
      expect(check).toHaveAttribute('data-state', 'open');
      expect(settingsWindow()).toHaveAttribute('data-state', 'open');

      await user.click(later());
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(settingsWindow()).toHaveAttribute('data-state', 'open');
    });
  });

  describe('when the settings window is not there', () => {
    it('shows nothing and marks nothing done when the scan ends after the settings window closed', async () => {
      show();
      act(() => { useSettingsStore.setState({ systemSettingsOpen: false, shouldRunMemoryAudit: true }); });
      await settled();
      expect(scanMemoryFiles).toHaveBeenCalled();
      expect(screen.queryByText(TITLE)).toBeNull();
      expect(useSettingsStore.getState().shouldRunMemoryAudit).toBe(false);
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);

      // The next visit to the 记忆 page asks again, and this time the question is shown.
      askForCheck();
      expect(await checkWindow()).toBeInTheDocument();
    });

    it('goes away without marking the check done when the settings window closes under it, and comes back on the next visit', async () => {
      render(<><SettingsWindow /><SensitiveAuditDialog /></>, { wrapper: DesignSystemProvider });
      askForCheck();
      await screen.findByRole('alertdialog', { name: TITLE });

      act(() => { useSettingsStore.setState({ systemSettingsOpen: false }); });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);
      expect(setMemoryPrivate).not.toHaveBeenCalled();

      askForCheck();
      const again = await screen.findByRole('alertdialog', { name: TITLE });
      expect(within(again).getAllByRole('checkbox')).toHaveLength(3);
    });
  });

  describe('while it fades out', () => {
    // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a
    // closed layer has an exit animation: it stays on the page, as it does in the app.
    function keepClosingLayersOnScreen() {
      const real = window.getComputedStyle.bind(window);
      return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
        const styles = real(element, pseudo);
        return new Proxy(styles, {
          get(target, prop) {
            if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    }

    it('its buttons and boxes do nothing', async () => {
      const computed = keepClosingLayersOnScreen();
      try {
        show();
        askForCheck();
        await checkWindow();
        fireEvent.click(later());
        const closing = document.querySelector<HTMLElement>('[role="alertdialog"][data-state="closed"]');
        expect(closing).not.toBeNull();
        const fading = within(closing as HTMLElement);

        // Keys still reach a window that is fading out; a pointer does not.
        fireEvent.click(fading.getByRole('button', { name: '全部设为私密' }));
        fireEvent.click(fading.getByRole('checkbox', { name: /Salary/ }));
        await settled();

        expect(setMemoryPrivate).not.toHaveBeenCalled();
        expect(fading.getByRole('checkbox', { name: /Salary/ })).toBeChecked();
        expect(fading.getByText('已选 3 条')).toBeInTheDocument();
      } finally {
        computed.mockRestore();
      }
    });

    it('a second 稍后处理 after the settings window took it away does not mark the check done', async () => {
      const computed = keepClosingLayersOnScreen();
      try {
        render(<><SettingsWindow /><SensitiveAuditDialog /></>, { wrapper: DesignSystemProvider });
        askForCheck();
        await screen.findByRole('alertdialog', { name: TITLE });
        act(() => { useSettingsStore.setState({ systemSettingsOpen: false }); });
        const closing = document.querySelector<HTMLElement>('[role="alertdialog"][data-state="closed"]');
        expect(closing).not.toBeNull();

        fireEvent.click(within(closing as HTMLElement).getByRole('button', { name: '稍后处理' }));

        expect(useSettingsStore.getState().hasRunSensitiveAudit_v015).toBe(false);
      } finally {
        computed.mockRestore();
      }
    });
  });
});
