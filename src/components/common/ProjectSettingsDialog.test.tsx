// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { APPROVAL_TITLE, approvalProbe, closingWindow, discardQuestion, finishClosing, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { projectCreateProps, projectRowProps } from '@/components/sidebar/projectRowFocus';
import { format, getI18n, initLanguage } from '@/i18n';
import type { Project } from '@/types/project';
import ProjectSettingsDialog from './ProjectSettingsDialog';

// Everything the window does, in the order it does it.
const h = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('@/stores/projectStore', async () => {
  const { create } = await import('zustand');
  const useProjectStore = create<{
    projects: Record<string, Project>;
    updateProject: (id: string, data: Partial<Project>) => void;
    archiveProject: (id: string) => void;
  }>()((set) => ({
    projects: {},
    updateProject: (id, data) => {
      h.log.push(`updateProject ${id} ${JSON.stringify(data, (_key, value: unknown) => (value === undefined ? '<undefined>' : value))}`);
      set((state) => ({ projects: { ...state.projects, [id]: { ...state.projects[id], ...data } } }));
    },
    archiveProject: (id) => {
      h.log.push(`archiveProject ${id}`);
      set((state) => ({ projects: { ...state.projects, [id]: { ...state.projects[id], archived: true } } }));
    },
  }));
  return { useProjectStore };
});
vi.mock('@/stores/chatStore', async () => {
  const { create } = await import('zustand');
  return { useChatStore: create(() => ({ conversationIndex: {} as Record<string, { id: string; projectId?: string }> })) };
});
vi.mock('@/stores/settingsStore', async () => {
  const { create } = await import('zustand');
  return {
    useSettingsStore: create(() => ({
      providers: [] as Array<{ id: string; name: string; enabled: boolean; models: Array<{ id: string; label?: string }> }>,
    })),
  };
});
vi.mock('@/stores/discoveryStore', async () => {
  const { create } = await import('zustand');
  return { useDiscoveryStore: create(() => ({ skills: [] as Array<{ name: string }> })) };
});
vi.mock('@/stores/mcpStore', async () => {
  const { create } = await import('zustand');
  return { useMCPStore: create(() => ({ servers: {} as Record<string, object> })) };
});

import { useChatStore as chatStore } from '@/stores/chatStore';
import { useDiscoveryStore as discoveryStore } from '@/stores/discoveryStore';
import { useMCPStore as mcpStore } from '@/stores/mcpStore';
import { useProjectStore as projectStore } from '@/stores/projectStore';
import { useSettingsStore as settingsStore } from '@/stores/settingsStore';

// The stores above are the stand-ins: each holds only what the window reads.
interface StandIn { setState: (state: Record<string, unknown>) => void }
const useChatStore = chatStore as unknown as StandIn;
const useDiscoveryStore = discoveryStore as unknown as StandIn;
const useMCPStore = mcpStore as unknown as StandIn;
const useProjectStore = projectStore as unknown as StandIn;
const useSettingsStore = settingsStore as unknown as StandIn;

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Reports',
  workspacePath: '/fake/work/reports',
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastActiveAt: 1,
  ...over,
});
const seed = (...projects: Project[]) => useProjectStore.setState({ projects: Object.fromEntries(projects.map((p) => [p.id, p])) });
const saved = (id: string, data: Record<string, unknown>) => `updateProject ${id} ${JSON.stringify(data, (_key, value: unknown) => (value === undefined ? '<undefined>' : value))}`;

