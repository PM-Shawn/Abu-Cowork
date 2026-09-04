// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrialLauncher } from './useTrialLauncher';

// 「立即试用」 is a three-store dance (new conversation → prefill the composer →
// close the Extensions view), so the stores are mocked selector-style — the same
// shape ToolboxModal.pluginIA.test.tsx uses — and the call ORDER is asserted, not
// just the fact of the calls: prefilling before the new conversation exists would
// drop the text.
//
// `format` is the real `{placeholder}` replacer rather than an identity stub, so
// the assertion on the final composer string is meaningful.

const startNewConversation = vi.fn();
const setPendingInput = vi.fn();
const closeExtensions = vi.fn();
const calls: string[] = [];

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    startNewConversation: () => { calls.push('startNewConversation'); startNewConversation(); },
    setPendingInput: (text: string | null) => { calls.push('setPendingInput'); setPendingInput(text); },
  }),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    closeExtensions: () => { calls.push('closeExtensions'); closeExtensions(); },
  }),
}));

vi.mock('@/i18n', () => ({
  format: (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (_: string, key: string) => String(values[key] ?? `{${key}}`)),
  useI18n: () => ({
    t: {
      toolbox: {
        trialPrompt: '试试用「{name}」：{hint}',
        trialPromptFallback: '帮我看看它能做什么',
      },
    },
  }),
}));

function Harness({ item }: { item: { name: string; description?: string | null } }) {
  const launchTrial = useTrialLauncher();
  return <button onClick={() => launchTrial(item)}>trial</button>;
}

function launch(item: { name: string; description?: string | null }) {
  cleanup(); // several cases launch more than once inside one test
  render(<Harness item={item} />);
  fireEvent.click(screen.getByText('trial'));
}

describe('useTrialLauncher', () => {
  beforeEach(() => {
    startNewConversation.mockClear();
    setPendingInput.mockClear();
    closeExtensions.mockClear();
    calls.length = 0;
  });

  it('starts a conversation, prefills the composer, then closes Extensions', () => {
    launch({ name: 'canva', description: 'Create, review, edit designs' });

    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(setPendingInput).toHaveBeenCalledTimes(1);
    expect(closeExtensions).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['startNewConversation', 'setPendingInput', 'closeExtensions']);
    expect(setPendingInput).toHaveBeenCalledWith('试试用「canva」：Create, review, edit designs');
  });

  it('collapses whitespace runs in the description', () => {
    launch({ name: 'canva', description: '  Create,\n\n  review,\tedit designs  ' });

    expect(setPendingInput).toHaveBeenCalledWith('试试用「canva」：Create, review, edit designs');
  });

  it('truncates a long description to 80 code points plus an ellipsis', () => {
    const long = 'a'.repeat(200);
    launch({ name: 'canva', description: long });

    expect(setPendingInput).toHaveBeenCalledWith(`试试用「canva」：${'a'.repeat(80)}…`);
  });

  it('counts code points, not UTF-16 units, when truncating', () => {
    // 80 astral code points = 160 UTF-16 units: exactly at the cap, so untouched.
    const emoji = '🙂'.repeat(80);
    launch({ name: 'canva', description: emoji });

    expect(setPendingInput).toHaveBeenCalledWith(`试试用「canva」：${emoji}`);
  });

  it('falls back to the generic hint when the description is missing or blank', () => {
    launch({ name: 'canva' });
    expect(setPendingInput).toHaveBeenCalledWith('试试用「canva」：帮我看看它能做什么');

    setPendingInput.mockClear();
    launch({ name: 'canva', description: '   ' });
    expect(setPendingInput).toHaveBeenCalledWith('试试用「canva」：帮我看看它能做什么');

    setPendingInput.mockClear();
    launch({ name: 'canva', description: null });
    expect(setPendingInput).toHaveBeenCalledWith('试试用「canva」：帮我看看它能做什么');
  });
});
