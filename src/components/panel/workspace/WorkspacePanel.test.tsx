// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
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
  default: ({ filePath }: { filePath: string }) => <div>Preview {filePath}</div>,
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
    <TooltipProvider>
      <WorkspacePanel />
    </TooltipProvider>,
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
});
