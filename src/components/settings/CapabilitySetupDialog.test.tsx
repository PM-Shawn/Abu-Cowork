// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import {
  drainCapabilitySetupRequests,
  requestCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import CapabilitySetupDialog from './CapabilitySetupDialog';

const restartAppMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/core/updates/checker', () => ({
  restartApp: restartAppMock,
}));

vi.mock('./sections/CapabilitiesSection', () => ({
  default: ({
    setupTarget,
    computerUseRequirements,
    onSetupComplete,
    onSetupCancel,
    onSetupRelaunch,
  }: {
    setupTarget: string;
    computerUseRequirements?: { screenRead: boolean; uiControl: boolean };
    onSetupComplete: () => void;
    onSetupCancel: () => void;
    onSetupRelaunch?: () => void;
  }) => (
    <div>
      <span>setup:{setupTarget}</span>
      <span>requirements:{JSON.stringify(computerUseRequirements)}</span>
      <button onClick={onSetupComplete}>complete setup</button>
      <button onClick={onSetupCancel}>cancel setup</button>
      {onSetupRelaunch && <button onClick={onSetupRelaunch}>restart setup</button>}
    </div>
  ),
}));

describe('CapabilitySetupDialog', () => {
  beforeEach(() => {
    initLanguage('en-US');
    drainCapabilitySetupRequests();
    localStorage.clear();
    restartAppMock.mockClear();
  });

  it('passes the requesting task permission scope into Computer Use setup', async () => {
    const resultPromise = requestCapabilitySetup('computer', {
      conversationId: 'conversation-ax',
      toolCallId: 'tool-ax',
      interactionMode: 'foreground',
    }, {
      computerUseRequirements: { screenRead: false, uiControl: true },
    });

    render(<CapabilitySetupDialog />);
    expect(screen.getByText(
      'requirements:{"screenRead":false,"uiControl":true}',
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(resultPromise).resolves.toBe(false);
  });

  afterEach(() => {
    drainCapabilitySetupRequests();
    cleanup();
  });

  it('resolves the exact requesting task after setup completes', async () => {
    const resultPromise = requestCapabilitySetup('computer', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
    });

    render(<CapabilitySetupDialog />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('setup:computer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'complete setup' }));
    await expect(resultPromise).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancels setup with Escape without enabling the capability', async () => {
    const resultPromise = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-2',
      toolCallId: 'tool-2',
      interactionMode: 'foreground',
    });

    render(<CapabilitySetupDialog />);
    fireEvent.keyDown(document, { key: 'Escape' });

    await expect(resultPromise).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stores a minimal recovery token before a task-requested relaunch', async () => {
    const taskSummaryHash = `sha256:${'a'.repeat(64)}`;
    const resultPromise = requestCapabilitySetup('computer', {
      conversationId: 'conversation-relaunch',
      toolCallId: 'tool-relaunch',
      interactionMode: 'foreground',
      taskSummaryHash,
    }, {
      computerUseRequirements: { screenRead: false, uiControl: true },
    });

    render(<CapabilitySetupDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'restart setup' }));

    await expect(resultPromise).resolves.toBe(false);
    expect(restartAppMock).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(
      'abu:computer-use-permission-resume:v1',
    ) ?? '{}')).toMatchObject({
      version: 1,
      conversationId: 'conversation-relaunch',
      taskSummaryHash,
      requirements: { screenRead: false, uiControl: true },
    });
  });
});
