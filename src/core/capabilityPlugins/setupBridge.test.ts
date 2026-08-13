import { afterEach, describe, expect, it } from 'vitest';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  requestCapabilitySetup,
  resolveCapabilitySetup,
  restoreComputerUseSetupRequest,
} from './setupBridge';

describe('capability setup bridge', () => {
  afterEach(() => {
    drainCapabilitySetupRequests();
  });

  it('queues task requests and resolves only the matching active request', async () => {
    const first = requestCapabilitySetup('computer', {
      conversationId: 'conversation-1',
      loopId: 'loop-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
    });
    const second = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-2',
      loopId: 'loop-2',
      toolCallId: 'tool-2',
      interactionMode: 'foreground',
    });

    const firstRequest = getPendingCapabilitySetup();
    expect(firstRequest).toMatchObject({
      target: 'computer',
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
    });

    resolveCapabilitySetup('not-the-active-request', true);
    expect(getPendingCapabilitySetup()).toBe(firstRequest);

    resolveCapabilitySetup(firstRequest!.id, true);
    await expect(first).resolves.toBe(true);

    const secondRequest = getPendingCapabilitySetup();
    expect(secondRequest).toMatchObject({
      target: 'chrome',
      conversationId: 'conversation-2',
      toolCallId: 'tool-2',
    });
    resolveCapabilitySetup(secondRequest!.id, false);
    await expect(second).resolves.toBe(false);
  });

  it('removes an aborted queued request without resolving the active task', async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = requestCapabilitySetup('computer', {
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
      abortSignal: firstController.signal,
    });
    const second = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-2',
      toolCallId: 'tool-2',
      interactionMode: 'foreground',
      abortSignal: secondController.signal,
    });

    secondController.abort();
    await expect(second).resolves.toBe(false);
    expect(getPendingCapabilitySetup()).toMatchObject({
      conversationId: 'conversation-1',
    });

    firstController.abort();
    await expect(first).resolves.toBe(false);
    expect(getPendingCapabilitySetup()).toBeNull();
  });

  it('fails closed when task identity is missing', async () => {
    await expect(requestCapabilitySetup('computer', {
      conversationId: 'conversation-1',
    })).resolves.toBe(false);
    expect(getPendingCapabilitySetup()).toBeNull();
  });

  it('does not surface setup UI for background tasks', async () => {
    await expect(requestCapabilitySetup('computer', {
      conversationId: 'background-conversation',
      toolCallId: 'background-tool',
      interactionMode: 'background',
    })).resolves.toBe(false);
    expect(getPendingCapabilitySetup()).toBeNull();
  });

  it('binds task-local Computer Use permission requirements to the setup request', async () => {
    const result = requestCapabilitySetup('computer', {
      conversationId: 'conversation-ax',
      loopId: 'loop-ax',
      toolCallId: 'tool-ax',
      interactionMode: 'foreground',
    }, {
      computerUseRequirements: { screenRead: false, uiControl: true },
    });

    expect(getPendingCapabilitySetup()).toMatchObject({
      target: 'computer',
      computerUseRequirements: { screenRead: false, uiControl: true },
    });
    resolveCapabilitySetup(getPendingCapabilitySetup()!.id, false);
    await expect(result).resolves.toBe(false);
  });

  it('restores only the capability check after relaunch without an old tool call', () => {
    restoreComputerUseSetupRequest({
      conversationId: 'conversation-resume',
      taskSummaryHash: `sha256:${'a'.repeat(64)}`,
      requirements: { screenRead: false, uiControl: true },
    });
    expect(getPendingCapabilitySetup()).toMatchObject({
      source: 'relaunch',
      conversationId: 'conversation-resume',
      computerUseRequirements: { screenRead: false, uiControl: true },
    });
    expect(getPendingCapabilitySetup()).not.toHaveProperty('toolCallId');
  });

  it('drains only the stopped loop and promotes another conversation', async () => {
    const first = requestCapabilitySetup('computer', {
      conversationId: 'conversation-1',
      loopId: 'loop-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
    });
    const second = requestCapabilitySetup('chrome', {
      conversationId: 'conversation-2',
      loopId: 'loop-2',
      toolCallId: 'tool-2',
      interactionMode: 'foreground',
    });

    drainCapabilitySetupRequests('loop-1');
    await expect(first).resolves.toBe(false);
    expect(getPendingCapabilitySetup()).toMatchObject({ loopId: 'loop-2' });

    drainCapabilitySetupRequests('loop-2');
    await expect(second).resolves.toBe(false);
  });
});
