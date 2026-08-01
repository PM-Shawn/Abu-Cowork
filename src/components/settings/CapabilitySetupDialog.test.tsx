/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import {
  drainCapabilitySetupRequests,
  requestCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import CapabilitySetupDialog from './CapabilitySetupDialog';

vi.mock('./sections/CapabilitiesSection', () => ({
  default: ({
    setupTarget,
    onSetupComplete,
    onSetupCancel,
  }: {
    setupTarget: string;
    onSetupComplete: () => void;
    onSetupCancel: () => void;
  }) => (
    <div>
      <span>setup:{setupTarget}</span>
      <button onClick={onSetupComplete}>complete setup</button>
      <button onClick={onSetupCancel}>cancel setup</button>
    </div>
  ),
}));

describe('CapabilitySetupDialog', () => {
  beforeEach(() => {
    initLanguage('en-US');
    drainCapabilitySetupRequests();
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
});