const ui = {
  name: () => screen.getByPlaceholderText<HTMLInputElement>(t().project.namePlaceholder),
  description: () => screen.getByPlaceholderText<HTMLInputElement>(t().project.descPlaceholder),
  save: () => screen.getByRole('button', { name: t().project.save }),
  // The window's own Cancel is the first; a question over it has its own.
  cancel: () => screen.getAllByRole('button', { name: t().project.cancel })[0],
  archive: () => screen.getByRole('button', { name: t().project.archiveProject }),
  confirmArchive: () => screen.getByRole('button', { name: t().project.archive }),
  cancelQuestion: () => screen.getAllByRole('button', { name: t().project.cancel }).at(-1)!,
  type: (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } }),
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
  skills: () => screen.getByRole('combobox', { name: t().project.defaultSkillsLabel }),
  connectors: () => screen.getByRole('combobox', { name: t().project.defaultMCPLabel }),
  model: () => screen.getByRole('combobox', { name: t().project.modelOverrideLabel }),
  icon: () => screen.getByRole('button', { name: t().project.iconLabel }),
  iconPanel: () => screen.queryByRole('dialog', { name: t().project.iconLabel }),
  openList: (field: HTMLElement) => fireEvent.click(field),
  toggle: (option: string) => fireEvent.click(screen.getByRole('option', { name: option })),
  pickIcon: (next: string) => {
    fireEvent.click(ui.icon());
    fireEvent.click(within(ui.iconPanel()!).getByRole('button', { name: next }));
  },
  window: () => screen.getByRole('dialog', { name: t().project.settingsTitle }),
};

