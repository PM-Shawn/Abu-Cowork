// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The drafts panel writes to disk: accepting a draft moves it into the user's
 * skills, rejecting one moves it to the trash. These tests hold the calls the
 * panel makes — which draft, in which order, and what a bulk answer acts on.
 */
import { useState, type ComponentProps, type ReactElement } from 'react';
import { act, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// How many times an icon button of a draft row has rendered: each one holds a tooltip.
const rendered = vi.hoisted(() => ({ iconButtons: 0 }));
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      rendered.iconButtons += 1;
      return actual.IconButton(props);
    },
  };
});

import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextField } from '@/components/ds/text-field';
import { format, getI18n } from '@/i18n';
import type { DraftRecord } from '@/core/skill/drafts';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useToastStore } from '@/stores/toastStore';
import { passSettleInterval } from '@/test/dsWindows';
import SkillDraftsPanel from './SkillDraftsPanel';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const tb = () => getI18n().toolbox;

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const draft = (skillName: string, expiresAt = NOW + 7 * DAY): DraftRecord => ({
  id: skillName,
  skillName,
  skillDir: `/drafts/${skillName}`,
  skillMdPath: `/drafts/${skillName}/SKILL.md`,
  action: 'create',
  triggerReason: `made after ${skillName}`,
  createdAt: NOW - DAY,
  expiresAt,
});

const names = (count: number) => Array.from({ length: count }, (_, index) => `draft-${index + 1}`);

const acceptDraft = vi.fn();
const rejectDraft = vi.fn();
const addToast = vi.fn();
const setProactivity = vi.fn();
const setDraftsOnboardingShown = vi.fn();

function seed(drafts: DraftRecord[], onboardingShown = true) {
  useSkillDraftsStore.setState({ drafts, acceptDraft, rejectDraft });
  useSettingsStore.setState({
    soul: { proactivity: 'companion', draftsOnboardingShown: onboardingShown },
    setProactivity,
    setDraftsOnboardingShown,
  });
  useToastStore.setState({ addToast });
}

// The button of a draft's own row: the two buttons sit in one group beside the draft's text.
const rowButton = (skillName: string, label: string) => {
  const buttons = screen.getAllByRole('button', { name: label });
  const button = buttons.find((candidate) => candidate.parentElement?.parentElement?.textContent?.includes(skillName));
  if (!button) throw new Error(`No "${label}" button for ${skillName}`);
  return button;
};

// The question's own button: it is the last one on the page with that name. A question takes no
// pointer press for a moment after it appears; by the time a case reaches for its button, it has
// been read.
const lastButton = (label: string) => {
  const button = screen.getAllByRole('button', { name: label }).at(-1);
  if (!button) throw new Error(`No "${label}" button`);
  passSettleInterval();
  return button;
};

beforeEach(() => {
  vi.clearAllMocks();
  rendered.iconButtons = 0;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  acceptDraft.mockResolvedValue({ ok: true });
  rejectDraft.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SkillDraftsPanel · one draft', () => {
  it('accepts the draft of the row that was pressed', async () => {
    seed(names(2).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-2', tb().draftsAccept));

    expect(acceptDraft).toHaveBeenCalledTimes(1);
    expect(acceptDraft).toHaveBeenCalledWith('draft-2');
    expect(rejectDraft).not.toHaveBeenCalled();
  });

  it('rejects the draft of the row that was pressed', async () => {
    seed(names(2).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-1', tb().draftsReject));

    expect(rejectDraft).toHaveBeenCalledTimes(1);
    expect(rejectDraft).toHaveBeenCalledWith('draft-1');
    expect(acceptDraft).not.toHaveBeenCalled();
  });

  it('reports a failed accept once, with the reason', async () => {
    acceptDraft.mockResolvedValue({ ok: false, error: 'disk full' });
    seed([draft('draft-1')]);
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-1', tb().draftsAccept));

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: tb().draftsAcceptError, message: 'disk full' });
  });

  it('reports a failed reject once, with the reason', async () => {
    rejectDraft.mockResolvedValue({ ok: false, error: 'busy' });
    seed([draft('draft-1')]);
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-1', tb().draftsReject));

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: tb().draftsRejectError, message: 'busy' });
  });
});

