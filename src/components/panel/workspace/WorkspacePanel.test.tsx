// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import {
  BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
  useBatchProgressStore,
} from '@/stores/batchProgressStore';
import {
  usePreviewStore,
  workspaceTabButtonId,
  workspaceTabPanelId,
  type WorkspaceTab,
} from '@/stores/previewStore';
import type { BatchIdentity } from '@/types';
import WorkspacePanel from './WorkspacePanel';

vi.mock('../PreviewPanel', () => ({
  default: ({ filePath, line, lineRequest, keptCopy }: { filePath: string; line?: number; lineRequest?: number; keptCopy?: boolean }) => (
    <div data-line={line} data-line-request={lineRequest} data-kept-copy={keptCopy}>Preview {filePath}</div>
  ),
}));
vi.mock('./TerminalTab', () => ({
  default: ({ tabId }: { tabId: string }) => <div>Terminal {tabId}</div>,
}));
vi.mock('./BrowserTab', () => ({
  default: ({ url }: { url: string }) => <div>Browser {url}</div>,
}));
vi.mock('./SummaryBody', () => ({
  default: () => <div>Summary body</div>,
}));
vi.mock('./ChangesTab', () => ({
  default: (props: { tabId: string; conversationId: string; loopId: string; fileIndex: number }) => (
    <div>Changes tab {props.tabId} {props.conversationId} {props.loopId} {props.fileIndex}</div>
  ),
}));

const identity: BatchIdentity = { conversationId: 'conv-workspace-panel', batchToolCallId: 'batch-1' };
const subagentTab: WorkspaceTab = {
  id: 'subagent:v1:conv-workspace-panel:batch-1:0',
  kind: 'subagent',
  identity,
  taskIndex: 0,
  title: 'Worker A',
};

function resetStores() {
  usePreviewStore.setState({
    tabs: [],
    activeTabId: null,
    focusTabId: null,
    menuOpen: false,
    appModalOpen: false,
    previewFilePath: null,
    chatWidth: null,
    reloadNonce: 0,
    fileTreeMode: false,
  });
  useBatchProgressStore.setState({
    batches: {},
    activeVisibleBatchKey: undefined,
    richAccessClock: 0,
    richContentDiagnostics: {
      totalRetainedRichBytes: 0,
      retainedRichBytesCap: BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
      overageBytes: 0,
      evictionCount: 0,
      releasedBatchCount: 0,
      lastEvictedKey: undefined,
    },
  });
}

function renderPanel() {
  return render(
    <DesignSystemProvider>
      <WorkspacePanel />
    </DesignSystemProvider>,
  );
}

