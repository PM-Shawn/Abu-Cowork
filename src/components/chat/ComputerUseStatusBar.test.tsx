// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ComputerUseStatusBar from './ComputerUseStatusBar';
import { useChatStore } from '@/stores/chatStore';
import type { CUState } from '@/core/agent/computerUseStatus';
import { initLanguage } from '@/i18n';

const ACTIVE_SNAPSHOT: CUState = {
  status: 'active',
  stepCount: 2,
  currentAction: '输入文本',
  phase: 'verifying',
  targetApp: 'TextEdit',
  capabilityMode: 'structured',
  latestScreenshot: null,
  activeConversationId: 'conversation-1',
  sessionWindowHidden: false,
  sessionStartTime: 1,
};

// Mutable so each test can pick who owns the session; the component reads it
// through `useSyncExternalStore` on every render.
const snapshot = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/core/agent/computerUseStatus', () => ({
  subscribeCUStatus: () => () => {},
  getCUStatusSnapshot: () => snapshot.current,
}));

function setSnapshot(patch: Partial<CUState>) {
  snapshot.current = { ...ACTIVE_SNAPSHOT, ...patch };
}

function meta(id: string, title: string) {
  return { id, title, createdAt: 0, updatedAt: 0, messageCount: 0 };
}

describe('ComputerUseStatusBar', () => {
  beforeEach(() => {
    initLanguage('en-US');
    setSnapshot({});
    useChatStore.setState({
      activeConversationId: 'conversation-1',
      conversationIndex: {
        'conversation-1': meta('conversation-1', 'Front chat'),
        'conversation-2': meta('conversation-2', 'Nightly report'),
      },
    });
  });
  afterEach(cleanup);

  it('shows safe target, mode, and phase without typed content', () => {
    render(<ComputerUseStatusBar onStop={() => {}} />);

    expect(screen.getByText('Controlling computer')).toBeInTheDocument();
    expect(screen.getByText('TextEdit · Structured mode · Verifying result')).toBeInTheDocument();
    expect(screen.queryByText(/private|password|typed/i)).not.toBeInTheDocument();
  });

  it('does not name an owner when the viewed conversation owns the session', () => {
    render(<ComputerUseStatusBar onStop={() => {}} />);

    expect(screen.queryByTestId('cu-owner')).not.toBeInTheDocument();
  });

  // The bug this component's doc block is about: the user is reading an idle
  // conversation while a background one drives the screen.
  it('stops the conversation that OWNS the session, not the one being viewed', () => {
    setSnapshot({ activeConversationId: 'conversation-2' });
    const onStop = vi.fn();
    render(<ComputerUseStatusBar onStop={onStop} />);

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('conversation-2');
    expect(onStop).not.toHaveBeenCalledWith('conversation-1');
  });

  it('names the owning conversation when it is not the one on screen', () => {
    setSnapshot({ activeConversationId: 'conversation-2' });
    render(<ComputerUseStatusBar onStop={() => {}} />);

    expect(screen.getByTestId('cu-owner')).toHaveTextContent('Started by “Nightly report”');
  });

  it('falls back to a generic owner label when the title cannot be resolved', () => {
    setSnapshot({ activeConversationId: 'conversation-gone' });
    render(<ComputerUseStatusBar onStop={() => {}} />);

    expect(screen.getByTestId('cu-owner')).toHaveTextContent('Started by “another chat”');
  });

  // No owner means nothing is actually running — falling back to the viewed
  // conversation is exactly the bug, so the control is simply not offered.
  it('renders no stop button when no conversation owns the session', () => {
    setSnapshot({ activeConversationId: null });
    const onStop = vi.fn();
    render(<ComputerUseStatusBar onStop={onStop} />);

    expect(screen.getByText('Controlling computer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('renders nothing when idle', () => {
    setSnapshot({ status: 'idle' });
    const { container } = render(<ComputerUseStatusBar onStop={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });
});
