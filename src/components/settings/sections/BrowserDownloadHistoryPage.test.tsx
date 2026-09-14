// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationMeta } from '@/core/session/conversationStorage';
import type { BrowserRunReportArtifact, BrowserRunReportSnapshot } from '@/core/observability/browserRunReport';
import type { Message } from '@/types';
import CapabilitiesSection from './CapabilitiesSection';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useMCPStore } from '@/stores/mcpStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';

const originalSwitchConversation = useChatStore.getState().switchConversation;

const loadMessagesMock = vi.hoisted(() => vi.fn());
vi.mock('@/core/session/conversationStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/session/conversationStorage')>(),
  loadMessages: (...args: unknown[]) => loadMessagesMock(...args),
}));

const existsMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (...args: unknown[]) => existsMock(...args),
}));

const revealItemInDirMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (...args: unknown[]) => revealItemInDirMock(...args),
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('@/utils/platform', () => ({ isMacOS: () => false }));

const mcpManagerMock = vi.hoisted(() => ({
  callTool: vi.fn(),
  disconnectServer: vi.fn(),
  isConnected: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));
vi.mock('@/core/mcp/client', () => ({ mcpManager: mcpManagerMock }));

vi.mock('@/core/agent/mcpDiscovery', () => ({
  ensureMCPServer: vi.fn(),
  resolveMCPCompanionResource: vi.fn(),
}));

function meta(
  id: string,
  title = id,
  patch: Partial<ConversationMeta> = {},
): ConversationMeta {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
    ...patch,
  };
}

function report(artifacts: BrowserRunReportArtifact[], omitted = 0): BrowserRunReportSnapshot {
  return {
    v: 1,
    variant: 'downloads',
    outcome: 'completed',
    actions: { total: 0, failed: 0 },
    scriptRuns: 0,
    sites: [],
    denials: [],
    problems: [],
    approvals: { approved: 0, declined: 0, timedOut: 0, unreachable: 0 },
    blockedPages: 0,
    skippedByMasterSwitch: false,
    nextSteps: [],
    artifacts,
    omitted: { sites: 0, problems: 0, artifacts: omitted },
  };
}

function artifact(downloadId: string, path: string, name: string): BrowserRunReportArtifact {
  return { downloadId, path, name, bytes: 42 };
}

function messagesFor(
  id: string,
  artifacts: BrowserRunReportArtifact[],
  options: {
    omitted?: number;
    toolName?: 'abu-browser__download' | 'abu-browser__get_downloads' | 'abu-browser-bridge__download';
    sourceUrl?: string;
    time?: number;
  } = {},
): Message[] {
  const records = artifacts.map((item, index) => ({
    downloadId: item.downloadId,
    filename: item.name,
    path: item.path,
    state: 'completed',
    time: options.time ?? 1_757_000_000_000 + index,
    url: options.sourceUrl ?? `https://files.example/${item.name}?token=private#fragment`,
  }));
  const toolName = options.toolName ?? 'abu-browser__get_downloads';
  const result = toolName.endsWith('__download')
    ? { complete: true, download: records[0] }
    : records;
  return [
    {
      id: `tool-${id}`,
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{
        id: `call-${id}`,
        name: toolName,
        input: {},
        result: JSON.stringify(result),
      }],
    },
    {
      id: `browser-run-report-${id}`,
      role: 'system',
      content: '',
      timestamp: 2,
      browserRunReport: report(artifacts, options.omitted ?? 0),
    },
  ];
}

async function openDownloadHistory() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Abu built-in browser/ }));
  await user.click(screen.getByRole('button', { name: 'Download history' }));
  await screen.findByRole('heading', { name: 'Download history' });
  return user;
}

function rowFor(filename: string): HTMLElement {
  const name = screen.getAllByText(filename).find((element) => element.closest('li'));
  const row = name?.closest('li');
  if (!row) throw new Error(`No download row for ${filename}`);
  return row;
}

