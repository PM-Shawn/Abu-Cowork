/**
 * Real-Electron journey for the image-gen chat-endpoint warning: a 0.38 user
 * whose V41 migration carried a Volcengine *chat* endpoint
 * (/api/coding/v3 + chat model) into `imageGeneration.backends` opens
 * Settings → Models → Image Generation, edits the migrated backend, and gets
 * an inline warning naming the correct endpoint — instead of only ever seeing
 * generate_image's bare "404 " at tool time. Correcting the baseUrl clears
 * the warning.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const BASE_URL_PLACEHOLDER = /如 https:\/\/ark\.cn-beijing\.volces\.com\/api\/plan\/v3|e\.g\. https:\/\/ark\.cn-beijing\.volces\.com\/api\/plan\/v3/;
const CHAT_ENDPOINT_WARNING = /该地址是火山方舟的聊天端点|Volcengine Ark's chat endpoint/;

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Same localStorage priming as diagnostic-export.spec.ts, plus the migrated
 *  chat-endpoint backend exactly as the V41 migration produced it. */
async function primeMigratedChatEndpointBackend(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    Object.assign(persisted.state, {
      guideShown: true,
      guideOpen: false,
      hasAcknowledgedDisclaimer: true,
      hasRunSensitiveAudit_v015: true,
      imageGeneration: {
        backends: [{
          id: 'e2e-migrated',
          name: '图片生成（迁移）',
          vendor: 'custom',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
          apiKey: '',
          model: 'Doubao-Seed-2.0-lite',
        }],
        defaultId: 'e2e-migrated',
      },
    });
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await waitForApp(page);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron image-gen settings — chat-endpoint warning', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('editing a V41-migrated chat-endpoint backend shows the warning; correcting the URL clears it', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await primeMigratedChatEndpointBackend(page);

    await page.getByRole('button', { name: /^(我|Me)$/ }).first().click();
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
    await page.getByRole('button', { name: /^(模型|Models)$/ }).click();

    // Expand the image-gen backends panel via its "1 backend configured"
    // count chip, then open the migrated backend's edit modal.
    await page.getByRole('button', { name: /已配置 1 个后端|1 backend/ }).click();
    await page.getByRole('button', { name: /^(编辑后端|Edit Backend)$/ }).click();

    const baseUrlInput = page.getByPlaceholder(BASE_URL_PLACEHOLDER);
    await expect(baseUrlInput).toHaveValue('https://ark.cn-beijing.volces.com/api/coding/v3');
    await expect(page.getByText(CHAT_ENDPOINT_WARNING)).toBeVisible();
    // The warning names the correct endpoint so the user can fix it in place.
    await expect(page.getByText(CHAT_ENDPOINT_WARNING)).toContainText('https://ark.cn-beijing.volces.com/api/v3');

    await baseUrlInput.fill('https://ark.cn-beijing.volces.com/api/v3');
    await expect(page.getByText(CHAT_ENDPOINT_WARNING)).toBeHidden();
  });
});
