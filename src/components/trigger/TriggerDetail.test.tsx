// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useToastStore } from '@/stores/toastStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { Trigger, TriggerCapability } from '@/types/trigger';
import TriggerDetail from './TriggerDetail';

const BASE_TIME = 1_700_000_000_000;

function makeTrigger(id: string, action: Trigger['action']): Trigger {
  return {
    id,
    name: `Trigger ${id}`,
    status: 'active',
    source: { type: 'http' },
    filter: { type: 'always' },
    action,
    debounce: { enabled: false, windowSeconds: 0 },
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    runs: [],
    totalRuns: 0,
  };
}

function resetStores() {
  useTriggerStore.setState({
    triggers: {},
    selectedTriggerId: null,
    showEditor: false,
    editingTriggerId: null,
    editorTemplateDefaults: null,
  });
  useIMChannelStore.setState({ channels: {} });
  useToastStore.setState({ toasts: [] });
}

describe('TriggerDetail capability level', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('shows read-only when a trigger has no capability field', () => {
    const trigger = makeTrigger('missing-capability', { prompt: 'Handle event' });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      selectedTriggerId: trigger.id,
    });

    render(<TriggerDetail />);

    expect(screen.getByText('自主程度')).toBeInTheDocument();
    expect(screen.getByText('只看不动（默认）')).toBeInTheDocument();
  });

  it('shows the current capability level', () => {
    const trigger = makeTrigger('safe-capability', {
      prompt: 'Handle event',
      capability: 'safe_tools',
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      selectedTriggerId: trigger.id,
    });

    render(<TriggerDetail />);

    expect(screen.getByText('自主程度')).toBeInTheDocument();
    expect(screen.getByText('常规')).toBeInTheDocument();
  });

  it.each(['future_tier', '__proto__'])('fails closed when persisted capability is %s', (persistedCapability) => {
    const trigger = makeTrigger('malformed-capability', {
      prompt: 'Handle event',
      capability: persistedCapability as TriggerCapability,
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      selectedTriggerId: trigger.id,
    });

    render(<TriggerDetail />);

    expect(screen.getByText('只看不动（默认）')).toBeInTheDocument();
  });
});
