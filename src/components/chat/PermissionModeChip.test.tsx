/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

describe('PermissionModeChip', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
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

  it('opens popover with all three options on click', () => {
    render(<PermissionModeChip conversationId={null} />);
    // Trigger button is the only button before popover opens
    fireEvent.click(screen.getByRole('button'));
    // After click, popover renders with 3 option buttons (plus the trigger = 4 total)
    const buttons = screen.getAllByRole('button');
    const labels = buttons.map((b: HTMLElement) => b.textContent ?? '');
    expect(labels.some((l: string) => l.includes('智能审核'))).toBe(true);
    expect(labels.some((l: string) => l.includes('完全自主'))).toBe(true);
  });

  it('updates conversation permissionMode when autonomous option selected', () => {
    const id = useChatStore.getState().createConversation();
    render(<PermissionModeChip conversationId={id} />);
    fireEvent.click(screen.getByRole('button'));
    const autonomousBtn = screen.getAllByRole('button').find(
      (btn: HTMLElement) => btn.textContent?.includes('完全自主') && btn.textContent?.includes('系统红线')
    );
    expect(autonomousBtn).toBeDefined();
    fireEvent.click(autonomousBtn!);
    expect(useChatStore.getState().conversations[id]?.permissionMode).toBe('autonomous');
  });

  it('closes popover after selection', () => {
    render(<PermissionModeChip conversationId={null} />);
    fireEvent.click(screen.getByRole('button'));
    // Find the 标准 option (includes description text) and click it
    const standardOptionBtn = screen.getAllByRole('button').find(
      (btn: HTMLElement) => btn.textContent?.includes('标准') && btn.textContent?.includes('工作区')
    );
    expect(standardOptionBtn).toBeDefined();
    fireEvent.click(standardOptionBtn!);
    // Popover closed — only trigger button remains
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('updates pendingPermissionMode in chatStore (not global settingsStore) when conversationId is null', () => {
    render(<PermissionModeChip conversationId={null} />);
    fireEvent.click(screen.getByRole('button'));
    const smartBtn = screen.getAllByRole('button').find(
      (btn: HTMLElement) => btn.textContent?.includes('智能审核')
    );
    expect(smartBtn).toBeDefined();
    fireEvent.click(smartBtn!);
    // Global default must NOT change
    expect(useSettingsStore.getState().permissionMode).toBe('standard');
    // Pending mode is set in chatStore for the next conversation
    expect(useChatStore.getState().pendingPermissionMode).toBe('smart');
  });
});
