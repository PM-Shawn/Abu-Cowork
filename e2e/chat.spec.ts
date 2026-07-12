import { test, expect } from '@playwright/test';
import { setupAbuSettings, waitForAppReady } from './helpers';

/**
 * Build a minimal Anthropic SSE stream that the SDK's async iterator can consume.
 * Format: `event: <type>\ndata: <json>\n\n` repeated per event.
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

  // Emit text in small chunks to exercise the delta path
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

test.describe('Chat', () => {
  test.beforeEach(async ({ page }) => {
    await setupAbuSettings(page);

    // Intercept Anthropic API calls BEFORE navigation so the route is active when
    // the app makes its first LLM request (getTauriFetch returns globalThis.fetch
    // in web mode, so page.route() can catch it).
    //
    // Cross-origin POST → browser sends OPTIONS preflight first. We must respond to
    // OPTIONS with CORS headers or the actual POST never gets sent.
    await page.route('https://api.anthropic.com/**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, GET, OPTIONS',
            'access-control-allow-headers': '*',
            'access-control-max-age': '86400',
          },
        });
        return;
      }

      const body = buildAnthropicSSEResponse('E2E mock reply');
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
          'x-request-id': 'req_e2e_mock',
          'anthropic-ratelimit-requests-limit': '100',
          'anthropic-ratelimit-requests-remaining': '99',
          'anthropic-ratelimit-tokens-limit': '100000',
          'anthropic-ratelimit-tokens-remaining': '99000',
        },
        body,
      });
    });

    await page.goto('/');
    await waitForAppReady(page);
  });

  test('sends a message and displays mock assistant reply', async ({ page }) => {
    // Collect diagnostics
    const requests: string[] = [];
    const consoleErrors: string[] = [];
    page.on('request', (req) => requests.push(`${req.method()} ${req.url()}`));
    page.on('pageerror', (err) => consoleErrors.push(`${err.message}\n${err.stack ?? ''}`));

    // Find the chat textarea (welcome variant)
    const chatInput = page.locator('textarea').first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    // Start watching for the LLM POST BEFORE we send the message
    const llmPostPromise = page.waitForRequest(
      (req) => req.url().includes('api.anthropic.com') && req.method() === 'POST',
      { timeout: 15_000 },
    ).catch(() => null);

    // Type a message and send via Enter
    await chatInput.click();
    await chatInput.fill('Hello');
    await chatInput.press('Enter');

    // First verify the POST was actually made
    const llmPost = await llmPostPromise;
    if (!llmPost) {
      throw new Error(
        `LLM POST never made.\nAll requests: ${requests.join(', ')}\nPage errors: ${consoleErrors.join(', ')}`,
      );
    }

    // Wait for the mock assistant reply to appear in the chat
    await expect(page.getByText('E2E mock reply')).toBeVisible({ timeout: 20_000 });
  });
});
