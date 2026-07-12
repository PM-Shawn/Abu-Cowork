import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

/**
 * Build a minimal Anthropic SSE stream so the agent loop can receive a reply
 * and mark the conversation as having messages (exits welcome-screen state).
 */
function buildAnthropicSSEResponse(text: string): string {
  const lines: string[] = [];

  const emit = (eventType: string, data: unknown) => {
    lines.push(`event: ${eventType}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push('');
  };

  emit('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_e2e_mock',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  });

  emit('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  const chunks = text.match(/.{1,5}/g) ?? [text];
  for (const chunk of chunks) {
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk },
    });
  }

  emit('content_block_stop', { type: 'content_block_stop', index: 0 });

  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: text.length },
  });

  emit('message_stop', { type: 'message_stop' });

  return lines.join('\n') + '\n';
}

test.describe('Conversation', () => {
  test('new task button clears active conversation to welcome state', async ({ page }) => {
    // Mock LLM so we can send a real message and get a reply
    await page.route('https://api.anthropic.com/**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, GET, OPTIONS',
            'access-control-allow-headers': '*',
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        },
        body: buildAnthropicSSEResponse('任务完成'),
      });
    });

    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);

    // Send a message — this creates a conversation with messages, exiting welcome state
    const chatInput = page.locator('textarea').first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });
    await chatInput.click();
    await chatInput.fill('Hi');
    await chatInput.press('Enter');

    // Wait for the mock reply to confirm we are now in an active conversation
    await expect(page.getByText('任务完成')).toBeVisible({ timeout: 20_000 });

    // Welcome title must NOT be visible now (we are viewing conversation messages)
    await expect(page.getByText('交给阿布就行啦 ✨')).not.toBeVisible();

    // Sending the first message auto-collapses the sidebar; expand it to reach "新建任务"
    await page.getByRole('button', { name: '显示侧栏' }).click();

    // Click "新建任务" — clears activeConversationId, returns to welcome state
    await page.getByRole('button', { name: '新建任务' }).first().click();

    // Welcome title reappears: real state change (conversation messages gone from view)
    await expect(page.getByText('交给阿布就行啦 ✨')).toBeVisible({ timeout: 5000 });
  });

  test('can type and clear message in chat input', async ({ page }) => {
    await setupAbuSettings(page);
    await page.goto('/');
    await waitForAppReady(page);

    const chatInput = page.locator('textarea').first();
    await chatInput.click();
    await chatInput.fill('Hello test');
    await expect(chatInput).toHaveValue('Hello test');
    await chatInput.fill('');
    await expect(chatInput).toHaveValue('');
  });
});
