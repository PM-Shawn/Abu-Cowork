// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { APPROVAL_TITLE, approvalProbe, closingWindow, discardQuestion, finishClosing, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextArea } from '@/components/ds/text-area';
import { getI18n, initLanguage } from '@/i18n';
import CreateProjectDialog from './CreateProjectDialog';

// Everything the window does, in the order it does it.
const h = vi.hoisted(() => ({ log: [] as string[] }));

interface FakeProject { id: string; name: string; workspacePath: string; description?: string }
interface FakeConversation { id: string; workspacePath?: string; projectId?: string }

vi.mock('@/stores/projectStore', async () => {
  const { create } = await import('zustand');
  const useProjectStore = create<{
    projects: Record<string, FakeProject>;
    createProject: (data: Omit<FakeProject, 'id'>) => string;
    getProjectByWorkspace: (workspacePath: string) => FakeProject | undefined;
  }>()((set, get) => ({
    projects: {},
    createProject: (data) => {
      h.log.push(`createProject ${JSON.stringify(data)}`);
      set((state) => ({ projects: { ...state.projects, 'p-new': { ...data, id: 'p-new' } } }));
      return 'p-new';
    },
    getProjectByWorkspace: (workspacePath) => Object.values(get().projects).find((project) => project.workspacePath === workspacePath),
  }));
  return { useProjectStore };
});
vi.mock('@/stores/chatStore', async () => {
  const { create } = await import('zustand');
  const useChatStore = create<{
    conversationIndex: Record<string, FakeConversation>;
    setConversationProject: (id: string, projectId: string) => void;
    startNewConversation: () => void;
  }>()(() => ({
    conversationIndex: {},
    setConversationProject: (id, projectId) => { h.log.push(`setConversationProject ${id} ${projectId}`); },
    startNewConversation: () => { h.log.push('startNewConversation'); },
  }));
  return { useChatStore };
});
vi.mock('@/stores/workspaceStore', async () => {
  const { create } = await import('zustand');
  return { useWorkspaceStore: create(() => ({ setWorkspace: (path: string) => { h.log.push(`setWorkspace ${path}`); } })) };
});
vi.mock('@/stores/settingsStore', async () => {
  const { create } = await import('zustand');
  return { useSettingsStore: create(() => ({ setViewMode: (mode: string) => { h.log.push(`setViewMode ${mode}`); } })) };
});
vi.mock('@/stores/previewStore', async () => {
  const { create } = await import('zustand');
  return { usePreviewStore: create(() => ({ setFileTreeMode: (on: boolean) => { h.log.push(`setFileTreeMode ${on}`); } })) };
});

import { useChatStore as chatStore } from '@/stores/chatStore';
import { useProjectStore as projectStore } from '@/stores/projectStore';

// The stores above are the stand-ins: each holds only what the window reads.
interface StandIn { setState: (state: Record<string, unknown>) => void }
const useChatStore = chatStore as unknown as StandIn;
const useProjectStore = projectStore as unknown as StandIn;

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();
const HOME = '/fake/home';
const PROJECTS = `${HOME}/Documents/Abu/Projects`;
const INSTRUCTIONS_PLACEHOLDER = 'Tell Abu how to work in this project (optional)';

const ui = {
  scratchCard: () => screen.getByRole('button', { name: new RegExp(t().project.modeFromScratch) }),
  existingCard: () => screen.getByRole('button', { name: new RegExp(t().project.modeExistingFolder) }),
  queryScratchCard: () => screen.queryByRole('button', { name: new RegExp(t().project.modeFromScratch) }),
  name: () => screen.getByPlaceholderText<HTMLInputElement>(t().project.namePlaceholder),
  instructions: () => screen.getByPlaceholderText<HTMLTextAreaElement>(INSTRUCTIONS_PLACEHOLDER),
  create: () => screen.getByRole('button', { name: t().project.create }),
  cancel: () => screen.getByRole('button', { name: t().project.cancel }),
  type: (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } }),
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

