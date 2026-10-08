// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { DesignSystemProvider } from '@/components/ds/provider';
import CapabilitySetupDialog from '@/components/settings/CapabilitySetupDialog';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  requestCapabilitySetup,
  resolveCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import { initLanguage } from '@/i18n';
import { passSettleInterval } from '@/test/dsWindows';
import CloseDialog from './CloseDialog';
import CommandConfirmDialog from './CommandConfirmDialog';
import PermissionDialog from './PermissionDialog';

// The close-window question with each of the three real approval windows: the question is asked
// over the approval and answers only itself; an approval that arrives while the question is open
// takes the page and the question comes back afterwards. No approval is answered by anything
// but its own buttons, and nothing quits the app but the question's own Quit.

vi.mock('@/core/updates/checker', () => ({ restartApp: vi.fn() }));
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));
// The real bridge, with the one call that answers a request recorded.
vi.mock('@/core/capabilityPlugins/setupBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/capabilityPlugins/setupBridge')>();
  return { ...actual, resolveCapabilitySetup: vi.fn(actual.resolveCapabilitySetup) };
});
// The page a task's grant window shows: Cancel first, as on the real page.
vi.mock('@/components/settings/sections/CapabilitiesSection', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: ({ onSetupComplete, onSetupCancel }: { onSetupComplete: () => void; onSetupCancel: () => void }) => (
      <div>
        <Button onClick={onSetupCancel}>cancel setup</Button>
        <Button onClick={onSetupComplete}>complete setup</Button>
      </div>
    ),
  };
});

// What the user answered, in order: the question's callbacks and the approval's.
const answered: string[] = [];
const useQuestion = create(() => ({ open: false }));
const useCommand = create(() => ({ pending: false }));
const useFileGrant = create(() => ({ pending: false }));

function Question() {
  const { open } = useQuestion();
  const close = (answer: string) => {
    useQuestion.setState({ open: false });
    answered.push(answer);
  };
  return (
    <CloseDialog
      open={open}
      hasRunningAgent
      onQuit={() => close('question: quit')}
      onMinimize={() => close('question: minimize')}
      onCancel={() => close('question: cancel')}
      onCloseActionChange={(action) => { answered.push(`question: remember ${action}`); }}
    />
  );
}

// The command approval the way the chat view mounts it: answered, it leaves the page.
function CommandApproval() {
  const { pending } = useCommand();
  if (!pending) return null;
  const answer = (value: string) => {
    answered.push(value);
    useCommand.setState({ pending: false });
  };
  return (
    <CommandConfirmDialog
      request={{ command: 'echo not-a-real-command', level: 'warn', reason: 'needs a look' }}
      onConfirm={() => answer('command: confirmed')}
      onCancel={() => answer('command: refused')}
    />
  );
}

function FileGrant() {
  const { pending } = useFileGrant();
  if (!pending) return null;
  const answer = (value: string) => {
    answered.push(value);
    useFileGrant.setState({ pending: false });
  };
  return (
    <PermissionDialog
      request={{ type: 'file-write', path: '/fake/project/notes.txt' }}
      onAllow={(duration) => answer(`file grant: allowed ${duration}`)}
      onDeny={() => answer('file grant: refused')}
    />
  );
}

interface ApprovalKind {
  name: string;
  mount: ReactNode;
  arrive: () => void;
  find: () => Promise<HTMLElement>;
  // The button of the approval that refuses it, where the approval opens.
  refuse: () => HTMLElement;
  // Every answer the approval has been given.
  answers: () => string[];
  refused: string;
}

const kinds: ApprovalKind[] = [
  {
    name: 'the command approval',
    mount: <CommandApproval />,
    arrive: () => useCommand.setState({ pending: true }),
    find: () => screen.findByRole('alertdialog', { name: '操作确认' }),
    refuse: () => screen.getByRole('button', { name: '取消' }),
    answers: () => answered.filter((line) => line.startsWith('command:')),
    refused: 'command: refused',
  },
  {
    name: 'the file grant',
    mount: <FileGrant />,
    arrive: () => useFileGrant.setState({ pending: true }),
    find: () => screen.findByRole('alertdialog', { name: '文件写入权限' }),
    refuse: () => screen.getByRole('button', { name: '拒绝' }),
    answers: () => answered.filter((line) => line.startsWith('file grant:')),
    refused: 'file grant: refused',
  },
  {
    name: "the task's grant window",
    mount: <CapabilitySetupDialog />,
    arrive: () => {
      void requestCapabilitySetup('chrome', { conversationId: 'conversation-pending', toolCallId: 'tool-pending', interactionMode: 'foreground' });
    },
    find: () => screen.findByRole('dialog', { name: '连接我的 Chrome' }),
    refuse: () => screen.getByRole('button', { name: 'cancel setup' }),
    answers: () => vi.mocked(resolveCapabilitySetup).mock.calls.map(([, ready]) => (ready ? 'grant window: granted' : 'grant window: refused')),
    refused: 'grant window: refused',
  },
];

const question = () => screen.getByRole('alertdialog', { name: '关闭窗口' });
const questionAnswers = () => answered.filter((line) => line.startsWith('question:'));

