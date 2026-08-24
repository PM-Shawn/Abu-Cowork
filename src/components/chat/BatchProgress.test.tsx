// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useBatchProgressStore } from '@/stores/batchProgressStore';
import BatchProgress from './BatchProgress';

describe('BatchProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    initLanguage('en-US');
    useBatchProgressStore.setState({ batches: {} });
  });

  afterEach(() => {
    for (const batchId of Object.keys(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(batchId);
    }
    cleanup();
    vi.useRealTimers();
  });

  it('keeps a completed batch inspectable and renders a rich screenshot in the right drawer', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch('batch-ui', ['Inspect page']);
    store.setTaskRunning('batch-ui', 0);
    store.startTaskStep('batch-ui', 0, {
      id: 'screenshot-1',
      toolName: 'abu-browser__screenshot',
      toolInput: { fullPage: true },
    });
    store.finishTaskStep('batch-ui', 0, {
      id: 'screenshot-1',
      toolName: 'abu-browser__screenshot',
      result: 'Screenshot captured',
      resultContent: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
      }],
      error: false,
    });
    store.setTaskTokenUsage('batch-ui', 0, { inputTokens: 120, outputTokens: 45 });
    store.setTaskDone('batch-ui', 0);

    render(<BatchProgress toolCallId="batch-ui" />);

    expect(screen.getByText('✓ 1 sub-tasks completed')).toBeInTheDocument();
    expect(screen.getByText('1 tools')).toBeInTheDocument();
    expect(screen.getByText('165 tokens')).toBeInTheDocument();

    const taskRow = screen.getByRole('button', { name: /Inspect page/ });
    taskRow.focus();
    fireEvent.click(taskRow);

    const dialog = screen.getByRole('dialog', { name: 'Inspect page' });
    expect(dialog).toBeInTheDocument();
    expect(document.activeElement).toBe(dialog);
    const image = screen.getByRole('img');
    expect(image.getAttribute('src')).toBe('data:image/png;base64,aGk=');
    expect(screen.getByText('Screenshot captured')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Inspect page' })).toBeNull();
    expect(document.activeElement).toBe(taskRow);
  });

  it('traps Tab and Shift+Tab inside the task drawer', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch('batch-focus', ['Inspect page']);
    render(<BatchProgress toolCallId="batch-focus" />);

    const taskRow = screen.getByRole('button', { name: /Inspect page/ });
    fireEvent.click(taskRow);
    const dialog = screen.getByRole('dialog', { name: 'Inspect page' });
    const closeButton = within(dialog).getByRole('button', { name: 'Collapse' });

    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeButton);
  });

  it('surfaces mixed terminal outcomes instead of showing an all-success heading', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch('batch-mixed', ['Success', 'Failure']);
    store.setTaskDone('batch-mixed', 0);
    store.setTaskDone('batch-mixed', 1, true);

    render(<BatchProgress toolCallId="batch-mixed" />);

    expect(screen.getByText('⚠ 1 completed, 1 failed')).toBeInTheDocument();
    expect(screen.queryByText('✓ 2 sub-tasks completed')).toBeNull();
  });

  it('appears when progress is initialized after the component mounts', () => {
    render(<BatchProgress toolCallId="batch-late-init" />);
    expect(screen.queryByText('Running 1 parallel sub-tasks')).toBeNull();

    act(() => {
      useBatchProgressStore.getState().initBatch('batch-late-init', ['Late task']);
    });

    expect(screen.getByText('Running 1 parallel sub-tasks')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Late task/ })).toBeInTheDocument();
  });
});