describe('SkillDraftsPanel · all drafts', () => {
  it('accepts fewer than five drafts at once, in list order, without asking', async () => {
    seed(names(4).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsAcceptAll }));

    await waitFor(() => expect(acceptDraft).toHaveBeenCalledTimes(4));
    expect(acceptDraft.mock.calls).toEqual(names(4).map((name) => [name]));
    expect(screen.queryByText(format(tb().draftsConfirmAcceptAll, { count: '4' }))).toBeNull();
  });

  it('rejects fewer than five drafts at once, in list order, without asking', async () => {
    seed(names(3).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsRejectAll }));

    await waitFor(() => expect(rejectDraft).toHaveBeenCalledTimes(3));
    expect(rejectDraft.mock.calls).toEqual(names(3).map((name) => [name]));
  });

  it('asks before accepting five drafts, and accepts them after the answer', async () => {
    seed(names(5).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsAcceptAll }));

    expect(await screen.findByText(format(tb().draftsConfirmAcceptAll, { count: '5' }))).toBeInTheDocument();
    expect(acceptDraft).not.toHaveBeenCalled();

    await user.click(lastButton(tb().draftsAcceptAll));

    await waitFor(() => expect(acceptDraft).toHaveBeenCalledTimes(5));
    expect(acceptDraft.mock.calls).toEqual(names(5).map((name) => [name]));
  });

  it('asks before rejecting five drafts, and rejects them after the answer', async () => {
    seed(names(5).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsRejectAll }));

    expect(await screen.findByText(format(tb().draftsConfirmRejectAll, { count: '5' }))).toBeInTheDocument();
    expect(rejectDraft).not.toHaveBeenCalled();

    await user.click(lastButton(tb().draftsRejectAll));

    await waitFor(() => expect(rejectDraft).toHaveBeenCalledTimes(5));
    expect(rejectDraft.mock.calls).toEqual(names(5).map((name) => [name]));
  });

  it('touches nothing when the question is cancelled', async () => {
    seed(names(5).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsRejectAll }));
    await screen.findByText(format(tb().draftsConfirmRejectAll, { count: '5' }));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByText(format(tb().draftsConfirmRejectAll, { count: '5' }))).toBeNull());
    expect(rejectDraft).not.toHaveBeenCalled();
    expect(acceptDraft).not.toHaveBeenCalled();
  });

  it('acts on the drafts that are still there when the question is answered', async () => {
    seed(names(6).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsAcceptAll }));
    await screen.findByText(format(tb().draftsConfirmAcceptAll, { count: '6' }));
    // One draft expired and one was accepted from a proposal card while the question was open.
    act(() => {
      useSkillDraftsStore.setState({ drafts: ['draft-1', 'draft-3', 'draft-4', 'draft-6'].map((name) => draft(name)) });
    });

    await user.click(lastButton(tb().draftsAcceptAll));

    await waitFor(() => expect(acceptDraft).toHaveBeenCalledTimes(4));
    expect(acceptDraft.mock.calls).toEqual([['draft-1'], ['draft-3'], ['draft-4'], ['draft-6']]);
  });

  // A task running in the background can write a draft while the question is open. The question
  // named the drafts that were there; one that arrived later was never on screen when it was answered.
  it.each([
    ['accepts', () => tb().draftsAcceptAll, acceptDraft, rejectDraft],
    ['rejects', () => tb().draftsRejectAll, rejectDraft, acceptDraft],
  ] as const)('%s only the drafts the question was asked about, and of those the ones still there', async (_verb, label, call, other) => {
    seed(names(5).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: label() }));
    await screen.findByRole('alertdialog');
    act(() => {
      useSkillDraftsStore.setState({ drafts: ['draft-1', 'draft-2', 'draft-4', 'draft-5', 'arrived-later'].map((name) => draft(name)) });
    });
    await user.click(lastButton(label()));

    await waitFor(() => expect(call).toHaveBeenCalledTimes(4));
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(call.mock.calls).toEqual([['draft-1'], ['draft-2'], ['draft-4'], ['draft-5']]);
    expect(other).not.toHaveBeenCalled();
  });

  it('names the draft in the notice when one of them fails', async () => {
    acceptDraft.mockImplementation(async (name: string) => (name === 'draft-2' ? { ok: false, error: 'exists' } : { ok: true }));
    seed(names(3).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsAcceptAll }));

    await waitFor(() => expect(acceptDraft).toHaveBeenCalledTimes(3));
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: tb().draftsAcceptError, message: 'draft-2: exists' });
  });
});