describe.each(kinds)('the close-window question and $name', (kind) => {
  beforeEach(() => {
    initLanguage('zh-CN');
    answered.length = 0;
    drainCapabilitySetupRequests();
    vi.mocked(resolveCapabilitySetup).mockClear();
    useQuestion.setState({ open: false });
    useCommand.setState({ pending: false });
    useFileGrant.setState({ pending: false });
  });
  afterEach(() => {
    drainCapabilitySetupRequests();
    cleanup();
  });

  const renderPage = () => render(<><Question />{kind.mount}</>, { wrapper: DesignSystemProvider });

  describe('asked while the approval is on screen', () => {
    async function askOverTheApproval() {
      renderPage();
      act(() => kind.arrive());
      const window = await kind.find();
      await waitFor(() => expect(kind.refuse()).toHaveFocus());
      act(() => useQuestion.setState({ open: true }));
      // The question takes no pointer press for a moment after it appears; the keyboard is never
      // held. The cases below are about what each control answers once it has been read.
      passSettleInterval();
      return window;
    }

    it('is on the page together with it, with the focus on 「最小化到托盘」, and answers nothing by opening', async () => {
      const window = await askOverTheApproval();
      expect(question()).not.toHaveAttribute('hidden');
      expect(window).toBeInTheDocument();
      expect(window).not.toHaveAttribute('hidden');
      expect(screen.getByRole('button', { name: '最小化到托盘' })).toHaveFocus();
      expect(answered).toEqual([]);
    });

    it('closes alone on one Escape, the approval stays unanswered with the focus back in it, and the next Escape refuses the approval', async () => {
      const user = userEvent.setup();
      const window = await askOverTheApproval();

      await user.keyboard('{Escape}');
      expect(answered).toEqual(['question: cancel']);
      expect(screen.queryByRole('alertdialog', { name: '关闭窗口' })).toBeNull();
      expect(window).toBeInTheDocument();
      expect(kind.answers()).toEqual([]);
      await waitFor(() => expect(window).toContainElement(document.activeElement as HTMLElement));

      await user.keyboard('{Escape}');
      expect(kind.answers()).toEqual([kind.refused]);
      expect(questionAnswers()).toEqual(['question: cancel']);
    });

    it.each([
      ['最小化到托盘', 'question: minimize'],
      ['退出', 'question: quit'],
    ] as const)('answers only the question from 「%s」', async (name, answer) => {
      const window = await askOverTheApproval();
      await userEvent.setup().click(screen.getByRole('button', { name }));
      expect(answered).toEqual([answer]);
      expect(kind.answers()).toEqual([]);
      expect(window).toBeInTheDocument();
    });

    it('answers only the question from Enter and from Space pressed as soon as it opens: it minimizes', async () => {
      const user = userEvent.setup();
      await askOverTheApproval();
      await user.keyboard('{Enter}');
      expect(answered).toEqual(['question: minimize']);
      expect(kind.answers()).toEqual([]);
    });

    it('remembers the choice only with the answer, and the approval is still not answered', async () => {
      const user = userEvent.setup();
      await askOverTheApproval();
      await user.click(screen.getByRole('checkbox', { name: '记住我的选择' }));
      expect(answered).toEqual([]);
      await user.click(screen.getByRole('button', { name: '最小化到托盘' }));
      expect(answered).toEqual(['question: remember minimize', 'question: minimize']);
      expect(kind.answers()).toEqual([]);
    });
  });

  describe('open when the approval arrives', () => {
    it('steps aside unanswered with its tick; the approval shows on its refusing button; the question returns once that button has answered it', async () => {
      const user = userEvent.setup();
      renderPage();
      act(() => useQuestion.setState({ open: true }));
      passSettleInterval();
      await user.click(screen.getByRole('checkbox', { name: '记住我的选择' }));
      const box = question();

      act(() => kind.arrive());
      const window = await kind.find();
      await waitFor(() => expect(kind.refuse()).toHaveFocus());
      expect(box).toHaveAttribute('hidden');
      expect(screen.queryByRole('alertdialog', { name: '关闭窗口' })).toBeNull();
      expect(useQuestion.getState().open).toBe(true);
      expect(answered).toEqual([]);
      expect(kind.answers()).toEqual([]);

      // The approval has been on the page long enough to be read.
      passSettleInterval();
      await user.click(kind.refuse());
      await waitFor(() => expect(kind.answers()).toEqual([kind.refused]));
      await waitFor(() => expect(window).not.toBeInTheDocument());
      expect(question()).toBe(box);
      expect(box).not.toHaveAttribute('hidden');
      expect(screen.getByRole('checkbox', { name: '记住我的选择' })).toHaveAttribute('aria-checked', 'true');
      expect(questionAnswers()).toEqual([]);
      await waitFor(() => expect(box).toContainElement(document.activeElement as HTMLElement));
    });

    it('is not answered by a key while it stands aside: Escape refuses the approval alone', async () => {
      const user = userEvent.setup();
      renderPage();
      act(() => useQuestion.setState({ open: true }));
      act(() => kind.arrive());
      await kind.find();
      await waitFor(() => expect(kind.refuse()).toHaveFocus());

      await user.keyboard('{Escape}');
      await waitFor(() => expect(kind.answers()).toEqual([kind.refused]));
      expect(questionAnswers()).toEqual([]);
      expect(useQuestion.getState().open).toBe(true);
    });
  });

  it('leaves the approval waiting, unanswered, when the question is asked and cancelled several times', async () => {
    const user = userEvent.setup();
    renderPage();
    act(() => kind.arrive());
    const window = await kind.find();
    for (let round = 0; round < 3; round += 1) {
      act(() => useQuestion.setState({ open: true }));
      await user.keyboard('{Escape}');
    }
    expect(questionAnswers()).toEqual(['question: cancel', 'question: cancel', 'question: cancel']);
    expect(kind.answers()).toEqual([]);
    expect(window).toBeInTheDocument();
    if (kind.name === "the task's grant window") expect(getPendingCapabilitySetup()).not.toBeNull();
  });
});