beforeEach(() => {
  initLanguage('en-US');
  loadMessagesMock.mockReset();
  existsMock.mockReset();
  existsMock.mockResolvedValue(true);
  revealItemInDirMock.mockReset();
  invoke.mockReset();
  mcpManagerMock.subscribe.mockClear();
  useChatStore.setState({
    conversationIndex: {},
    conversations: {},
    activeConversationId: null,
    switchConversation: originalSwitchConversation,
  });
  useMCPStore.setState({ servers: {} });
  usePreviewStore.setState({
    tabs: [],
    activeTabId: null,
    previewFilePath: null,
  });
  useSettingsStore.setState({
    systemSettingsOpen: true,
    activeSystemTab: 'capabilities',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('browser download history through CapabilitiesSection', () => {
  it('loads beyond the conversation LRU, keeps task ownership, excludes Chrome/imported, and searches filenames', async () => {
    const histories = new Map<string, Message[]>();
    const index: Record<string, ConversationMeta> = {};
    for (let i = 0; i < 7; i++) {
      const id = `task-${i}`;
      index[id] = meta(id, `Task ${i}`, { updatedAt: 100 - i });
      histories.set(id, messagesFor(id, [
        artifact(`dl-${i}`, `/downloads/${id}/shared.csv`, i === 6 ? 'oldest.csv' : 'shared.csv'),
      ]));
    }
    const scopeArtifacts = Array.from({ length: 5 }, (_, index_) => (
      artifact(`scope-${index_}`, `/downloads/scope/file-${index_}.csv`, `file-${index_}.csv`)
    ));
    index.scope = meta('scope', 'Six files task', { updatedAt: 200 });
    histories.set('scope', messagesFor('scope', scopeArtifacts, { omitted: 1 }));
    index.chrome = meta('chrome', 'Chrome task');
    histories.set('chrome', messagesFor('chrome', [
      artifact('chrome', '/downloads/chrome.csv', 'chrome.csv'),
    ], { toolName: 'abu-browser-bridge__download' }));
    index.imported = meta('imported', 'Imported task', {
      readOnly: true,
      importedFrom: { schemaVersion: 1, importedAt: 10 },
    });
    histories.set('imported', messagesFor('imported', [
      artifact('imported', '/downloads/imported.csv', 'imported.csv'),
    ]));

    useChatStore.setState({
      conversationIndex: index,
      // Deliberately keep only one full conversation in memory. The settings
      // page must read the authoritative index + ledgers, not this LRU.
      conversations: {
        'task-0': {
          id: 'task-0',
          title: 'Task 0',
          createdAt: 1,
          updatedAt: 2,
          status: 'completed',
          messages: [],
        },
      },
    });
    loadMessagesMock.mockImplementation(async (id: string) => histories.get(id) ?? []);

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();
    await screen.findByText('oldest.csv');

    expect(screen.getAllByText('shared.csv')).toHaveLength(6);
    expect(screen.queryByText('chrome.csv')).not.toBeInTheDocument();
    expect(screen.queryByText('imported.csv')).not.toBeInTheDocument();
    expect(loadMessagesMock).toHaveBeenCalledWith('task-6');
    expect(loadMessagesMock).not.toHaveBeenCalledWith('imported');
    expect(screen.getByText('Additional downloads for “Six files task”: 1. Their details were not retained.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('token=private');

    const search = screen.getByRole('searchbox', { name: 'Search file names' });
    await user.type(search, 'oldest');
    expect(screen.getByText('oldest.csv')).toBeInTheDocument();
    expect(screen.queryByText('shared.csv')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'missing-name');
    expect(screen.getByText('No files match the current search.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getAllByText('shared.csv')).toHaveLength(6);
  });

  it('shows completed, unavailable, and unknown states and rechecks the exact path before opening', async () => {
    const present = artifact('present', '/downloads/present/report.csv', 'present.csv');
    const moved = artifact('moved', '/downloads/moved/report.csv', 'moved.csv');
    const unknown = artifact('unknown', '/downloads/unknown/report.csv', 'unknown.csv');
    useChatStore.setState({
      conversationIndex: { task: meta('task', 'Download task') },
    });
    loadMessagesMock.mockResolvedValue(messagesFor('task', [present, moved, unknown]));
    const calls = new Map<string, number>();
    existsMock.mockImplementation(async (path: string) => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      if (path === moved.path) return false;
      if (path === unknown.path) throw new Error('host unavailable');
      // The original file is present during page load, then moves before click.
      if (path === present.path) return calls.get(path) === 1;
      return true;
    });

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();
    await waitFor(() => expect(within(rowFor('present.csv')).getByRole('button', { name: 'Open file: present.csv' })).toBeEnabled());
    expect(within(rowFor('moved.csv')).getByText('Original location unavailable')).toBeInTheDocument();
    expect(within(rowFor('unknown.csv')).getByText('Unable to verify')).toBeInTheDocument();

    await user.click(within(rowFor('present.csv')).getByRole('button', {
      name: 'Open file: present.csv',
    }));
    await waitFor(() => expect(
      within(rowFor('present.csv')).getByText('Original location unavailable'),
    ).toBeInTheDocument());
    expect(usePreviewStore.getState().previewFilePath).toBeNull();
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
  });

  it('opens a still-present file in preview and closes Settings so the preview is visible', async () => {
    const saved = artifact('saved', '/downloads/saved/report.csv', 'saved.csv');
    useChatStore.setState({
      conversationIndex: { task: meta('task', 'Download task') },
    });
    loadMessagesMock.mockResolvedValue(messagesFor('task', [saved]));
    existsMock.mockResolvedValue(true);

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();
    await waitFor(() => expect(within(rowFor('saved.csv')).getByRole('button', { name: 'Open file: saved.csv' })).toBeEnabled());
    await user.click(within(rowFor('saved.csv')).getByRole('button', {
      name: 'Open file: saved.csv',
    }));

    await waitFor(() => {
      expect(usePreviewStore.getState().previewFilePath).toBe(saved.path);
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    });
  });

  it('opens the exact owning task and refuses a task deleted after the history loaded', async () => {
    const one = artifact('one', '/downloads/one/shared.csv', 'shared.csv');
    const two = artifact('two', '/downloads/two/shared.csv', 'shared.csv');
    const switchConversation = vi.fn(async () => undefined);
    useChatStore.setState({
      conversationIndex: {
        one: meta('one', 'First owner'),
        two: meta('two', 'Second owner'),
      },
      switchConversation,
    });
    loadMessagesMock.mockImplementation(async (id: string) => (
      id === 'one' ? messagesFor(id, [one], { time: 200 }) : messagesFor(id, [two], { time: 100 })
    ));

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();
    await screen.findAllByText('shared.csv');
    await user.click(screen.getByRole('button', { name: 'Open task: Second owner' }));
    await waitFor(() => expect(switchConversation).toHaveBeenCalledWith('two'));
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);

    useSettingsStore.setState({ systemSettingsOpen: true });
    const currentState = useChatStore.getState();
    vi.spyOn(useChatStore, 'getState').mockReturnValue({
      ...currentState,
      conversationIndex: { one: currentState.conversationIndex.one },
      switchConversation,
    });
    // The row was rendered from an earlier index snapshot. Its action must
    // still consult the authoritative index at click time.
    await user.click(screen.getByRole('button', { name: 'Open task: Second owner' }));
    expect(switchConversation).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('This task no longer exists');
  });

  it('discards a stale full-history read when the index changes', async () => {
    let resolveOld!: (messages: Message[]) => void;
    const oldLoad = new Promise<Message[]>((resolve) => { resolveOld = resolve; });
    const old = artifact('old', '/downloads/old.csv', 'old.csv');
    const fresh = artifact('fresh', '/downloads/fresh.csv', 'fresh.csv');
    useChatStore.setState({ conversationIndex: { old: meta('old', 'Old task') } });
    loadMessagesMock.mockImplementation((id: string) => (
      id === 'old' ? oldLoad : Promise.resolve(messagesFor('fresh', [fresh]))
    ));

    render(<CapabilitiesSection />);
    await openDownloadHistory();
    act(() => {
      useChatStore.setState({ conversationIndex: { fresh: meta('fresh', 'Fresh task') } });
    });
    await screen.findByText('fresh.csv');
    act(() => resolveOld(messagesFor('old', [old])));
    await waitFor(() => expect(screen.queryByText('old.csv')).not.toBeInTheDocument());
    expect(screen.getByText('fresh.csv')).toBeInTheDocument();
  });

  it('does not let a late file check open a preview after leaving the history page', async () => {
    const saved = artifact('saved', '/downloads/saved.csv', 'saved.csv');
    useChatStore.setState({
      conversationIndex: { task: meta('task', 'Task') },
    });
    loadMessagesMock.mockResolvedValue(messagesFor('task', [saved]));
    let resolveRecheck!: (value: boolean) => void;
    const recheck = new Promise<boolean>((resolve) => { resolveRecheck = resolve; });
    let checks = 0;
    existsMock.mockImplementation(() => {
      checks++;
      return checks === 1 ? Promise.resolve(true) : recheck;
    });

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();
    await waitFor(() => expect(within(rowFor('saved.csv')).getByRole('button', { name: 'Open file: saved.csv' })).toBeEnabled());
    await user.click(within(rowFor('saved.csv')).getByRole('button', {
      name: 'Open file: saved.csv',
    }));
    await user.click(screen.getByRole('button', { name: 'Abu built-in browser' }));
    act(() => resolveRecheck(true));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Download history' })).not.toBeInTheDocument());
    expect(usePreviewStore.getState().previewFilePath).toBeNull();
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
  });

  it('does not let a late file check from an obsolete index open a preview', async () => {
    const saved = artifact('saved', '/downloads/saved.csv', 'saved.csv');
    useChatStore.setState({
      conversationIndex: { task: meta('task', 'Task') },
    });
    loadMessagesMock.mockResolvedValue(messagesFor('task', [saved]));
    let resolveRecheck!: (value: boolean) => void;
    const recheck = new Promise<boolean>((resolve) => { resolveRecheck = resolve; });
    let checks = 0;
    existsMock.mockImplementation(() => {
      checks++;
      return checks === 1 ? Promise.resolve(true) : recheck;
    });

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();
    await waitFor(() => expect(within(rowFor('saved.csv')).getByRole('button', { name: 'Open file: saved.csv' })).toBeEnabled());
    await user.click(within(rowFor('saved.csv')).getByRole('button', {
      name: 'Open file: saved.csv',
    }));
    act(() => useChatStore.setState({ conversationIndex: {} }));
    act(() => resolveRecheck(true));

    await waitFor(() => expect(screen.getByText('No download records are available to show yet.')).toBeInTheDocument());
    expect(usePreviewStore.getState().previewFilePath).toBeNull();
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
  });

  it('shows one row when two frozen reports in the same task reference the same download', async () => {
    const saved = artifact('saved', '/downloads/saved.csv', 'saved.csv');
    const [tool, firstReport] = messagesFor('task', [saved]);
    const secondReport: Message = {
      ...firstReport,
      id: 'browser-run-report-task-later',
      timestamp: 3,
    };
    useChatStore.setState({
      conversationIndex: { task: meta('task', 'Task') },
    });
    loadMessagesMock.mockResolvedValue([tool, firstReport, secondReport]);

    render(<CapabilitiesSection />);
    await openDownloadHistory();
    await screen.findByText('saved.csv');

    expect(screen.getAllByText('saved.csv')).toHaveLength(1);
  });

  it('keeps valid task rows and explains an incomplete list when another task history cannot be read', async () => {
    const saved = artifact('saved', '/downloads/saved.csv', 'saved.csv');
    const recovered = artifact('recovered', '/downloads/recovered.csv', 'recovered.csv');
    let unreadable = true;
    useChatStore.setState({
      conversationIndex: {
        valid: meta('valid', 'Valid task'),
        unreadable: meta('unreadable', 'Unreadable task'),
      },
    });
    loadMessagesMock.mockImplementation((id: string) => (
      id === 'valid'
        ? Promise.resolve(messagesFor('valid', [saved]))
        : unreadable
          ? Promise.reject(new Error('app data directory unavailable'))
          : Promise.resolve(messagesFor('unreadable', [recovered]))
    ));

    render(<CapabilitiesSection />);
    const user = await openDownloadHistory();

    expect(await screen.findByText('saved.csv')).toBeInTheDocument();
    expect(screen.getByText(
      'Some task histories could not be read, so this list may be incomplete.',
    )).toBeInTheDocument();
    unreadable = false;
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await screen.findByText('recovered.csv')).toBeInTheDocument();
    expect(screen.queryByText(
      'Some task histories could not be read, so this list may be incomplete.',
    )).not.toBeInTheDocument();
  });

  it('shows a recoverable read error instead of an empty-history claim when every history read fails', async () => {
    useChatStore.setState({
      conversationIndex: {
        one: meta('one', 'First task'),
        two: meta('two', 'Second task'),
      },
    });
    loadMessagesMock.mockRejectedValue(new Error('app data directory unavailable'));

    render(<CapabilitiesSection />);
    await openDownloadHistory();

    expect(await screen.findByText('Download history could not be read.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read again' })).toBeInTheDocument();
    expect(screen.queryByText('No download records are available to show yet.')).not.toBeInTheDocument();
  });
});
