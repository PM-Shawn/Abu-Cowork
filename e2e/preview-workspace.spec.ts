import { test, expect, type Page } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

type BatchScenario = 'completed' | 'running';

const BATCH_CONVERSATION_ID = 'e2e-workspace-batch-conversation';
const FIRST_TASK = '检查界面';

/**
 * Seed the renderer's real stores after hydration. This keeps the Web E2E
 * deterministic while exercising the same message grouping and workspace-tab
 * path used by a sidecar-delivered run_agent_batch result.
 */
async function seedBatchConversation(page: Page, scenario: BatchScenario): Promise<void> {
  await page.evaluate(async ({ scenario }) => {
    const chatStoreModulePath = '/src/stores/chatStore.ts';
    const batchProgressStoreModulePath = '/src/stores/batchProgressStore.ts';
    const previewStoreModulePath = '/src/stores/previewStore.ts';
    const settingsStoreModulePath = '/src/stores/settingsStore.ts';
    const typesModulePath = '/src/types/index.ts';
    const [
      { useChatStore },
      { useBatchProgressStore },
      { usePreviewStore },
      { useSettingsStore },
      { makeBatchKey },
    ] = await Promise.all([
      import(chatStoreModulePath),
      import(batchProgressStoreModulePath),
      import(previewStoreModulePath),
      import(settingsStoreModulePath),
      import(typesModulePath),
    ]);

    const conversationId = 'e2e-workspace-batch-conversation';
    const assistantMessageId = 'e2e-batch-tool-message';
    const batchToolCallId = 'e2e-workspace-batch-call';
    const identity = { conversationId, assistantMessageId, batchToolCallId };
    const timestamp = 1_700_000_000_000;
    const batchToolCall = {
      id: batchToolCallId,
      name: 'run_agent_batch',
      input: { tasks: [{ task: '检查界面' }, { task: '整理结论' }] },
      result: scenario === 'completed' ? 'batch complete' : undefined,
      isExecuting: scenario === 'running',
    };
    const assistantMessages = scenario === 'completed'
      ? [
        {
          id: assistantMessageId,
          role: 'assistant' as const,
          content: '',
          timestamp: timestamp + 1_000,
          loopId: 'e2e-batch-loop',
          toolCalls: [batchToolCall],
        },
        {
          id: 'e2e-batch-final-message',
          role: 'assistant' as const,
          content: '并行任务已完成。',
          timestamp: timestamp + 4_000,
          loopId: 'e2e-batch-loop',
          usage: { inputTokens: 12, outputTokens: 8 },
        },
      ]
      : [{
        id: assistantMessageId,
        role: 'assistant' as const,
        content: '',
        timestamp: timestamp + 1_000,
        loopId: 'e2e-batch-loop',
        isStreaming: true,
        toolCalls: [batchToolCall],
      }];

    useSettingsStore.getState().setRightPanelCollapsed(false);
    usePreviewStore.setState({
      tabs: [],
      activeTabId: null,
      focusTabId: null,
      previewFilePath: null,
      menuOpen: false,
      appModalOpen: false,
    });
    useChatStore.setState({
      conversations: {
        [conversationId]: {
          id: conversationId,
          title: '批量工作区 E2E',
          createdAt: timestamp,
          updatedAt: timestamp + 4_000,
          status: scenario === 'running' ? 'running' : 'completed',
          workspacePath: '/e2e/workspace',
          messages: [
            {
              id: 'e2e-batch-user-message',
              role: 'user',
              content: '请并行检查并整理结论。',
              timestamp,
              loopId: 'e2e-batch-loop',
              runState: scenario === 'running' ? 'running' : 'completed',
              ...(scenario === 'completed' ? { runEndedAt: timestamp + 4_000 } : {}),
            },
            ...assistantMessages,
          ],
        },
      },
      activeConversationId: conversationId,
      agentStatus: scenario === 'running' ? 'thinking' : 'idle',
      currentTool: scenario === 'running' ? 'run_agent_batch' : null,
    });
    useBatchProgressStore.setState({
      batches: {
        [makeBatchKey(identity)]: {
          identity,
          startedAt: timestamp + 1_000,
          runLeaseCount: scenario === 'running' ? 1 : 0,
          viewLeaseCount: 0,
          retainedRichBytes: 0,
          lastRichAccessTick: 0,
          tasks: scenario === 'completed'
            ? [
              {
                label: '检查界面',
                status: 'succeeded',
                terminalReason: 'completed',
                startedAt: timestamp + 1_000,
                endedAt: timestamp + 2_000,
                toolCallCount: 1,
                lastToolName: 'read_file',
                steps: [],
              },
              {
                label: '整理结论',
                status: 'succeeded',
                terminalReason: 'completed',
                startedAt: timestamp + 1_000,
                endedAt: timestamp + 3_000,
                toolCallCount: 0,
                steps: [],
              },
            ]
            : [{
              label: '检查界面',
              status: 'running',
              startedAt: timestamp + 1_000,
              toolCallCount: 1,
              lastToolName: 'read_file',
              activity: '读取文件',
              turn: 1,
              steps: [],
            }, {
              label: '整理结论',
              status: 'queued',
              toolCallCount: 0,
              steps: [],
            }],
        },
      },
      activeVisibleBatchKey: undefined,
      richAccessClock: 0,
    });
  }, { scenario });
}

