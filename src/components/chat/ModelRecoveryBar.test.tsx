// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import type { RunModelBinding } from '@/core/agent/ports/modelRecovery';
import { getLanguageSetting, initLanguage } from '@/i18n';
import {
  buildRunModelBinding, getPendingModelRecovery, recoveryAcceptsMedia,
  registerModelRecovery, requestModelRecovery, selectRecoveryModel,
} from '@/core/agent/modelRecovery';
import { ModelRecoveryBar } from './ModelRecoveryBar';

vi.mock('@/core/sidecar/sidecarManager', () => ({ onSidecarRequest: vi.fn() }));

const provider = (id: string, vision: boolean): ProviderInstance => ({
  id, name: id, source: 'custom', enabled: true, apiFormat: 'openai-compatible',
  baseUrl: `https://${id}.example/v1`, apiKey: `${id}-key`, status: 'verified', sortOrder: 0,
  models: [{ id: `${id}-model`, label: `${id} model`, declaredCapabilities: { supportsTools: true, supportsImages: vision } }],
});
const initialSettings = useSettingsStore.getState();
const initialLanguage = getLanguageSetting();
const releases: Array<() => void> = [];
let nextRun = 0;

function owner(conversationId = 'conversation', interactive = true) {
  const runId = `recovery-test-${++nextRun}`;
  const controller = new AbortController();
  let current = true;
  let binding = buildRunModelBinding(useSettingsStore.getState(), { providerId: 'first', modelId: 'first-model' }, 0);
  const onSelected = vi.fn((selected: RunModelBinding) => { binding = selected; });
  const onWaitingChange = vi.fn();
  const release = registerModelRecovery(runId, {
    conversationId, signal: controller.signal, interactive,
    getBinding: () => binding, isCurrent: () => current, onSelected, onWaitingChange,
    acceptsModel: (selected) => recoveryAcceptsMedia(selected, [{
      id: 'user', role: 'user', timestamp: 0,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, filePath: '/workspace/chart.png' }],
    }]),
  });
  releases.push(release);
  return { runId, controller, release, onSelected, onWaitingChange, binding: () => binding, retire: () => { current = false; } };
}

beforeEach(() => {
  initLanguage('en-US');
  useSettingsStore.setState({
    providers: [provider('first', true), provider('second', true), provider('text', false)],
    activeModel: { providerId: 'first', modelId: 'first-model' }, recentModels: [], favoriteModels: [],
  });
});
afterEach(() => {
  cleanup();
  releases.splice(0).forEach((release) => release());
  useSettingsStore.setState(initialSettings);
  initLanguage(initialLanguage);
});

