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

  it('opens a list of the three modes, each with its description', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    const group = await screen.findByRole('radiogroup', { name: '权限模式' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /智能审核/ })).toHaveAccessibleName(/可能误判/);
    expect(screen.getByRole('radio', { name: /^标准/ })).toBeChecked();
  });

  it('updates conversation permissionMode when autonomous option selected, then closes', async () => {
    const user = userEvent.setup();
    const id = useChatStore.getState().createConversation();
    render(<PermissionModeChip conversationId={id} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    await user.click(await screen.findByRole('radio', { name: /系统红线/ }));

    expect(useChatStore.getState().conversations[id]?.permissionMode).toBe('autonomous');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('closes after picking the mode that is already current', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    await user.click(await screen.findByText(/工作区内自由读写/));

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('updates pendingPermissionMode in chatStore (not global settingsStore) when conversationId is null', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    await user.click(screen.getByRole('button', { name: '标准' }));

    await user.click(await screen.findByRole('radio', { name: /智能审核/ }));

    // Global default must NOT change
    expect(useSettingsStore.getState().permissionMode).toBe('standard');
    // Pending mode is set in chatStore for the next conversation
    expect(useChatStore.getState().pendingPermissionMode).toBe('smart');
  });

  it('moves the choice with arrow keys while the list stays open, and Enter closes it back onto the chip', async () => {
    // The radio group moves focus on the next timer tick.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PermissionModeChip conversationId={null} />);
      screen.getByRole('button', { name: '标准' }).focus();
      await user.keyboard('{Enter}');
      expect(await screen.findByRole('radio', { name: /^标准/ })).toHaveFocus();

      // Held down across the tick, as a real key press is.
      await user.keyboard('{ArrowDown>}');
      await vi.advanceTimersByTimeAsync(0);
      await user.keyboard('{/ArrowDown}');

      expect(screen.getByRole('radio', { name: /^智能审核/ })).toHaveFocus();
      expect(useChatStore.getState().pendingPermissionMode).toBe('smart');
      expect(screen.getByRole('radiogroup')).toBeInTheDocument();

      await user.keyboard('{Enter}');

      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '智能审核' })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on Escape and puts focus back on the chip', async () => {
    const user = userEvent.setup();
    render(<PermissionModeChip conversationId={null} />);
    const chip = screen.getByRole('button', { name: '标准' });
    await user.click(chip);
    expect(await screen.findByRole('radiogroup')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it('names the setting in the chip\'s hover text', async () => {
    render(<PermissionModeChip conversationId={null} />);
    screen.getByRole('button', { name: '标准' }).focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('权限模式: 标准');
  });
});
