// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { Trigger } from '@/types/trigger';
import TriggerView from './TriggerView';

vi.mock('@/core/trigger/triggerEngine', () => ({
  triggerEngine: { getServerPort: () => 18080, handleEvent: vi.fn() },
}));

const realActions = useTriggerStore.getState();
const openEditor = vi.fn<typeof realActions.openEditor>();

const trigger = (id: string, name: string, createdAt: number, extra: Partial<Trigger> = {}): Trigger => ({
  id,
  name,
  status: 'active',
  source: { type: 'http' },
  filter: { type: 'always' },
  action: { prompt: 'Summarize $EVENT_DATA' },
  debounce: { enabled: false, windowSeconds: 0 },
  createdAt,
  updatedAt: createdAt,
  runs: [],
  totalRuns: 0,
  ...extra,
});

const seed = (...triggers: Trigger[]) => useTriggerStore.setState({
  triggers: Object.fromEntries(triggers.map((item) => [item.id, item])),
  selectedTriggerId: null,
  showEditor: false,
  editingTriggerId: null,
  editorTemplateDefaults: null,
});

const renderView = () => render(<DesignSystemProvider><TriggerView /></DesignSystemProvider>);
const status = (id: string) => useTriggerStore.getState().triggers[id].status;
const copy = () => getI18n().trigger;
// The on/off control of one card: a switch named after its listener.
const toggleOf = (name: string) => screen.getByRole('switch', { name });
const card = (id: string) => screen.getByTestId(`trigger-card-${id}`);
const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);
const button = (name: string) => screen.getByRole('button', { name });