describe('model recovery selection', () => {
  it('opens the picker and resumes on model selection with two clicks', async () => {
    const run = owner();
    const waiting = requestModelRecovery(run.runId, 0, 'quota');
    expect(run.onWaitingChange.mock.calls).toEqual([[true]]);
    render(<DesignSystemProvider><ModelRecoveryBar conversationId="conversation" /></DesignSystemProvider>);
    expect(run.onSelected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose model and continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'second model, can see images' }));
    const selected = await waiting;
    expect(run.onWaitingChange.mock.calls).toEqual([[true], [false]]);
    expect(run.onSelected).toHaveBeenCalledTimes(1);
    expect(selected?.revision).toBe(1);
    expect(selected?.model).toEqual({ providerId: 'second', modelId: 'second-model' });
    expect(selected?.resolvedCreds).toEqual({ apiKey: 'second-key', baseUrl: 'https://second.example/v1', forceOpenAiCompatible: false });
    expect(selected?.capabilities.vision).toBe(true);
    expect(screen.queryByRole('button', { name: 'Choose model and continue' })).not.toBeInTheDocument();
  });

  it('keeps the request and progress when an incompatible model is selected', async () => {
    const run = owner();
    const waiting = requestModelRecovery(run.runId, 0, 'context-window');
    render(<DesignSystemProvider><ModelRecoveryBar conversationId="conversation" /></DesignSystemProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model and continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'text model' }));
    expect(screen.getByText('This model cannot process the attachments in this task. Choose a model that supports them.')).toBeInTheDocument();
    expect(run.onSelected).not.toHaveBeenCalled();
    expect(getPendingModelRecovery('conversation')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'second model, can see images' }));
    expect((await waiting)?.model.providerId).toBe('second');
  });

  it('retains the pending request when the picker is dismissed', () => {
    const run = owner();
    void requestModelRecovery(run.runId, 0, 'quota');
    render(<DesignSystemProvider><ModelRecoveryBar conversationId="conversation" /></DesignSystemProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Choose model and continue' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(getPendingModelRecovery('conversation')?.model.providerId).toBe('first');
    expect(run.onSelected).not.toHaveBeenCalled();
  });

  it('isolates concurrent requests and advances requests from the same conversation', async () => {
    const first = owner('one');
    const second = owner('one');
    const third = owner('two');
    const firstWait = requestModelRecovery(first.runId, 0, 'quota');
    const secondWait = requestModelRecovery(second.runId, 0, 'quota');
    const thirdWait = requestModelRecovery(third.runId, 0, 'quota');
    const original = getPendingModelRecovery('one')!;
    const other = getPendingModelRecovery('two');
    expect(selectRecoveryModel(original.id, { providerId: 'second', modelId: 'second-model' })).toBeNull();
    expect((await firstWait)?.revision).toBe(1);
    expect(getPendingModelRecovery('one')?.id).not.toBe(original.id);
    expect(getPendingModelRecovery('two')).toBe(other);
    second.controller.abort();
    expect(await secondWait).toBeNull();
    expect(getPendingModelRecovery('two')).toBe(other);
    third.release();
    expect(await thirdWait).toBeNull();
  });

  it('rejects unavailable models without consuming the waiting request', () => {
    const run = owner();
    void requestModelRecovery(run.runId, 0, 'quota');
    const pending = getPendingModelRecovery('conversation')!;
    useSettingsStore.setState({ providers: useSettingsStore.getState().providers.filter((entry) => entry.id !== 'second') });
    expect(selectRecoveryModel(pending.id, { providerId: 'second', modelId: 'second-model' })).toBe('unavailable');
    expect(getPendingModelRecovery('conversation')).toBe(pending);
  });

  it('requires configured credentials before resuming', () => {
    const run = owner();
    void requestModelRecovery(run.runId, 0, 'quota');
    useSettingsStore.setState({ providers: useSettingsStore.getState().providers.map((entry) => entry.id === 'second' ? { ...entry, apiKey: '' } : entry) });
    expect(selectRecoveryModel(getPendingModelRecovery('conversation')!.id, { providerId: 'second', modelId: 'second-model' })).toBe('credentials-required');
    expect(run.binding().revision).toBe(0);
  });

  it('cancels the pending selection on Stop and refuses a late click', async () => {
    const run = owner();
    const waiting = requestModelRecovery(run.runId, 0, 'quota');
    const pending = getPendingModelRecovery('conversation')!;
    render(<DesignSystemProvider><ModelRecoveryBar conversationId="conversation" /></DesignSystemProvider>);
    act(() => run.controller.abort());
    expect(await waiting).toBeNull();
    expect(selectRecoveryModel(pending.id, { providerId: 'second', modelId: 'second-model' })).toBe('ended');
    expect(run.onSelected).not.toHaveBeenCalled();
  });

  it('refuses a superseded run and rejects an old model revision', async () => {
    const run = owner();
    expect(() => requestModelRecovery(run.runId, 2, 'quota')).toThrow('stale');
    const waiting = requestModelRecovery(run.runId, 0, 'quota');
    const pending = getPendingModelRecovery('conversation')!;
    run.retire();
    expect(selectRecoveryModel(pending.id, { providerId: 'second', modelId: 'second-model' })).toBe('ended');
    run.release();
    expect(await waiting).toBeNull();
  });

  it('does not open a waiting selection for a background run', async () => {
    const run = owner('background', false);
    expect(await requestModelRecovery(run.runId, 0, 'quota')).toBeNull();
    expect(getPendingModelRecovery('background')).toBeNull();
  });
});