describe('SkillDraftsPanel · first time', () => {
  it('shows the introduction instead of the list, and saves the chosen level', async () => {
    seed([draft('draft-1')], false);
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    expect(screen.getByText(tb().draftsOnboardTitle)).toBeInTheDocument();
    expect(screen.queryByText('draft-1')).toBeNull();

    const butler = screen.getByText(tb().draftsOnboardPickButler).closest('button');
    if (!butler) throw new Error('No button for the level');
    await user.click(butler);
    expect(setProactivity).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: tb().draftsOnboardConfirm }));

    expect(setProactivity).toHaveBeenCalledTimes(1);
    expect(setProactivity).toHaveBeenCalledWith('butler');
    expect(setDraftsOnboardingShown).toHaveBeenCalledWith(true);
  });

  it('keeps the current level when nothing else is picked', async () => {
    seed([draft('draft-1')], false);
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(screen.getByRole('button', { name: tb().draftsOnboardConfirm }));

    expect(setProactivity).toHaveBeenCalledWith('companion');
  });

  it('renders nothing while there are no drafts', () => {
    seed([]);
    render(<SkillDraftsPanel />);
    expect(screen.queryByText(tb().draftsTitle)).toBeNull();
    expect(screen.queryByText(tb().draftsOnboardTitle)).toBeNull();
  });

  it('says which level is picked', async () => {
    seed([draft('draft-1')], false);
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);
    const level = (title: string) => screen.getByText(title).closest('button') as HTMLButtonElement;

    expect(level(tb().draftsOnboardPickCompanion)).toHaveAttribute('aria-pressed', 'true');
    expect(level(tb().draftsOnboardPickShy)).toHaveAttribute('aria-pressed', 'false');

    await user.click(level(tb().draftsOnboardPickShy));

    expect(level(tb().draftsOnboardPickShy)).toHaveAttribute('aria-pressed', 'true');
    expect(level(tb().draftsOnboardPickCompanion)).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('SkillDraftsPanel · a question outlives the panel', () => {
  // The question is asked from the page, so it stays on screen when the panel leaves
  // (the shelf changed, a search hid it). An answer given then touches no draft.
  it.each([
    ['accept', () => tb().draftsAcceptAll, acceptDraft],
    ['reject', () => tb().draftsRejectAll, rejectDraft],
  ] as const)('touches nothing when the %s-all question is answered after the panel has left', async (_kind, label, call) => {
    seed(names(5).map((name) => draft(name)));
    const user = userEvent.setup();
    const view = render(<SkillDraftsPanel />);
    await user.click(screen.getByRole('button', { name: label() }));
    const question = await screen.findByRole('alertdialog');

    view.rerender(<span>another shelf</span>);
    expect(screen.queryByText(tb().draftsTitle)).toBeNull();
    passSettleInterval();
    await user.click(within(question).getByRole('button', { name: label() }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(call).not.toHaveBeenCalled();
  });

  it('offers Cancel in words', async () => {
    seed(names(5).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);
    await user.click(screen.getByRole('button', { name: tb().draftsRejectAll }));

    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByRole('button', { name: getI18n().common.cancel })).toBeInTheDocument();
    expect(within(question).queryByRole('button', { name: '×' })).toBeNull();
  });
});

describe('SkillDraftsPanel · rows', () => {
  it('names the two buttons of a row, and marks an expired draft with a shape and words', () => {
    seed([draft('fresh'), draft('stale', NOW - DAY)]);
    render(<SkillDraftsPanel />);

    expect(screen.getAllByRole('button', { name: tb().draftsAccept })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: tb().draftsReject })).toHaveLength(2);
    const expired = screen.getByText(tb().draftsExpired);
    expect(expired).toHaveClass('text-danger');
    expect(expired.querySelector('svg')).not.toBeNull();
    expect(screen.getAllByText(tb().draftsExpired)).toHaveLength(1);
  });

  it('does not render again when the page around it renders', async () => {
    seed(names(3).map((name) => draft(name)));
    const user = userEvent.setup();
    function Page() {
      const [typed, setTyped] = useState('');
      return (
        <>
          <TextField aria-label="search" value={typed} onChange={(event) => setTyped(event.target.value)} />
          <SkillDraftsPanel />
        </>
      );
    }
    render(<Page />);
    // Two icon buttons, each with a tooltip, for each of the three rows.
    expect(rendered.iconButtons).toBe(6);

    await user.type(screen.getByRole('textbox', { name: 'search' }), 'abc');

    expect(screen.getByRole('textbox', { name: 'search' })).toHaveValue('abc');
    expect(rendered.iconButtons).toBe(6);
  });

  it('renders only the rows that are left when one leaves', async () => {
    seed(names(3).map((name) => draft(name)));
    render(<SkillDraftsPanel />);
    expect(rendered.iconButtons).toBe(6);

    act(() => { useSkillDraftsStore.setState({ drafts: useSkillDraftsStore.getState().drafts.slice(1) }); });

    // The two rows that stayed are the same rows: nothing of theirs rendered again.
    expect(screen.queryByText('draft-1')).toBeNull();
    expect(rendered.iconButtons).toBe(6);
  });
});