// Lets the answer to a question reach the handler that asked it.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function open(projectId: string | null = 'p1') {
  const onClose = vi.fn(() => { h.log.push('onClose'); });
  const view = render(<ProjectSettingsDialog open={projectId !== null} onClose={onClose} projectId={projectId} />);
  return { onClose, view };
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
  useSettingsStore.setState({ providers: [] });
  useDiscoveryStore.setState({ skills: [] });
  useMCPStore.setState({ servers: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProjectSettingsDialog', () => {
  describe('what it shows', () => {
    it('fills the form from the project', () => {
      seed(project({ description: 'Weekly numbers', icon: '🚀' }));
      useChatStore.setState({ conversationIndex: { c1: { id: 'c1', projectId: 'p1' }, c2: { id: 'c2', projectId: 'p1' }, c3: { id: 'c3', projectId: 'p2' } } });
      open();

      expect(screen.getByText(t().project.settingsTitle)).toBeInTheDocument();
      expect(ui.name().value).toBe('Reports');
      expect(ui.description().value).toBe('Weekly numbers');
      expect(screen.getByText('🚀')).toBeInTheDocument();
      expect(screen.getByText('/fake/work/reports')).toBeInTheDocument();
      expect(screen.getByText(format(t().project.conversationCount, { count: '2' }))).toBeInTheDocument();
    });

    it('shows nothing without a project', () => {
      seed(project());
      open(null);
      expect(screen.queryByText(t().project.settingsTitle)).not.toBeInTheDocument();
    });

    it('shows nothing for a project that is not in the store', () => {
      const onClose = vi.fn();
      render(<ProjectSettingsDialog open onClose={onClose} projectId="gone" />);
      expect(screen.queryByText(t().project.settingsTitle)).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('saving', () => {
    it('saves the trimmed name, leaves every empty value undefined, then closes', () => {
      seed(project());
      const { onClose } = open();
      ui.type(ui.name(), '  Numbers  ');

      fireEvent.click(ui.save());

      expect(h.log).toEqual([
        saved('p1', { name: 'Numbers', description: undefined, icon: undefined, modelOverride: undefined, defaultSkills: undefined, defaultMCPServers: undefined }),
        'onClose',
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('saves what the project already held, unchanged and in the same order', () => {
      seed(project({ description: 'Weekly numbers', icon: '🚀', modelOverride: 'model-a', defaultSkills: ['writer', 'analyst'], defaultMCPServers: ['files', 'search'] }));
      useSettingsStore.setState({ providers: [{ id: 'one', name: 'One', enabled: true, models: [{ id: 'model-a', label: 'Model A' }] }] });
      useDiscoveryStore.setState({ skills: [{ name: 'analyst' }, { name: 'writer' }] });
      useMCPStore.setState({ servers: { search: {}, files: {} } });
      open();

      fireEvent.click(ui.save());

      expect(h.log[0]).toBe(saved('p1', {
        name: 'Reports', description: 'Weekly numbers', icon: '🚀', modelOverride: 'model-a', defaultSkills: ['writer', 'analyst'], defaultMCPServers: ['files', 'search'],
      }));
    });

    it('saves a description without the spaces around it', () => {
      seed(project());
      open();
      ui.type(ui.description(), '  Weekly numbers  ');

      fireEvent.click(ui.save());

      expect(h.log[0]).toContain('"description":"Weekly numbers"');
    });

    it('cannot save without a name', () => {
      seed(project());
      open();

      ui.type(ui.name(), '   ');

      expect(ui.save()).toBeDisabled();
      fireEvent.click(ui.save());
      expect(h.log).toEqual([]);
    });

    it('saves a picked icon', () => {
      seed(project());
      open();

      ui.pickIcon('🎯');
      fireEvent.click(ui.save());

      expect(h.log[0]).toContain('"icon":"🎯"');
    });

    it('adds a default skill after the ones chosen before, and takes one away', () => {
      seed(project({ defaultSkills: ['writer'] }));
      useDiscoveryStore.setState({ skills: [{ name: 'analyst' }, { name: 'writer' }, { name: 'planner' }] });
      open();

      ui.openList(ui.skills());
      ui.toggle('analyst');
      fireEvent.click(ui.save());
      expect(h.log[0]).toContain('"defaultSkills":["writer","analyst"]');
    });

    it('saves no default skills once the last one is taken away', () => {
      seed(project({ defaultSkills: ['writer'] }));
      useDiscoveryStore.setState({ skills: [{ name: 'analyst' }, { name: 'writer' }] });
      open();

      ui.openList(ui.skills());
      ui.toggle('writer');
      fireEvent.click(ui.save());

      expect(h.log[0]).toContain('"defaultSkills":"<undefined>"');
    });

    it('adds a default connector', () => {
      seed(project());
      useMCPStore.setState({ servers: { files: {}, search: {} } });
      open();

      ui.openList(ui.connectors());
      ui.toggle('search');
      ui.toggle('files');
      fireEvent.click(ui.save());

      expect(h.log[0]).toContain('"defaultMCPServers":["search","files"]');
    });
  });

  describe('archiving', () => {
    it('asks first, naming the project, and archives on the answer', async () => {
      seed(project());
      const { onClose } = open();

      fireEvent.click(ui.archive());
      expect(h.log).toEqual([]);
      expect(screen.getByText(format(t().project.archiveConfirm, { name: 'Reports' }))).toBeInTheDocument();

      fireEvent.click(ui.confirmArchive());
      await settle();

      expect(h.log).toEqual(['archiveProject p1', 'onClose']);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('archives nothing when the question is cancelled, and stays open', async () => {
      seed(project());
      const { onClose } = open();
      fireEvent.click(ui.archive());

      fireEvent.click(ui.cancelQuestion());
      await settle();

      expect(h.log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText(format(t().project.archiveConfirm, { name: 'Reports' }))).not.toBeInTheDocument();
      expect(ui.name().value).toBe('Reports');
    });
  });

  describe('closing', () => {
    it('closes on Escape when nothing was changed', () => {
      seed(project());
      const { onClose } = open();

      ui.escape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(h.log).toEqual(['onClose']);
    });

    it('closes on Cancel without saving', () => {
      seed(project());
      const { onClose } = open();

      fireEvent.click(ui.cancel());

      expect(h.log).toEqual(['onClose']);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('as a design-system window', () => {
    const providers = [
      { id: 'one', name: 'One', enabled: true, models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b' }] },
      { id: 'off', name: 'Off', enabled: false, models: [{ id: 'model-off', label: 'Model Off' }] },
    ];

    it('is a dialog named by its title, with the project folder and its group titles', () => {
      seed(project());
      open();

      const window = ui.window();
      expect(window).toHaveTextContent('/fake/work/reports');
      expect(within(window).getByRole('heading', { name: t().project.defaultsSection })).toHaveClass('text-label-tertiary');
      expect(within(window).getByRole('heading', { name: t().project.dangerZone })).toHaveClass('text-danger');
      expect(screen.getByRole('button', { name: t().common.close })).toBeInTheDocument();
    });

    describe('the icon', () => {
      it('opens a panel named 图标 with the sixteen icons, and a pick closes it', () => {
        seed(project());
        open();

        fireEvent.click(ui.icon());
        const panel = ui.iconPanel()!;
        expect(within(panel).getAllByRole('button')).toHaveLength(16);

        fireEvent.click(within(panel).getByRole('button', { name: '🧪' }));
        expect(ui.iconPanel()).not.toBeInTheDocument();
        expect(ui.icon()).toHaveTextContent('🧪');
      });

      // Each cell is its own button, named by its own icon: a press on one picks that one.
      it('names every cell by the icon it shows, and a press on a cell picks that icon', () => {
        seed(project());
        open();
        fireEvent.click(ui.icon());
        const cells = within(ui.iconPanel()!).getAllByRole('button').map((cell) => ({ name: cell.getAttribute('aria-label'), shows: cell.textContent }));
        ui.escape();

        expect(cells.every((cell) => cell.name !== null && cell.name === cell.shows)).toBe(true);
        expect(new Set(cells.map((cell) => cell.name)).size).toBe(16);
        for (const cell of cells) {
          ui.pickIcon(cell.name!);
          expect(ui.icon()).toHaveTextContent(cell.name!);
        }
      });

      it('offers to take the icon away only when one is set, and saves none then', () => {
        seed(project({ icon: '🚀' }));
        open();

        fireEvent.click(ui.icon());
        fireEvent.click(within(ui.iconPanel()!).getByRole('button', { name: t().project.delete }));
        expect(ui.iconPanel()).not.toBeInTheDocument();
        expect(ui.icon()).toHaveTextContent('📁');

        fireEvent.click(ui.icon());
        expect(within(ui.iconPanel()!).queryByRole('button', { name: t().project.delete })).not.toBeInTheDocument();
        ui.escape();
        fireEvent.click(ui.save());
        expect(h.log[0]).toContain('"icon":"<undefined>"');
      });

      it('gives Escape to the panel alone', () => {
        seed(project());
        const { onClose } = open();
        fireEvent.click(ui.icon());

        ui.escape();

        expect(ui.iconPanel()).not.toBeInTheDocument();
        expect(ui.window()).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
      });
    });

    describe('the model', () => {
      it('lists the models of the services that are on, after the choice to follow the global setting', async () => {
        const user = userEvent.setup();
        seed(project());
        useSettingsStore.setState({ providers });
        open();

        await user.click(ui.model());

        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
          t().project.modelOverrideNone, 'Model A (One)', 'model-b (One)',
        ]);
      });

      it('saves the model that was picked', async () => {
        const user = userEvent.setup();
        seed(project());
        useSettingsStore.setState({ providers });
        open();

        await user.click(ui.model());
        await user.click(screen.getByRole('option', { name: 'model-b (One)' }));
        fireEvent.click(ui.save());

        expect(h.log[0]).toContain('"modelOverride":"model-b"');
      });

      it('saves no model when the choice goes back to the global setting', async () => {
        const user = userEvent.setup();
        seed(project({ modelOverride: 'model-a' }));
        useSettingsStore.setState({ providers });
        open();
        expect(ui.model()).toHaveTextContent('Model A (One)');

        await user.click(ui.model());
        await user.click(screen.getByRole('option', { name: t().project.modelOverrideNone }));
        fireEvent.click(ui.save());

        expect(h.log[0]).toContain('"modelOverride":"<undefined>"');
      });

      it('lists a model once when two services offer it', async () => {
        const user = userEvent.setup();
        seed(project());
        useSettingsStore.setState({ providers: [providers[0], { id: 'two', name: 'Two', enabled: true, models: [{ id: 'model-a', label: 'Model A' }] }] });
        open();

        await user.click(ui.model());

        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
          t().project.modelOverrideNone, 'Model A (One)', 'model-b (One)',
        ]);
      });
    });

    describe('the default skills and connectors', () => {
      it('shows what is chosen, in the order it was chosen', () => {
        seed(project({ defaultSkills: ['writer', 'analyst'] }));
        useDiscoveryStore.setState({ skills: [{ name: 'analyst' }, { name: 'writer' }] });
        open();

        expect(ui.skills()).toHaveTextContent('writer、analyst');
        expect(ui.connectors()).toHaveTextContent(t().project.defaultMCPPlaceholder);
      });

      it('marks the chosen ones in the list and keeps the list open after a pick', () => {
        seed(project({ defaultSkills: ['writer'] }));
        useDiscoveryStore.setState({ skills: [{ name: 'analyst' }, { name: 'writer' }] });
        open();

        ui.openList(ui.skills());
        expect(screen.getByRole('option', { name: 'writer' })).toHaveAttribute('aria-checked', 'true');
        ui.toggle('analyst');

        expect(screen.getByRole('option', { name: 'analyst' })).toHaveAttribute('aria-checked', 'true');
      });

      // A skill that was removed since it was chosen: it still shows and can be taken away.
      it('keeps a chosen skill that no longer exists, shown and removable', () => {
        seed(project({ defaultSkills: ['retired', 'writer'] }));
        useDiscoveryStore.setState({ skills: [{ name: 'writer' }] });
        open();
        expect(ui.skills()).toHaveTextContent('retired、writer');

        fireEvent.click(ui.save());
        expect(h.log[0]).toContain('"defaultSkills":["retired","writer"]');

        h.log.length = 0;
        cleanup();
        seed(project({ defaultSkills: ['retired', 'writer'] }));
        open();
        ui.openList(ui.skills());
        ui.toggle('retired');
        ui.escape();
        fireEvent.click(ui.save());
        expect(h.log[0]).toContain('"defaultSkills":["writer"]');
      });

      it('gives Escape to the open list alone', () => {
        seed(project());
        useDiscoveryStore.setState({ skills: [{ name: 'writer' }] });
        const { onClose } = open();
        ui.openList(ui.skills());

        ui.escape();

        expect(screen.queryByRole('option')).not.toBeInTheDocument();
        expect(ui.window()).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
      });
    });

    describe('the form and the project in the store', () => {
      it('keeps what was typed when the project changes meanwhile', () => {
        seed(project());
        open();
        ui.type(ui.name(), 'Numbers');

        act(() => { seed(project({ lastActiveAt: 99, description: 'changed elsewhere' })); });

        expect(ui.name().value).toBe('Numbers');
        expect(ui.description().value).toBe('');
      });

      it('fills from the other project when it is opened for one', () => {
        seed(project(), project({ id: 'p2', name: 'Travel', workspacePath: '/fake/work/travel' }));
        const onClose = vi.fn();
        const view = render(<ProjectSettingsDialog open onClose={onClose} projectId="p1" />);
        ui.type(ui.name(), 'Numbers');

        view.rerender(<ProjectSettingsDialog open={false} onClose={onClose} projectId={null} />);
        view.rerender(<ProjectSettingsDialog open onClose={onClose} projectId="p2" />);

        expect(ui.name().value).toBe('Travel');
      });
    });

    describe('with something changed', () => {
      it('asks before it closes on Escape; keeping on leaves the change, discarding closes without saving', () => {
        seed(project());
        const { onClose } = open();
        ui.type(ui.description(), 'Weekly numbers');

        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        discardQuestion.keepEditing();
        expect(ui.description().value).toBe('Weekly numbers');

        ui.escape();
        discardQuestion.discard();
        expect(h.log).toEqual(['onClose']);
      });

      it('asks after an icon, a skill or a model was picked', async () => {
        const user = userEvent.setup();
        useSettingsStore.setState({ providers });
        useDiscoveryStore.setState({ skills: [{ name: 'writer' }] });
        for (const change of [
          () => ui.pickIcon('🎯'),
          () => { ui.openList(ui.skills()); ui.toggle('writer'); ui.escape(); },
          async () => { await user.click(ui.model()); await user.click(screen.getByRole('option', { name: 'model-b (One)' })); },
        ]) {
          seed(project());
          open();
          await change();
          ui.escape();
          expect(discardQuestion.box()).not.toBeNull();
          cleanup();
        }
      });

      it('asks nothing once the change is taken back', () => {
        seed(project());
        const { onClose } = open();
        ui.type(ui.name(), 'Numbers');
        ui.type(ui.name(), 'Reports');

        ui.escape();

        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('saves without asking', () => {
        seed(project());
        const { onClose } = open();
        ui.type(ui.name(), 'Numbers');

        fireEvent.click(ui.save());

        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    describe('the archive question', () => {
      it('is an alert dialog with the project name, whose answer button says what it does', () => {
        seed(project());
        open();

        fireEvent.click(ui.archive());

        const question = screen.getByRole('alertdialog', { name: t().project.archiveProject });
        expect(question).toHaveTextContent(format(t().project.archiveConfirm, { name: 'Reports' }));
        expect(within(question).getByRole('button', { name: t().project.archive })).toBeInTheDocument();
      });

      it('names the project as the store holds it, not as the form shows it', () => {
        seed(project());
        open();
        ui.type(ui.name(), 'Typed but not saved');

        fireEvent.click(ui.archive());

        expect(screen.getByRole('alertdialog')).toHaveTextContent(format(t().project.archiveConfirm, { name: 'Reports' }));
      });

      it('archives nothing when the project is gone by the time of the answer', async () => {
        seed(project());
        const { onClose } = open();
        fireEvent.click(ui.archive());

        act(() => { useProjectStore.setState({ projects: {} }); });
        await settle();

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(h.log).toEqual([]);
        expect(onClose).not.toHaveBeenCalled();
      });

      it('archives without asking about what was typed', async () => {
        seed(project());
        const { onClose } = open();
        ui.type(ui.name(), 'Typed but not saved');
        fireEvent.click(ui.archive());

        fireEvent.click(ui.confirmArchive());
        await settle();

        expect(h.log).toEqual(['archiveProject p1', 'onClose']);
        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    // The row that opened the window leaves the list with its project.
    describe('where the focus goes once it has closed', () => {
      function Owner() {
        const projects = projectStore((s) => s.projects);
        const [projectId, setProjectId] = useState<string | null>(null);
        return (
          <>
            <Button {...projectCreateProps}>Create a project</Button>
            {Object.values(projects).filter((p) => !p.archived).map((p) => (
              <Button key={p.id} {...projectRowProps(p.id)} onClick={() => setProjectId(p.id)}>{p.name}</Button>
            ))}
            <ProjectSettingsDialog open={projectId !== null} onClose={() => setProjectId(null)} projectId={projectId} />
          </>
        );
      }
      const pageButton = (name: string) => screen.getByRole('button', { name });
      function openFrom(name: string) {
        keepClosingLayersOnScreen();
        render(<Owner />);
        pageButton(name).focus();
        fireEvent.click(pageButton(name));
      }
      async function archiveIt() {
        fireEvent.click(ui.archive());
        fireEvent.click(ui.confirmArchive());
        await settle();
        finishClosing();
      }
      const travel = project({ id: 'p2', name: 'Travel', workspacePath: '/fake/work/travel' });
      const garden = project({ id: 'p0', name: 'Garden', workspacePath: '/fake/work/garden' });

      it('goes to the row that took the place of the archived project', async () => {
        seed(garden, project(), travel);
        openFrom('Reports');

        await archiveIt();

        expect(screen.queryByRole('button', { name: 'Reports' })).not.toBeInTheDocument();
        expect(pageButton('Travel')).toHaveFocus();
      });

      it('goes to the row before it when the archived project was the last', async () => {
        seed(garden, project());
        openFrom('Reports');

        await archiveIt();

        expect(pageButton('Garden')).toHaveFocus();
      });

      it('goes to the create button when no project is left', async () => {
        seed(project());
        openFrom('Reports');

        await archiveIt();

        expect(pageButton('Create a project')).toHaveFocus();
      });

      it('returns to the row that opened it when nothing was archived', () => {
        seed(garden, project(), travel);
        openFrom('Reports');

        ui.escape();
        finishClosing();

        expect(pageButton('Reports')).toHaveFocus();
      });

      it('returns to its own row the next time, after an archive in an earlier opening', async () => {
        seed(garden, project(), travel);
        openFrom('Reports');
        await archiveIt();

        pageButton('Garden').focus();
        fireEvent.click(pageButton('Garden'));
        ui.escape();
        finishClosing();

        expect(pageButton('Garden')).toHaveFocus();
      });
    });

    describe('while it fades out', () => {
      function closing() {
        keepClosingLayersOnScreen();
        seed(project());
        const onClose = vi.fn(() => { h.log.push('onClose'); });
        const view = render(<ProjectSettingsDialog open onClose={onClose} projectId="p1" />);
        ui.type(ui.name(), 'Numbers');
        // Its owner drops the project together with the window.
        view.rerender(<ProjectSettingsDialog open={false} onClose={onClose} projectId={null} />);
        return { onClose };
      }

      it('keeps showing the project and what was typed', () => {
        closing();
        expect(closingWindow()).toHaveTextContent(t().project.settingsTitle);
        expect(closingWindow()).toHaveTextContent('/fake/work/reports');
        expect(ui.name().value).toBe('Numbers');
      });

      it('saves nothing when Save is pressed', () => {
        const { onClose } = closing();

        fireEvent.click(screen.getByRole('button', { name: t().project.save, hidden: true }));

        expect(h.log).toEqual([]);
        expect(onClose).not.toHaveBeenCalled();
      });

      it('asks nothing when Archive is pressed', async () => {
        closing();

        fireEvent.click(screen.getByRole('button', { name: t().project.archiveProject, hidden: true }));
        await settle();

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(h.log).toEqual([]);
      });
    });

    describe('when an approval arrives', () => {
      const onAnswer = vi.fn();
      function Host({ approval, onClosed }: { approval: boolean; onClosed: () => void }) {
        const [projectId, setProjectId] = useState<string | null>('p1');
        return (
          <>
            <ProjectSettingsDialog open={projectId !== null} onClose={() => { onClosed(); setProjectId(null); }} projectId={projectId} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
      }
      function besideApproval() {
        onAnswer.mockReset();
        seed(project());
        const onClosed = vi.fn(() => { h.log.push('onClose'); });
        const view = render(<Host approval={false} onClosed={onClosed} />);
        return { onClosed, arrive: () => view.rerender(<Host approval onClosed={onClosed} />) };
      }
      const approval = () => windowBox(APPROVAL_TITLE);

      it('asks about the change; the approval waits off the page, unanswered, and keeping on keeps the change', () => {
        const { onClosed, arrive } = besideApproval();
        ui.type(ui.name(), 'Numbers');

        arrive();
        expect(discardQuestion.box()).not.toBeNull();
        expect(approval()).toBeNull();

        discardQuestion.keepEditing();
        expect(approval()).toBeNull();
        expect(ui.name().value).toBe('Numbers');
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.log).toEqual([]);
      });

      it('is closed for the approval when nothing was changed, and saves nothing', () => {
        const { onClosed, arrive } = besideApproval();

        arrive();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(windowBox(t().project.settingsTitle)).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.log).toEqual(['onClose']);
      });

      it('is closed together with its archive question, which archives nothing', async () => {
        const { onClosed, arrive } = besideApproval();
        fireEvent.click(ui.archive());

        arrive();
        await settle();

        expect(approval()).not.toBeNull();
        expect(windowBox(t().project.archiveProject)).toBeNull();
        expect(h.log).toEqual(['onClose']);
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(onAnswer).not.toHaveBeenCalled();
      });

      it('keeps the archive question waiting with the window when something was changed, and archives nothing', async () => {
        const { onClosed, arrive } = besideApproval();
        ui.type(ui.name(), 'Numbers');
        fireEvent.click(ui.archive());

        arrive();
        await settle();

        expect(approval()).toBeNull();
        expect(h.log).toEqual([]);
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
      });
    });
  });
});