describe('WorkspacePanel', () => {
  beforeEach(() => {
    initLanguage('en-US');
    resetStores();
  });

  it('renders stable tabpanel ids linked to the focusable tab buttons and keeps inactive panels mounted', () => {
    usePreviewStore.setState({
      tabs: [
        { id: 'summary-tab', kind: 'summary' },
        { id: 'preview-tab', kind: 'preview', filePath: '/tmp/a.md' },
      ],
      activeTabId: 'preview-tab',
      previewFilePath: '/tmp/a.md',
    });

    const { container } = renderPanel();

    const summaryPanel = container.querySelector(`#${workspaceTabPanelId('summary-tab')}`);
    const previewPanel = screen.getByRole('tabpanel', { name: /a.md/ });
    expect(summaryPanel).toBeInTheDocument();
    expect(summaryPanel).toHaveAttribute('id', workspaceTabPanelId('summary-tab'));
    expect(summaryPanel).toHaveAttribute('aria-labelledby', workspaceTabButtonId('summary-tab'));
    expect(previewPanel).toHaveAttribute('id', workspaceTabPanelId('preview-tab'));
    expect(screen.getByText('Summary body')).toBeInTheDocument();
    expect(screen.getByText('Preview /tmp/a.md')).toBeInTheDocument();
  });

  it('hands a preview tab its requested line and the count of the requests', () => {
    usePreviewStore.setState({
      tabs: [
        { id: 'with-line', kind: 'preview', filePath: '/tmp/a.ts', line: 24, lineRequest: 2 },
        { id: 'without-line', kind: 'preview', filePath: '/tmp/b.ts' },
      ],
      activeTabId: 'with-line',
      previewFilePath: '/tmp/a.ts',
    });

    renderPanel();

    expect(screen.getByText('Preview /tmp/a.ts')).toHaveAttribute('data-line', '24');
    expect(screen.getByText('Preview /tmp/a.ts')).toHaveAttribute('data-line-request', '2');
    expect(screen.getByText('Preview /tmp/b.ts')).not.toHaveAttribute('data-line');
    expect(screen.getByText('Preview /tmp/b.ts')).not.toHaveAttribute('data-line-request');
  });

  it('tells the preview of a kept copy that it shows one, and no other preview', () => {
    usePreviewStore.setState({
      tabs: [
        { id: 'copy', kind: 'preview', filePath: '/data/outputs/files/ab12/a.md', keptCopyOf: '/work/a.md' },
        { id: 'own-path', kind: 'preview', filePath: '/work/b.md' },
      ],
      activeTabId: 'copy',
      previewFilePath: '/data/outputs/files/ab12/a.md',
    });

    renderPanel();

    expect(screen.getByText('Preview /data/outputs/files/ab12/a.md')).toHaveAttribute('data-kept-copy', 'true');
    expect(screen.getByText('Preview /work/b.md')).toHaveAttribute('data-kept-copy', 'false');
  });

  it('renders the changes tab of a turn with the conversation, loop and file it names', () => {
    usePreviewStore.setState({
      tabs: [{ id: 'changes:conv-a:loop-1', kind: 'changes', conversationId: 'conv-a', loopId: 'loop-1', fileIndex: 2, title: 'Changes: plan.md' }],
      activeTabId: 'changes:conv-a:loop-1',
    });

    renderPanel();

    const panel = screen.getByRole('tabpanel', { name: /Changes: plan\.md/ });
    expect(panel).toHaveTextContent('Changes tab changes:conv-a:loop-1 conv-a loop-1 2');
  });

  it('mounts no changes tab body for a tab another conversation owns', () => {
    usePreviewStore.setState({
      tabs: [{
        id: 'changes:conv-b:loop-1', kind: 'changes', conversationId: 'conv-b', loopId: 'loop-1', fileIndex: 0,
        title: 'Changes: plan.md', ownerConversationId: 'conv-b',
      }],
      currentConversationId: 'conv-a',
      activeTabId: null,
    });

    renderPanel();

    expect(screen.queryByText(/Changes tab/)).toBeNull();
  });

  it('renders a subagent workspace panel from explicit identity and task index', () => {
    const store = useBatchProgressStore.getState();
    store.initBatch(identity, ['Worker']);
    store.setTaskRunning(identity, 0);
    usePreviewStore.setState({
      tabs: [subagentTab],
      activeTabId: subagentTab.id,
      previewFilePath: null,
    });

    renderPanel();

    expect(screen.getByRole('tab', { name: 'Worker A' })).toHaveAttribute(
      'aria-controls',
      workspaceTabPanelId(subagentTab.id),
    );
    expect(screen.getByRole('tabpanel', { name: 'Worker A' })).toHaveAttribute(
      'aria-labelledby',
      workspaceTabButtonId(subagentTab.id),
    );
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('offers the three things the panel can open when every tab is closed', () => {
    renderPanel();

    expect(screen.getByText('Start from here')).toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    const launchers = ['Task Summary', 'Browser', 'Terminal'].map((name) => (
      screen.getByRole('button', { name: new RegExp(`^${name}`) })
    ));
    expect(launchers).toHaveLength(3);

    fireEvent.click(launchers[2]);

    expect(usePreviewStore.getState().tabs.map((tab) => tab.kind)).toEqual(['terminal']);
    expect(screen.queryByText('Start from here')).toBeNull();
    expect(screen.getByText(/^Terminal /)).toBeInTheDocument();
  });
});
