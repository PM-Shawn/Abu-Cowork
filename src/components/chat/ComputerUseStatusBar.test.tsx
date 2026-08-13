/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ComputerUseStatusBar from './ComputerUseStatusBar';
import { initLanguage } from '@/i18n';

const snapshot = vi.hoisted(() => ({
  status: 'active' as const,
  stepCount: 2,
  currentAction: '输入文本',
  phase: 'verifying' as const,
  targetApp: 'TextEdit',
  capabilityMode: 'structured' as const,
  latestScreenshot: null,
  activeConversationId: 'conversation-1',
  sessionWindowHidden: false,
  sessionStartTime: 1,
}));

vi.mock('@/core/agent/computerUseStatus', () => ({
  subscribeCUStatus: () => () => {},
  getCUStatusSnapshot: () => snapshot,
}));

describe('ComputerUseStatusBar', () => {
  beforeEach(() => initLanguage('en-US'));
  afterEach(cleanup);

  it('shows safe target, mode, and phase without typed content', () => {
    render(<ComputerUseStatusBar onStop={() => {}} />);

    expect(screen.getByText('Controlling computer')).toBeInTheDocument();
    expect(screen.getByText('TextEdit · Structured mode · Verifying result')).toBeInTheDocument();
    expect(screen.queryByText(/private|password|typed/i)).not.toBeInTheDocument();
  });
});
