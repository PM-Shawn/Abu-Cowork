// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import {
  drainCapabilitySetupRequests,
  requestCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import CapabilitySetupDialog from './CapabilitySetupDialog';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import ImageLightbox from '@/components/chat/ImageLightbox';

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
    useImageLightboxStore.getState().close();
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
    useImageLightboxStore.getState().close();
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

  it('uses the first Escape to close a visible lightbox without denying setup', async () => {
    let settled = false;
    const resultPromise = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-overlay',
      toolCallId: 'tool-overlay',
      interactionMode: 'foreground',
    }).finally(() => {
      settled = true;
    });
    useImageLightboxStore.getState().open([
      { id: 'image-1', data: 'cG5n', mediaType: 'image/png' },
    ], 0);

    render(<CapabilitySetupDialog />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(useImageLightboxStore.getState().isOpen).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);

    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(resultPromise).resolves.toBe(false);
  });

  it('hands focus from a closing lightbox to asynchronously requested setup', async () => {
    render(
      <>
        <button type="button">image opener</button>
        <textarea data-chat-composer aria-label="chat composer" />
        <ImageLightbox />
        <CapabilitySetupDialog />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'image opener' });
    const composer = screen.getByRole('textbox', { name: 'chat composer' });
    opener.focus();
    act(() => {
      useImageLightboxStore.getState().open([
        { id: 'handoff-image', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
      ], 0, opener);
    });
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument();
    });

    let resultPromise!: Promise<boolean>;
    act(() => {
      resultPromise = requestCapabilitySetup('chrome', {
        conversationId: 'conversation-focus-handoff',
        toolCallId: 'tool-focus-handoff',
        interactionMode: 'foreground',
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Image preview' })).not.toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });
    await Promise.resolve();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(opener).not.toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'cancel setup' }));
    await expect(resultPromise).resolves.toBe(false);
    await waitFor(() => {
      expect(composer).toHaveFocus();
    });
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