describe('TriggerView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    openEditor.mockReset();
    openEditor.mockImplementation(realActions.openEditor);
    useDiscoveryStore.setState({ skills: [] });
    useIMChannelStore.setState({ channels: {} });
    useProjectStore.setState({ projects: {} });
    seed();
    useTriggerStore.setState({ openEditor });
  });

  afterEach(() => {
    cleanup();
    useTriggerStore.setState({ openEditor: realActions.openEditor });
    seed();
  });

  it('says what an event listener is for, with or without listeners', () => {
    renderView();
    expect(screen.getByText(copy().infoBanner)).toBeVisible();
  });

  it('says so when there is no listener yet, and offers three templates', () => {
    renderView();
    expect(screen.getByText(copy().noTriggers)).toBeVisible();
    expect(screen.getByText(copy().noTriggersHint)).toBeVisible();
    expect(screen.getByText(copy().useTemplate)).toBeVisible();
    for (const name of [copy().templateAlertSOP, copy().templateLogWatch, copy().templatePeriodicCheck]) {
      expect(screen.getByText(name)).toBeVisible();
    }
    expect(screen.getByText(copy().templateAlertSOPDesc)).toBeVisible();
    expect(screen.getByText(copy().templateLogWatchDesc)).toBeVisible();
    expect(screen.getByText(copy().templatePeriodicCheckDesc)).toBeVisible();
  });

  it.each([
    ['templateAlertSOP', { sourceType: 'http', filterType: 'keyword', promptKey: 'templateAlertSOPPrompt', keywordsKey: 'templateAlertSOPKeywords' }],
    ['templateLogWatch', { sourceType: 'file', filterType: 'always', promptKey: 'templateLogWatchPrompt', keywordsKey: undefined }],
    ['templatePeriodicCheck', { sourceType: 'cron', filterType: 'always', promptKey: 'templatePeriodicCheckPrompt', keywordsKey: undefined }],
  ] as const)('opens a new listener filled from the template %s', async (nameKey, expected) => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByText(copy()[nameKey]));

    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(openEditor.mock.calls[0][0]).toBeUndefined();
    expect(openEditor.mock.calls[0][1]).toStrictEqual({
      name: copy()[nameKey],
      sourceType: expected.sourceType,
      filterType: expected.filterType,
      prompt: copy()[expected.promptKey],
      keywords: expected.keywordsKey ? copy()[expected.keywordsKey] : undefined,
    });
    await user.keyboard('{Escape}');
  });

  it('lists the newest listener first', () => {
    seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 300), trigger('c', '监听 C', 200));
    renderView();
    expect(screen.getAllByText(/^监听 [ABC]$/).map((element) => element.textContent)).toEqual(['监听 B', '监听 C', '监听 A']);
    expect(screen.queryByText(copy().noTriggers)).toBeNull();
  });

  it('shows what a listener matches, that it pushes its result, and when it last fired', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const noon = new Date(2026, 0, 5, 12, 0, 0);
    vi.setSystemTime(noon);
    try {
      seed(
        trigger('a', '监听 A', 100, {
          filter: { type: 'keyword', keywords: ['error', 'alert'] },
          output: { enabled: true, target: 'webhook', extractMode: 'last_message' },
          lastTriggeredAt: noon.getTime() - 2 * 3600_000,
        }),
        trigger('b', '监听 B', 200, { filter: { type: 'regex', pattern: 'P[01]' } }),
        trigger('c', '监听 C', 300),
      );
      renderView();
      expect(screen.getByText('关键词匹配: error, alert')).toBeVisible();
      expect(screen.getByText('正则匹配: P[01]')).toBeVisible();
      expect(screen.getByText('所有事件')).toBeVisible();
      expect(screen.getAllByText(copy().outputEnabled)).toHaveLength(1);
      expect(screen.getByText('上次触发: 2小时前')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the listener whose card is pressed', async () => {
    const user = userEvent.setup();
    seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200));
    renderView();

    await user.click(screen.getByText('监听 A'));

    expect(useTriggerStore.getState().selectedTriggerId).toBe('a');
    expect(screen.getByRole('heading', { level: 1, name: '监听 A' })).toBeVisible();
    expect(screen.queryByText(copy().infoBanner)).toBeNull();
  });

  it('pauses and resumes from the card without opening the listener', async () => {
    const user = userEvent.setup();
    seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200, { status: 'paused' }));
    renderView();

    await user.click(toggleOf('监听 A'));
    expect(status('a')).toBe('paused');
    await user.click(toggleOf('监听 B'));
    expect(status('b')).toBe('active');

    expect(useTriggerStore.getState().selectedTriggerId).toBeNull();
  });

  it('takes Enter and Space on the card switch, and nothing from the arrow keys', async () => {
    const user = userEvent.setup();
    seed(trigger('a', '监听 A', 100));
    renderView();
    toggleOf('监听 A').focus();

    await user.keyboard('{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}');
    expect(status('a')).toBe('active');

    await user.keyboard('{Enter}');
    expect(status('a')).toBe('paused');
    await user.keyboard(' ');
    expect(status('a')).toBe('active');

    expect(useTriggerStore.getState().selectedTriggerId).toBeNull();
  });

  it('shows the list when the chosen listener no longer exists', () => {
    seed(trigger('a', '监听 A', 100));
    useTriggerStore.setState({ selectedTriggerId: 'gone' });
    renderView();

    expect(screen.getByText(copy().infoBanner)).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('draws the hint as a status line and the empty list as the design-system empty state', () => {
    renderView();
    expect(screen.getByRole('status')).toHaveTextContent(copy().infoBanner);
    // The design-system empty state: its title is a window-title-sized line.
    expect(classes(screen.getByText(copy().noTriggers))).toContain('text-title');
    expect(classes(screen.getByText(copy().useTemplate))).toContain('text-label-tertiary');
  });

  it('offers each template as a button named after it, described by what it does', () => {
    renderView();
    for (const [nameKey, descKey] of [
      ['templateAlertSOP', 'templateAlertSOPDesc'],
      ['templateLogWatch', 'templateLogWatchDesc'],
      ['templatePeriodicCheck', 'templatePeriodicCheckDesc'],
    ] as const) {
      const template = button(copy()[nameKey]);
      expect(template).toHaveAccessibleDescription(copy()[descKey]);
      expect(classes(template)).toContain('rounded-panel');
    }
    // The three marks keep their status color, each with its own shape.
    expect(classes(button(copy().templateAlertSOP).querySelector('svg')!)).toContain('text-warning');
    expect(classes(button(copy().templateLogWatch).querySelector('svg')!)).toContain('text-info');
    expect(classes(button(copy().templatePeriodicCheck).querySelector('svg')!)).toContain('text-success');
  });

  it('draws each listener as a card that is a button, found again by its listener id', () => {
    seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200, { status: 'paused' }));
    renderView();

    expect(card('a')).toHaveAttribute('role', 'button');
    expect(card('a').parentElement).toHaveAttribute('data-automation-entry', 'a');
    expect(toggleOf('监听 A')).toBeChecked();
    expect(toggleOf('监听 B')).not.toBeChecked();
  });

  it('says that a listener pushes its result in a tag, on the card of that listener only', () => {
    seed(
      trigger('a', '监听 A', 100, { output: { enabled: true, target: 'webhook', extractMode: 'last_message' } }),
      trigger('b', '监听 B', 200, { output: { enabled: false, target: 'webhook', extractMode: 'last_message' } }),
    );
    renderView();

    const tag = within(card('a')).getByText(copy().outputEnabled);
    expect(classes(tag)).toContain('bg-fill');
    expect(tag.querySelector('svg')).not.toBeNull();
    expect(within(card('b')).queryByText(copy().outputEnabled)).toBeNull();
  });

  it('opens the listener from the keyboard when its card has the focus', async () => {
    const user = userEvent.setup();
    seed(trigger('a', '监听 A', 100));
    renderView();
    card('a').focus();

    await user.keyboard('{Enter}');

    expect(useTriggerStore.getState().selectedTriggerId).toBe('a');
  });

  it('keeps one editor mounted while the list and a listener page replace each other', async () => {
    const user = userEvent.setup();
    seed(trigger('a', '监听 A', 100));
    renderView();
    act(() => useTriggerStore.getState().openEditor('a'));
    const editor = screen.getByRole('dialog', { name: copy().editTrigger });

    act(() => useTriggerStore.getState().setSelectedTriggerId('a'));

    expect(screen.getByRole('dialog', { name: copy().editTrigger })).toBe(editor);
    await user.keyboard('{Escape}');
  });

  describe('keyboard focus between the list and a listener page', () => {
    const backButton = () => button(getI18n().schedule.backToList);
    const withCreateButton = () => render(
      <DesignSystemProvider>
        <Button data-testid="automation-create" onClick={() => useTriggerStore.getState().openEditor()}>create</Button>
        <TriggerView />
      </DesignSystemProvider>,
    );

    it('lands on the way back when a card opens its listener, and on that card on the way back', async () => {
      const user = userEvent.setup();
      seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200));
      renderView();
      card('a').focus();

      await user.keyboard('{Enter}');
      expect(backButton()).toHaveFocus();
      expect(backButton()).toHaveAttribute('data-automation-back');

      await user.keyboard('{Enter}');
      expect(useTriggerStore.getState().selectedTriggerId).toBeNull();
      expect(card('a')).toHaveFocus();
    });

    it('moves no focus when the page first shows, whichever of the two it shows', () => {
      seed(trigger('a', '监听 A', 100));
      useTriggerStore.setState({ selectedTriggerId: 'a' });
      renderView();
      expect(document.body).toHaveFocus();
    });

    it('leaves the focus where it is when it sits on a control outside the page', () => {
      seed(trigger('a', '监听 A', 100));
      withCreateButton();
      screen.getByTestId('automation-create').focus();

      act(() => useTriggerStore.getState().setSelectedTriggerId('a'));

      expect(screen.getByTestId('automation-create')).toHaveFocus();
    });

    it('goes to the card that took the place of a deleted listener, else the one before it', async () => {
      const user = userEvent.setup();
      seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200), trigger('c', '监听 C', 300));
      renderView();

      // The middle card: its place is taken by the card after it.
      await user.click(card('b'));
      await user.click(button(copy().delete));
      await user.click(button(getI18n().common.confirm));
      expect(Object.keys(useTriggerStore.getState().triggers)).toEqual(['a', 'c']);
      expect(card('a')).toHaveFocus();

      // The last card: the one before it.
      await user.click(card('a'));
      await user.click(button(copy().delete));
      await user.click(button(getI18n().common.confirm));
      expect(Object.keys(useTriggerStore.getState().triggers)).toEqual(['c']);
      expect(card('c')).toHaveFocus();
    });

    it('goes to the create button when the last listener is deleted', async () => {
      const user = userEvent.setup();
      seed(trigger('a', '监听 A', 100));
      withCreateButton();

      await user.click(card('a'));
      await user.click(button(copy().delete));
      await user.click(button(getI18n().common.confirm));

      expect(useTriggerStore.getState().triggers).toEqual({});
      expect(screen.getByTestId('automation-create')).toHaveFocus();
    });

    it('lands on the way back of the new listener when it was made from a template, which leaves with the empty list', async () => {
      const user = userEvent.setup();
      renderView();

      await user.click(button(copy().templateAlertSOP));
      await user.click(button(getI18n().common.save));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(backButton()).toHaveFocus());
    });

    // A tool in a conversation can delete the listener whose page is in view. A window opened
    // from that page then gives the focus back to a button that has left with the page.
    describe('when the listener in view is deleted from outside under a window opened from its page', () => {
      it('goes to the card that took its place once the delete question is cancelled', async () => {
        const user = userEvent.setup();
        seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200));
        renderView();
        await user.click(card('a'));
        await user.click(button(copy().delete));

        act(() => useTriggerStore.getState().deleteTrigger('a'));
        await user.click(button(getI18n().common.cancel));

        await waitFor(() => expect(card('b')).toHaveFocus());
      });

      it('goes to the card that took its place once the delete question is confirmed', async () => {
        const user = userEvent.setup();
        seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200));
        renderView();
        await user.click(card('a'));
        await user.click(button(copy().delete));

        act(() => useTriggerStore.getState().deleteTrigger('a'));
        await user.click(button(getI18n().common.confirm));

        await waitFor(() => expect(card('b')).toHaveFocus());
        expect(Object.keys(useTriggerStore.getState().triggers)).toEqual(['b']);
      });

      it('goes to the card that took its place once the editor is closed', async () => {
        const user = userEvent.setup();
        seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200));
        renderView();
        await user.click(card('a'));
        await user.click(button(copy().edit));

        act(() => useTriggerStore.getState().deleteTrigger('a'));
        await user.click(button(getI18n().common.cancel));
        // What was on the form no longer belongs to a listener; the window asks before it drops it.
        const discard = screen.queryByRole('button', { name: getI18n().designSystem.discard });
        if (discard) await user.click(discard);

        await waitFor(() => expect(card('b')).toHaveFocus());
      });

      it('goes to the create button when no listener is left', async () => {
        const user = userEvent.setup();
        seed(trigger('a', '监听 A', 100));
        withCreateButton();
        await user.click(card('a'));
        await user.click(button(copy().edit));

        act(() => useTriggerStore.getState().deleteTrigger('a'));
        await user.click(button(getI18n().common.cancel));
        const discard = screen.queryByRole('button', { name: getI18n().designSystem.discard });
        if (discard) await user.click(discard);

        await waitFor(() => expect(screen.getByTestId('automation-create')).toHaveFocus());
      });

      it('leaves the focus on the button that opened the editor when that button is still on the page', async () => {
        const user = userEvent.setup();
        seed(trigger('a', '监听 A', 100), trigger('b', '监听 B', 200));
        withCreateButton();
        await user.click(card('a'));
        await user.click(screen.getByTestId('automation-create'));

        act(() => useTriggerStore.getState().deleteTrigger('a'));
        await user.click(button(getI18n().common.cancel));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(screen.getByTestId('automation-create')).toHaveFocus());
      });
    });
  });
});