async function workspaceState(page: Page) {
  return page.evaluate(async () => {
    const batchProgressStoreModulePath = '/src/stores/batchProgressStore.ts';
    const previewStoreModulePath = '/src/stores/previewStore.ts';
    const typesModulePath = '/src/types/index.ts';
    const [{ useBatchProgressStore }, { usePreviewStore }, { makeBatchKey }] = await Promise.all([
      import(batchProgressStoreModulePath),
      import(previewStoreModulePath),
      import(typesModulePath),
    ]);
    const identity = {
      conversationId: 'e2e-workspace-batch-conversation',
      assistantMessageId: 'e2e-batch-tool-message',
      batchToolCallId: 'e2e-workspace-batch-call',
    };
    return {
      tabs: usePreviewStore.getState().tabs,
      taskStatus: useBatchProgressStore.getState().batches[makeBatchKey(identity)]?.tasks[0]?.status,
    };
  });
}

test.describe('Preview and workspace journey', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('keeps the workspace choice visible for a new unbound task', async ({ page }) => {
    const workspaceContext = page.locator('[data-abu-workspace-context]');

    await expect(workspaceContext).toBeVisible();
    await expect(workspaceContext.getByRole('button', { name: '选择工作区' })).toBeVisible();
  });

  test('opens an image preview, uses reading controls, and switches workspace tabs', async ({ page }) => {
    await page.evaluate(async () => {
      const previewModulePath = '/src/stores/previewStore.ts';
      const settingsModulePath = '/src/stores/settingsStore.ts';
      const [{ usePreviewStore }, { useSettingsStore }] = await Promise.all([
        import(previewModulePath),
        import(settingsModulePath),
      ]);
      useSettingsStore.getState().setRightPanelCollapsed(false);
      usePreviewStore.getState().openPreview(
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="64" height="64"%3E%3Crect width="64" height="64" fill="%23c76f4b"/%3E%3C/svg%3E',
      );
    });

    const panel = page.locator('[data-abu-right-panel]');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('img', { name: '图片预览' })).toBeVisible();

    await panel.getByTitle('放大图片').click();
    await expect(panel.getByText('125%')).toBeVisible();

    await panel.getByTitle('向右旋转').click();
    await expect(panel.getByRole('img', { name: '图片预览' })).toHaveCSS(
      'transform',
      /matrix\(0, 1\.25, -1\.25, 0,/,
    );

    await panel.getByRole('button', { name: '新建标签页' }).click();
    await page.getByRole('button', { name: '新建浏览器' }).click();
    await expect(panel.locator('[role="tab"]').filter({ hasText: '新标签页' })).toBeVisible();

    await panel.locator('[role="tab"]').filter({ hasText: '图片预览' }).click();
    await expect(panel.getByText('125%')).toBeVisible();
  });

  test('renders a completed batch aggregate and opens a deduped subagent workspace tab', async ({ page }) => {
    await seedBatchConversation(page, 'completed');

    const processHeader = page.getByRole('button', { name: /用时 4s · 2 个 Agent：2 成功/ });
    await expect(processHeader).toHaveAttribute('aria-expanded', 'false');
    await processHeader.click();
    await expect(processHeader).toHaveAttribute('aria-expanded', 'true');

    const firstTaskRow = page.getByRole('button', { name: '打开 检查界面（已成功）' });
    await expect(firstTaskRow).toBeVisible();
    await firstTaskRow.click();
    await firstTaskRow.click();

    const workspaceTabs = page.locator('[data-abu-workspace-tabs]');
    const subagentTab = workspaceTabs.getByRole('tab', { name: FIRST_TASK });
    await expect(subagentTab).toHaveCount(1);
    await expect(subagentTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[aria-modal="true"], .fixed.inset-0')).toHaveCount(0);

    await page.evaluate(async () => {
      const previewStoreModulePath = '/src/stores/previewStore.ts';
      const { usePreviewStore } = await import(previewStoreModulePath);
      usePreviewStore.getState().openBrowser('', 'e2e-workspace-browser');
    });

    const browserTab = workspaceTabs.getByRole('tab', { name: '新标签页' });
    await expect(browserTab).toHaveAttribute('aria-selected', 'true');
    await subagentTab.click();
    await expect(subagentTab).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps a running batch alive when closing its subagent tab and stops only on explicit Stop', async ({ page }) => {
    await seedBatchConversation(page, 'running');
    await page.evaluate(async () => {
      const chatStoreModulePath = '/src/stores/chatStore.ts';
      const { useChatStore } = await import(chatStoreModulePath);
      const store = useChatStore.getState();
      const originalCancelStreaming = store.cancelStreaming;
      const testState = globalThis as typeof globalThis & {
        __abuE2ECancelCalls?: string[];
      };
      testState.__abuE2ECancelCalls = [];
      useChatStore.setState({
        cancelStreaming: (conversationId, options) => {
          testState.__abuE2ECancelCalls?.push(conversationId);
          originalCancelStreaming(conversationId, options);
        },
      });
    });

    const firstTaskRow = page.getByRole('button', { name: '打开 检查界面（运行中）' });
    await expect(firstTaskRow).toBeVisible();
    await firstTaskRow.click();

    const subagentTab = page.locator('[data-abu-workspace-tabs]').getByRole('tab', { name: FIRST_TASK });
    await expect(subagentTab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: `关闭 ${FIRST_TASK}` }).click();
    await expect(subagentTab).toHaveCount(0);

    const afterClose = await workspaceState(page);
    expect(afterClose.taskStatus).toBe('running');
    await expect.poll(async () => page.evaluate(() =>
      (globalThis as typeof globalThis & { __abuE2ECancelCalls?: string[] }).__abuE2ECancelCalls ?? [],
    )).toEqual([]);

    await firstTaskRow.locator('xpath=ancestor::section').getByRole('button', { name: '停止' }).click();
    await expect.poll(async () => page.evaluate(() =>
      (globalThis as typeof globalThis & { __abuE2ECancelCalls?: string[] }).__abuE2ECancelCalls ?? [],
    )).toEqual([BATCH_CONVERSATION_ID]);
  });
});
