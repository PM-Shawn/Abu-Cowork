import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { waitForAppReady } from './helpers';

/**
 * E2E: a slow/flaky provider must surface a visible "正在重试 N/M" indicator
 * (Bug 1 — 死寂). We seed an OpenAI-compatible provider so Abu's own withRetry
 * (which drives retryInfo → the indicator) is the retry path — the Anthropic
 * SDK does its own internal retries that would hide it.
 *
 * The mock endpoint fails the first 2 attempts with a retryable 500, then
 * streams a reply, so we can assert BOTH: the retry indicator appeared, and
 * the retry eventually succeeded.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': '*',
};

/** Minimal OpenAI chat.completions SSE stream. */
function buildOpenAISSE(text: string): string {
  const lines: string[] = [];
  const emit = (obj: unknown) => {
    lines.push(`data: ${JSON.stringify(obj)}`);
    lines.push('');
  };
  emit({ id: 'cmpl_e2e', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  for (const chunk of text.match(/.{1,5}/g) ?? [text]) {
    emit({ id: 'cmpl_e2e', choices: [{ index: 0, delta: { content: chunk } }] });
  }
  emit({ id: 'cmpl_e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  lines.push('data: [DONE]', '');
  return lines.join('\n') + '\n';
}

async function seedOpenAIProvider(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const settings = {
      state: {
        providers: [
          {
            id: 'mock-openai',
            source: 'custom',
            name: 'Mock OpenAI',
            enabled: true,
            apiFormat: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-e2e-fake',
            models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', capabilities: {} }],
            capabilities: {},
            status: 'unchecked',
            sortOrder: 0,
          },
        ],
        activeModel: { providerId: 'mock-openai', modelId: 'gpt-4o-mini' },
        language: 'zh-CN',
        guideShown: true,
        hasAcknowledgedDisclaimer: true,
        hasRunSensitiveAudit_v015: true,
      },
      version: 33,
    };
    localStorage.setItem('abu-settings', JSON.stringify(settings));
  });
}

test.describe('Retry indicator', () => {
  test('shows 正在重试 while a flaky provider retries, then recovers', async ({ page }) => {
    await seedOpenAIProvider(page);

    let attempts = 0;
    await page.route('https://api.openai.com/**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS });
        return;
      }
      attempts += 1;
      if (attempts <= 2) {
        // Retryable server error → Abu's withRetry retries → onRetry sets retryInfo.
        await route.fulfill({
          status: 500,
          headers: { 'content-type': 'application/json', ...CORS },
          body: JSON.stringify({ error: { message: 'transient boom' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS },
        body: buildOpenAISSE('E2E retry OK'),
      });
    });

    await page.goto('/');
    await waitForAppReady(page);

    const chatInput = page.locator('textarea').first();
    await expect(chatInput).toBeVisible({ timeout: 10_000 });
    await chatInput.click();
    await chatInput.fill('Hi');
    await chatInput.press('Enter');

    // The retry indicator must become visible during the backoff windows
    // (server_error → ~2s backoff × 2 retries).
    await expect(page.getByText(/正在重试/).first()).toBeVisible({ timeout: 20_000 });

    // …and the retry eventually succeeds (reply streamed on the 3rd attempt).
    await expect(page.getByText('E2E retry OK')).toBeVisible({ timeout: 20_000 });

    expect(attempts).toBeGreaterThanOrEqual(3); // 2 failures + 1 success
  });
});