// Lets every promise the window waits on settle.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

function open(props: Partial<Parameters<typeof CreateProjectDialog>[0]> = {}) {
  const onClose = vi.fn(() => { h.log.push('onClose'); });
  const view = render(<CreateProjectDialog open onClose={onClose} {...props} />);
  return { onClose, close: () => view.rerender(<CreateProjectDialog open={false} onClose={onClose} {...props} />) };
}

async function openScratch(props: Partial<Parameters<typeof CreateProjectDialog>[0]> = {}) {
  const opened = open(props);
  await settle();
  fireEvent.click(ui.scratchCard());
  return opened;
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  h.log.length = 0;
  useProjectStore.setState({ projects: {} });
  useChatStore.setState({ conversationIndex: {} });
  vi.mocked(homeDir).mockReset().mockResolvedValue(HOME);
  vi.mocked(openDialog).mockReset().mockResolvedValue(null);
  vi.mocked(exists).mockReset().mockResolvedValue(false);
  vi.mocked(mkdir).mockReset().mockImplementation(async (path) => { h.log.push(`mkdir ${String(path)}`); });
  vi.mocked(writeTextFile).mockReset().mockImplementation(async (path, text) => { h.log.push(`writeTextFile ${String(path)} ${text}`); });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CreateProjectDialog', () => {
  describe('from scratch', () => {
    it('makes the folder, creates the project and moves to it, in that order', async () => {
      const { onClose } = await openScratch();
      ui.type(ui.name(), '  Demo  ');

      fireEvent.click(ui.create());
      await settle();

      expect(h.log).toEqual([
        `mkdir ${PROJECTS}/Demo`,
        `createProject ${JSON.stringify({ name: 'Demo', workspacePath: `${PROJECTS}/Demo` })}`,
        'startNewConversation',
        `setWorkspace ${PROJECTS}/Demo`,
        'setViewMode chat',
        'setFileTreeMode true',
        'onClose',
      ]);
      expect(vi.mocked(mkdir).mock.calls[0][1]).toEqual({ recursive: true });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('writes the instructions into .abu/ABU.md before the project exists', async () => {
      await openScratch();
      ui.type(ui.name(), 'Demo');
      ui.type(ui.instructions(), '  Answer briefly.  ');

      fireEvent.click(ui.create());
      await settle();

      expect(h.log.slice(0, 4)).toEqual([
        `mkdir ${PROJECTS}/Demo`,
        `mkdir ${PROJECTS}/Demo/.abu`,
        `writeTextFile ${PROJECTS}/Demo/.abu/ABU.md Answer briefly.`,
        `createProject ${JSON.stringify({ name: 'Demo', workspacePath: `${PROJECTS}/Demo` })}`,
      ]);
    });

    it('writes no instructions file when none were typed', async () => {
      await openScratch();
      ui.type(ui.name(), 'Demo');
      ui.type(ui.instructions(), '   ');

      fireEvent.click(ui.create());
      await settle();

      expect(writeTextFile).not.toHaveBeenCalled();
      expect(mkdir).toHaveBeenCalledTimes(1);
    });

    it('moves the conversations of the same folder that have no project into the new one', async () => {
      useChatStore.setState({
        conversationIndex: {
          c1: { id: 'c1', workspacePath: `${PROJECTS}/Demo` },
          c2: { id: 'c2', workspacePath: `${PROJECTS}/Demo`, projectId: 'p-other' },
          c3: { id: 'c3', workspacePath: '/fake/elsewhere' },
        },
      });
      await openScratch();
      ui.type(ui.name(), 'Demo');

      fireEvent.click(ui.create());
      await settle();

      expect(h.log.filter((entry) => entry.startsWith('setConversationProject'))).toEqual(['setConversationProject c1 p-new']);
      expect(h.log.indexOf('setConversationProject c1 p-new')).toBeGreaterThan(h.log.findIndex((entry) => entry.startsWith('createProject')));
      expect(h.log.indexOf('setConversationProject c1 p-new')).toBeLessThan(h.log.indexOf('startNewConversation'));
    });

    it('cannot create without a name', async () => {
      await openScratch();
      expect(ui.create()).toBeDisabled();

      ui.type(ui.name(), '   ');
      expect(ui.create()).toBeDisabled();

      ui.type(ui.name(), 'Demo');
      expect(ui.create()).toBeEnabled();
    });

    it('shows where the folder will be', async () => {
      await openScratch();
      expect(screen.getByText(PROJECTS)).toBeInTheDocument();

      ui.type(ui.name(), ' Demo ');
      expect(screen.getByText(`${PROJECTS}/Demo`)).toBeInTheDocument();
    });

    it('creates nothing and stays open when the folder cannot be made', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(mkdir).mockRejectedValueOnce(new Error('made-up refusal'));
      const { onClose } = await openScratch();
      ui.type(ui.name(), 'Demo');

      fireEvent.click(ui.create());
      await settle();

      expect(h.log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
      expect(ui.name().value).toBe('Demo');
      expect(error).toHaveBeenCalledTimes(1);
    });

    // What is on disk then: the folder, without a project. The window stays open with what was typed.
    it('creates no project when the instructions cannot be written, and stays open', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('made-up refusal'));
      const { onClose } = await openScratch();
      ui.type(ui.name(), 'Demo');
      ui.type(ui.instructions(), 'Answer briefly.');

      fireEvent.click(ui.create());
      await settle();

      expect(h.log).toEqual([`mkdir ${PROJECTS}/Demo`, `mkdir ${PROJECTS}/Demo/.abu`]);
      expect(onClose).not.toHaveBeenCalled();
      expect(ui.instructions().value).toBe('Answer briefly.');
    });

    // The window closed between making the folder and creating the project: the project is still
    // created, so a folder is never left on disk without its project.
    it('finishes creating when its owner closes it while the folder is being made', async () => {
      let folderMade!: () => void;
      vi.mocked(mkdir).mockImplementationOnce((path) => {
        h.log.push(`mkdir ${String(path)}`);
        return new Promise<void>((resolve) => { folderMade = resolve; });
      });
      const { onClose, close } = await openScratch();
      ui.type(ui.name(), 'Demo');
      fireEvent.click(ui.create());
      await settle();
      expect(h.log).toEqual([`mkdir ${PROJECTS}/Demo`]);

      close();
      await act(async () => { folderMade(); });
      await settle();

      expect(h.log).toEqual([
        `mkdir ${PROJECTS}/Demo`,
        `createProject ${JSON.stringify({ name: 'Demo', workspacePath: `${PROJECTS}/Demo` })}`,
        'startNewConversation',
        `setWorkspace ${PROJECTS}/Demo`,
        'setViewMode chat',
        'setFileTreeMode true',
        'onClose',
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('an existing folder', () => {
    it('opens the folder picker with the card, fills the name from the folder and creates without making a folder', async () => {
      vi.mocked(openDialog).mockResolvedValue('/fake/work/reports');
      const { onClose } = open();
      await settle();

      fireEvent.click(ui.existingCard());
      await settle();

      expect(openDialog).toHaveBeenCalledWith({ directory: true, multiple: false, title: t().project.selectFolder });
      expect(ui.name().value).toBe('reports');
      expect(screen.getByText('/fake/work/reports')).toBeInTheDocument();

      fireEvent.click(ui.create());
      await settle();

      expect(mkdir).not.toHaveBeenCalled();
      expect(h.log).toEqual([
        `createProject ${JSON.stringify({ name: 'reports', workspacePath: '/fake/work/reports' })}`,
        'startNewConversation',
        'setWorkspace /fake/work/reports',
        'setViewMode chat',
        'setFileTreeMode true',
        'onClose',
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps a name that was already typed when a folder is picked', async () => {
      vi.mocked(openDialog).mockResolvedValueOnce(null).mockResolvedValueOnce('/fake/work/reports');
      open();
      await settle();
      fireEvent.click(ui.existingCard());
      await settle();
      ui.type(ui.name(), 'My name');

      fireEvent.click(screen.getByRole('button', { name: t().project.selectFolder }));
      await settle();

      expect(ui.name().value).toBe('My name');
      expect(screen.getByText('/fake/work/reports')).toBeInTheDocument();
    });

    it('cannot create before a folder is picked', async () => {
      open();
      await settle();
      fireEvent.click(ui.existingCard());
      await settle();
      ui.type(ui.name(), 'Demo');

      expect(ui.create()).toBeDisabled();
    });

    it('says which project already uses the folder and cannot create', async () => {
      useProjectStore.setState({ projects: { p1: { id: 'p1', name: 'Reports', workspacePath: '/fake/work/reports' } } });
      vi.mocked(openDialog).mockResolvedValue('/fake/work/reports');
      open();
      await settle();

      fireEvent.click(ui.existingCard());
      await settle();

      expect(screen.getByText(new RegExp(t().project.folderConflict.replace('{name}', 'Reports')))).toBeInTheDocument();
      expect(ui.create()).toBeDisabled();
    });

    it('says when the folder already holds a project configuration', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(openDialog).mockResolvedValue('/fake/work/reports');
      open();
      await settle();

      fireEvent.click(ui.existingCard());
      await settle();

      expect(exists).toHaveBeenCalledWith('/fake/work/reports/.abu/ABU.md');
      expect(screen.getByText(new RegExp(t().project.detectedConfig))).toBeInTheDocument();
      expect(ui.create()).toBeEnabled();
    });
  });

  describe('opened with a folder already chosen', () => {
    const preset = { presetMode: 'existing-folder', presetFolder: '/fake/work/notes', presetName: 'notes' } as const;

    it('goes straight to the form, filled in', async () => {
      open(preset);
      await settle();

      expect(ui.queryScratchCard()).not.toBeInTheDocument();
      expect(ui.name().value).toBe('notes');
      expect(screen.getByText('/fake/work/notes')).toBeInTheDocument();
      expect(openDialog).not.toHaveBeenCalled();
    });

    it('creates the project for that folder', async () => {
      const { onClose } = open(preset);
      await settle();

      fireEvent.click(ui.create());
      await settle();

      expect(h.log[0]).toBe(`createProject ${JSON.stringify({ name: 'notes', workspacePath: '/fake/work/notes' })}`);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing', () => {
    it('closes on Escape when nothing was typed', async () => {
      const { onClose } = open();
      await settle();

      ui.escape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(h.log).toEqual(['onClose']);
    });

    it('closes on Cancel when nothing was typed', async () => {
      const { onClose } = await openScratch();

      fireEvent.click(ui.cancel());

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('starts empty again the next time it opens', async () => {
      const onClose = vi.fn();
      const view = render(<CreateProjectDialog open onClose={onClose} />);
      await settle();
      fireEvent.click(ui.scratchCard());
      ui.type(ui.name(), 'Demo');

      view.rerender(<CreateProjectDialog open={false} onClose={onClose} />);
      view.rerender(<CreateProjectDialog open onClose={onClose} />);
      await settle();

      expect(ui.scratchCard()).toBeInTheDocument();
      fireEvent.click(ui.scratchCard());
      expect(ui.name().value).toBe('');
    });
  });

  describe('as a design-system window', () => {
    const back = () => screen.queryByRole('button', { name: t().schedule.backToList });
    const folderButton = () => screen.getByRole('button', { name: t().project.selectFolder });

    it('is a dialog named by its title, with the two ways as buttons and a word about them', async () => {
      open();
      await settle();

      const window = screen.getByRole('dialog', { name: t().project.createTitle });
      expect(window).toContainElement(ui.scratchCard());
      expect(window).toContainElement(ui.existingCard());
      expect(window).toHaveTextContent(t().project.createDesc);
      expect(screen.getByRole('button', { name: t().common.close })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t().project.create })).not.toBeInTheDocument();
    });

    it('drops the word about the two ways once one is chosen, and offers the way back', async () => {
      await openScratch();

      expect(screen.getByRole('dialog', { name: t().project.createTitle })).not.toHaveTextContent(t().project.createDesc);
      fireEvent.click(back()!);

      expect(ui.scratchCard()).toBeInTheDocument();
      expect(back()).not.toBeInTheDocument();
    });

    it('has no way back when it opens with a folder already chosen', async () => {
      open({ presetMode: 'existing-folder', presetFolder: '/fake/work/notes', presetName: 'notes' });
      await settle();

      expect(back()).not.toBeInTheDocument();
    });

    it('shows the folder problem as an alert and the found configuration as a status', async () => {
      useProjectStore.setState({ projects: { p1: { id: 'p1', name: 'Reports', workspacePath: '/fake/work/reports' } } });
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(openDialog).mockResolvedValue('/fake/work/reports');
      open();
      await settle();
      fireEvent.click(ui.existingCard());
      await settle();

      expect(screen.getByRole('alert')).toHaveTextContent(t().project.folderConflict.replace('{name}', 'Reports'));
      expect(screen.getByRole('status')).toHaveTextContent(t().project.detectedConfig);
      expect(screen.getByRole('alert').textContent).not.toContain('✗');
      expect(screen.getByRole('status').textContent).not.toContain('✓');
    });

    describe('focus', () => {
      it('goes to the name field when the user starts from scratch, and back to that way on the way back', async () => {
        await openScratch();
        expect(ui.name()).toHaveFocus();

        fireEvent.click(back()!);
        expect(ui.scratchCard()).toHaveFocus();
      });

      it('goes to the folder button for an existing folder, and back to that way on the way back', async () => {
        open();
        await settle();
        fireEvent.click(ui.existingCard());
        await settle();
        expect(folderButton()).toHaveFocus();

        fireEvent.click(back()!);
        expect(ui.existingCard()).toHaveFocus();
      });

      it('opens on the name field when the folder is already chosen', async () => {
        open({ presetMode: 'existing-folder', presetFolder: '/fake/work/notes', presetName: 'notes' });
        await settle();

        expect(ui.name()).toHaveFocus();
      });
    });

    describe('where the focus goes once it has closed', () => {
      function Owner() {
        const [isOpen, setOpen] = useState(false);
        return (
          <>
            <Button onClick={() => setOpen(true)}>Open it</Button>
            <TextArea data-chat-composer aria-label="Message" />
            <CreateProjectDialog open={isOpen} onClose={() => setOpen(false)} />
          </>
        );
      }
      async function openFromButton() {
        keepClosingLayersOnScreen();
        render(<Owner />);
        const opener = screen.getByRole('button', { name: 'Open it' });
        opener.focus();
        fireEvent.click(opener);
        await settle();
        return opener;
      }

      it('returns to the control that opened it when nothing was created', async () => {
        const opener = await openFromButton();

        ui.escape();
        finishClosing();

        expect(opener).toHaveFocus();
      });

      // The page has changed to the new project: the control that opened the window may be gone.
      it('goes to the message field when a project was created', async () => {
        await openFromButton();
        fireEvent.click(ui.scratchCard());
        ui.type(ui.name(), 'Demo');

        fireEvent.click(ui.create());
        await settle();
        finishClosing();

        expect(screen.getByLabelText('Message')).toHaveFocus();
      });

      it('returns to the control that opened it the next time, when that opening creates nothing', async () => {
        const opener = await openFromButton();
        fireEvent.click(ui.scratchCard());
        ui.type(ui.name(), 'Demo');
        fireEvent.click(ui.create());
        await settle();
        finishClosing();

        opener.focus();
        fireEvent.click(opener);
        await settle();
        ui.escape();
        finishClosing();

        expect(opener).toHaveFocus();
      });
    });

    describe('with a name typed', () => {
      it('asks before it closes on Escape; keeping on leaves the name, discarding closes', async () => {
        const { onClose } = await openScratch();
        ui.type(ui.name(), 'Demo');

        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        discardQuestion.keepEditing();
        expect(discardQuestion.box()).toBeNull();
        expect(ui.name().value).toBe('Demo');
        expect(onClose).not.toHaveBeenCalled();

        ui.escape();
        discardQuestion.discard();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(h.log).toEqual(['onClose']);
      });

      it('asks before it closes on Cancel and on the corner button', async () => {
        const { onClose } = await openScratch();
        ui.type(ui.name(), 'Demo');

        fireEvent.click(ui.cancel());
        expect(discardQuestion.box()).not.toBeNull();
        discardQuestion.keepEditing();

        fireEvent.click(screen.getByRole('button', { name: t().common.close }));
        expect(discardQuestion.box()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
      });

      it('asks once a folder is picked, and not when the picker was left without one', async () => {
        vi.mocked(openDialog).mockResolvedValueOnce(null).mockResolvedValueOnce('/fake/work/reports');
        const { onClose } = open();
        await settle();
        fireEvent.click(ui.existingCard());
        await settle();
        fireEvent.click(folderButton());
        await settle();

        ui.escape();

        expect(discardQuestion.box()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
      });

      it('asks nothing when it opened filled in and nothing was changed', async () => {
        const { onClose } = open({ presetMode: 'existing-folder', presetFolder: '/fake/work/notes', presetName: 'notes' });
        await settle();

        ui.escape();

        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    describe('while it creates', () => {
      function holdFolder() {
        let made!: () => void;
        vi.mocked(mkdir).mockImplementationOnce((path) => {
          h.log.push(`mkdir ${String(path)}`);
          return new Promise<void>((resolve) => { made = resolve; });
        });
        return () => act(async () => { made(); });
      }

      it('creates once when Create is pressed twice, and shows the button as busy', async () => {
        const folderMade = holdFolder();
        const { onClose } = await openScratch();
        ui.type(ui.name(), 'Demo');

        fireEvent.click(ui.create());
        fireEvent.click(ui.create());
        await settle();

        expect(ui.create()).toHaveAttribute('aria-disabled', 'true');
        expect(ui.create()).not.toBeDisabled();
        expect(h.log).toEqual([`mkdir ${PROJECTS}/Demo`]);

        await folderMade();
        await settle();
        expect(h.log.filter((entry) => entry.startsWith('createProject'))).toHaveLength(1);
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('can create again after a failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.mocked(mkdir).mockRejectedValueOnce(new Error('made-up refusal'));
        await openScratch();
        ui.type(ui.name(), 'Demo');
        fireEvent.click(ui.create());
        await settle();
        expect(ui.create()).not.toHaveAttribute('aria-disabled');

        fireEvent.click(ui.create());
        await settle();

        expect(h.log.filter((entry) => entry.startsWith('createProject'))).toHaveLength(1);
      });
    });

    describe('while it fades out', () => {
      it('creates nothing when Create is pressed', async () => {
        keepClosingLayersOnScreen();
        const { onClose, close } = await openScratch();
        ui.type(ui.name(), 'Demo');
        close();
        expect(closingWindow()).toHaveTextContent(t().project.createTitle);
        expect(ui.name().value).toBe('Demo');

        fireEvent.click(ui.create());
        await settle();

        expect(h.log).toEqual([]);
        expect(onClose).not.toHaveBeenCalled();
      });
    });

    describe('when an approval arrives', () => {
      const onAnswer = vi.fn();
      function Host({ approval, onClosed }: { approval: boolean; onClosed: () => void }) {
        const [isOpen, setOpen] = useState(true);
        return (
          <>
            <CreateProjectDialog open={isOpen} onClose={() => { onClosed(); setOpen(false); }} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
      }
      async function besideApproval() {
        onAnswer.mockReset();
        const onClosed = vi.fn(() => { h.log.push('onClose'); });
        const view = render(<Host approval={false} onClosed={onClosed} />);
        await settle();
        fireEvent.click(ui.scratchCard());
        return {
          onClosed,
          arrive: () => view.rerender(<Host approval onClosed={onClosed} />),
          leave: () => view.rerender(<Host approval={false} onClosed={onClosed} />),
        };
      }
      const approval = () => windowBox(APPROVAL_TITLE);
      const own = () => windowBox(t().project.createTitle);

      it('asks about the typed name; the approval waits off the page, unanswered, and keeping on keeps the name', async () => {
        const { onClosed, arrive } = await besideApproval();
        ui.type(ui.name(), 'Demo');

        arrive();
        expect(discardQuestion.box()).not.toBeNull();
        expect(approval()).toBeNull();
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();

        discardQuestion.keepEditing();
        expect(approval()).toBeNull();
        expect(ui.name().value).toBe('Demo');
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.log).toEqual([]);
      });

      it('shows the approval once the typed name is discarded', async () => {
        const { onClosed, arrive } = await besideApproval();
        ui.type(ui.name(), 'Demo');
        arrive();

        discardQuestion.discard();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(approval()).not.toBeNull();
        expect(approval()).not.toHaveAttribute('hidden');
        expect(onAnswer).not.toHaveBeenCalled();
      });

      it('is closed for the approval when nothing was typed', async () => {
        const { onClosed, arrive } = await besideApproval();

        arrive();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
      });

      it('steps aside while the folder is being made, unasked and unclosed, and the project is created meanwhile', async () => {
        let folderMade!: () => void;
        vi.mocked(mkdir).mockImplementationOnce((path) => {
          h.log.push(`mkdir ${String(path)}`);
          return new Promise<void>((resolve) => { folderMade = resolve; });
        });
        const { onClosed, arrive, leave } = await besideApproval();
        ui.type(ui.name(), 'Demo');
        fireEvent.click(ui.create());
        await settle();
        const window = own();

        arrive();
        expect(approval()).not.toBeNull();
        expect(own()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expect(discardQuestion.box()).toBeNull();
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();

        await act(async () => { folderMade(); });
        await settle();
        expect(h.log).toEqual([
          `mkdir ${PROJECTS}/Demo`,
          `createProject ${JSON.stringify({ name: 'Demo', workspacePath: `${PROJECTS}/Demo` })}`,
          'startNewConversation',
          `setWorkspace ${PROJECTS}/Demo`,
          'setViewMode chat',
          'setFileTreeMode true',
          'onClose',
        ]);
        expect(onAnswer).not.toHaveBeenCalled();
        expect(approval()).not.toBeNull();

        // The window closed itself while it stood aside: it does not come back.
        leave();
        expect(own()).toBeNull();
        expect(onClosed).toHaveBeenCalledTimes(1);
      });

      it('returns with the name still creating when the approval leaves first', async () => {
        let folderMade!: () => void;
        vi.mocked(mkdir).mockImplementationOnce((path) => {
          h.log.push(`mkdir ${String(path)}`);
          return new Promise<void>((resolve) => { folderMade = resolve; });
        });
        const { onClosed, arrive, leave } = await besideApproval();
        ui.type(ui.name(), 'Demo');
        fireEvent.click(ui.create());
        await settle();
        const window = own();
        arrive();

        leave();
        expect(own()).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(ui.name().value).toBe('Demo');
        expect(ui.create()).toHaveAttribute('aria-disabled', 'true');
        expect(onClosed).not.toHaveBeenCalled();

        await act(async () => { folderMade(); });
        await settle();
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(h.log.filter((entry) => entry.startsWith('mkdir'))).toHaveLength(1);
      });

      it('gives Escape to the question alone', async () => {
        const { onClosed, arrive } = await besideApproval();
        ui.type(ui.name(), 'Demo');
        arrive();

        ui.escape();

        expect(discardQuestion.box()).toBeNull();
        expect(own()).not.toBeNull();
        expect(approval()).toBeNull();
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
      });
    });
  });
});