describe('SkillDraftsPanel · where the focus goes when a row leaves', () => {
  // The store drops the draft, as it does once the file has moved.
  const leaves = async (name: string) => {
    useSkillDraftsStore.setState({ drafts: useSkillDraftsStore.getState().drafts.filter((d) => d.skillName !== name) });
    return { ok: true };
  };

  it('moves to the same button of the row that took its place', async () => {
    acceptDraft.mockImplementation(leaves);
    seed(names(3).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-2', tb().draftsAccept));

    await waitFor(() => expect(screen.queryByText('draft-2')).toBeNull());
    expect(rowButton('draft-3', tb().draftsAccept)).toHaveFocus();
  });

  it('moves to the same button of the row before it when it was the last one', async () => {
    rejectDraft.mockImplementation(leaves);
    seed(names(3).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-3', tb().draftsReject));

    await waitFor(() => expect(screen.queryByText('draft-3')).toBeNull());
    expect(rowButton('draft-2', tb().draftsReject)).toHaveFocus();
  });

  it('moves to the page\'s add button when the panel leaves with its last draft', async () => {
    acceptDraft.mockImplementation(leaves);
    seed([draft('draft-1')]);
    const user = userEvent.setup();
    render(
      <>
        <Button data-testid="skill-create-trigger">add</Button>
        <SkillDraftsPanel />
      </>,
    );

    await user.click(rowButton('draft-1', tb().draftsAccept));

    await waitFor(() => expect(screen.queryByText('draft-1')).toBeNull());
    expect(screen.getByTestId('skill-create-trigger')).toHaveFocus();
  });

  it('moves to the page\'s add button when every draft was accepted at once', async () => {
    acceptDraft.mockImplementation(leaves);
    seed(names(2).map((name) => draft(name)));
    const user = userEvent.setup();
    render(
      <>
        <Button data-testid="skill-create-trigger">add</Button>
        <SkillDraftsPanel />
      </>,
    );

    await user.click(screen.getByRole('button', { name: tb().draftsAcceptAll }));

    await waitFor(() => expect(screen.queryByText(tb().draftsTitle)).toBeNull());
    expect(screen.getByTestId('skill-create-trigger')).toHaveFocus();
  });

  it('leaves the focus on the button when the draft could not be accepted', async () => {
    acceptDraft.mockResolvedValue({ ok: false, error: 'exists' });
    seed(names(2).map((name) => draft(name)));
    const user = userEvent.setup();
    render(<SkillDraftsPanel />);

    await user.click(rowButton('draft-1', tb().draftsAccept));

    await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
    expect(rowButton('draft-1', tb().draftsAccept)).toHaveFocus();
  });
});
