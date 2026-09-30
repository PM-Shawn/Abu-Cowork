// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render as renderBare, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import PermissionModeChip from './PermissionModeChip';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      settings: {
        permissionMode: '权限模式',
        permissionModeStandard: '标准',
        permissionModeStandardDesc: '工作区内自由读写，越界写入和危险命令需确认',
        permissionModeSmart: '智能审核',
        permissionModeSmartDesc: '越界操作交 AI 审核：放行低风险、拦截高风险、不确定才问你。可能误判',
        permissionModeAutonomous: '完全自主',
        permissionModeAutonomousDesc: '除系统红线外全部自动执行，请在信任当前任务时使用',
      },
    },
  }),
  getI18n: () => ({
    chatDefaults: { newConversationTitle: '新任务', watcherConversationTitle: '[监听] {file} - {time}' },
    task: { cancelled: '[已取消]' },
  }),
  format: (s: string, v: Record<string, unknown>) =>
    s.replace(/\{(\w+)\}/g, (_: string, k: string) => String(v[k] ?? `{${k}}`)),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

describe('PermissionModeChip', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingPermissionMode: undefined });
    useSettingsStore.setState({ permissionMode: 'standard' });
  });

  afterEach(cleanup);

  it('shows 标准 label when global default is standard and no conversation', () => {
    render(<PermissionModeChip conversationId={null} />);
    expect(screen.getByText('标准')).toBeInTheDocument();
  });

  it('shows global default when conversation has no override', () => {
    const id = useChatStore.getState().createConversation();
    render(<PermissionModeChip conversationId={id} />);
    expect(screen.getByText('标准')).toBeInTheDocument();
  });

  it('shows conversation override label when set to autonomous', () => {
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
    render(<PermissionModeChip conversationId={id} />);
    expect(screen.getByText('完全自主')).toBeInTheDocument();
  });

  it('shows full autonomy as a warning, the other modes in a quiet grey', () => {
    const id = useChatStore.getState().createConversation();
    const { unmount } = render(<PermissionModeChip conversationId={id} />);
    expect(screen.getByRole('button', { name: '标准' })).toHaveClass('text-label-secondary');
    unmount();

    useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
    render(<PermissionModeChip conversationId={id} />);
    const chip = screen.getByRole('button', { name: '完全自主' });
    expect(chip).toHaveClass('text-warning');
    expect(chip).not.toHaveClass('text-label-secondary');
  });

  it('opens a menu of the three modes, each named by its mode and described by its line', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    expect(screen.getByRole('menuitemradio', { name: '标准' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: '智能审核' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: '智能审核' })).toHaveAccessibleDescription(/可能误判/);
  });

  it('updates conversation permissionMode when autonomous option selected, then closes', async () => {
    const user = userEvent.setup();
    const id = useChatStore.getState().createConversation();
    render(<PermissionModeChip conversationId={id} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    await user.click(await screen.findByRole('menuitemradio', { name: '完全自主' }));

    expect(useChatStore.getState().conversations[id]?.permissionMode).toBe('autonomous');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes after picking the mode that is already current', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    await user.click(await screen.findByRole('menuitemradio', { name: '标准' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('updates pendingPermissionMode in chatStore (not global settingsStore) when conversationId is null', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    await user.click(await screen.findByRole('menuitemradio', { name: '智能审核' }));

    // Global default must NOT change
    expect(useSettingsStore.getState().permissionMode).toBe('standard');
    // Pending mode is set in chatStore for the next conversation
    expect(useChatStore.getState().pendingPermissionMode).toBe('smart');
  });

  describe('from the keyboard', () => {
    // Keys are held across a timer tick, as a real key press is: a list may move focus on
    // the next tick and act on whatever the key does while it is still down.
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    async function openFromChip(user: ReturnType<typeof userEvent.setup>, chipName: string) {
      screen.getByRole('button', { name: chipName }).focus();
      await user.keyboard('{Enter}');
      await vi.advanceTimersByTimeAsync(0);
    }

    async function press(user: ReturnType<typeof userEvent.setup>, key: string) {
      await user.keyboard(`{${key}>}`);
      await vi.advanceTimersByTimeAsync(0);
      await user.keyboard(`{/${key}}`);
    }

    it('ArrowDown only moves the highlight; the mode stays', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PermissionModeChip conversationId={null} />);
      await openFromChip(user, '标准');

      await press(user, 'ArrowDown');

      expect(useChatStore.getState().pendingPermissionMode).toBeUndefined();
      expect(screen.getByRole('menuitemradio', { name: '智能审核' })).toHaveFocus();

      await press(user, 'ArrowDown');

      expect(useChatStore.getState().pendingPermissionMode).toBeUndefined();
      expect(screen.getByRole('menuitemradio', { name: '完全自主' })).toHaveFocus();
    });

    it('ArrowUp from the first mode never reaches full autonomy', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PermissionModeChip conversationId={null} />);
      await openFromChip(user, '标准');

      await press(user, 'ArrowUp');

      expect(useChatStore.getState().pendingPermissionMode).toBeUndefined();
      expect(screen.getByRole('menuitemradio', { name: '完全自主' })).not.toHaveFocus();
    });

    it('Enter applies the highlighted mode, closes the menu and puts focus on the chip', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PermissionModeChip conversationId={null} />);
      await openFromChip(user, '标准');
      await press(user, 'ArrowDown');

      await press(user, 'Enter');

      expect(useChatStore.getState().pendingPermissionMode).toBe('smart');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '智能审核' })).toHaveFocus();
    });

    it('Escape after arrow keys leaves the mode unchanged', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PermissionModeChip conversationId={null} />);
      await openFromChip(user, '标准');
      await press(user, 'ArrowDown');
      await press(user, 'ArrowDown');

      await press(user, 'Escape');

      expect(useChatStore.getState().pendingPermissionMode).toBeUndefined();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '标准' })).toHaveFocus();
    });
  });

  it('closes on Escape and puts focus back on the chip', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    const chip = screen.getByRole('button', { name: '标准' });
    await user.click(chip);
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it('names the setting in the chip\'s hover text', async () => {
    render(<PermissionModeChip conversationId={null} />);
    screen.getByRole('button', { name: '标准' }).focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('权限模式: 标准');
  });
});
