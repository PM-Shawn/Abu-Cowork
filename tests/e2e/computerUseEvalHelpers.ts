import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import path from 'node:path';

export const CU_CHAT = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;

export async function configureComputerUseEval(page: Page, baseUrl: string): Promise<void> {
  await expect(page.getByPlaceholder(CU_CHAT)).toBeVisible({ timeout: 60_000 });
  await page.evaluate(({ baseUrl }) => {
    const saved = JSON.parse(window.localStorage.getItem('abu-settings')!);
    const capabilities = { supportsTools: true, supportsImages: false };
    const providerId = 'desktop-eval';
    const modelId = 'desktop-eval';
    Object.assign(saved.state, {
      providers: [{ id: providerId, source: 'custom', name: 'Isolated desktop evaluation', enabled: true,
        apiFormat: 'openai-compatible', baseUrl, apiKey: 'test-only-not-a-real-key',
        models: [{ id: modelId, label: modelId, isCustom: true, declaredCapabilities: capabilities }],
        defaultModelId: modelId, status: 'verified', sortOrder: 0, userAdded: true, declaredCapabilities: capabilities }],
      activeModel: { providerId, modelId }, recentModels: [], favoriteModels: [], permissionMode: 'standard',
      computerUseEnabled: true, guideShown: true, guideOpen: false, hasAcknowledgedDisclaimer: true, hasRunSensitiveAudit_v015: true,
    });
    window.localStorage.setItem('abu-settings', JSON.stringify(saved));
  }, { baseUrl });
  await page.reload();
  await expect(page.getByPlaceholder(CU_CHAT)).toBeVisible({ timeout: 60_000 });
}

interface ApprovalState { requested: number; denied: number; held: boolean; release?: () => void }
type ApprovalGlobal = typeof globalThis & { __desktopEvalApproval?: ApprovalState };

/** Replaces dialogs only inside this test-owned Electron process. */
export async function installFixtureApproval(app: ElectronApplication, appName: string, hold = false): Promise<void> {
  await app.evaluate(({ dialog }, { appName, hold }) => {
    const state: ApprovalState = { requested: 0, denied: 0, held: false };
    (globalThis as ApprovalGlobal).__desktopEvalApproval = state;
    const expected = new Set([`允许 Abu 操作「${appName}」？`, `Allow Abu to control "${appName}"?`]);
    const mutable = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<unknown> };
    mutable.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string; cancelId?: number };
      if (!expected.has(options?.title ?? '')) {
        state.denied++;
        return { response: options?.cancelId ?? 1, checkboxChecked: false };
      }
      state.requested++;
      if (hold && state.requested === 1) {
        state.held = true;
        await new Promise<void>((resolve) => { state.release = resolve; });
        state.held = false;
      }
      return { response: 0, checkboxChecked: false };
    };
  }, { appName, hold });
}

export async function fixtureApprovalState(app: ElectronApplication) {
  return app.evaluate(() => {
    const { requested, denied, held } = (globalThis as ApprovalGlobal).__desktopEvalApproval!;
    return { requested, denied, held };
  });
}

export async function releaseFixtureApproval(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as ApprovalGlobal).__desktopEvalApproval?.release?.());
}

/** Fault injection is limited to the Helper owned by this test Electron. */
export async function restartOwnedHelper(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, managerPath) => {
    const mainModule = (process as NodeJS.Process & { mainModule?: { require: NodeRequire } }).mainModule;
    if (!mainModule) throw new Error('Test-owned main module is unavailable');
    const manager = mainModule.require(managerPath) as { killNativeHelper: (reason: string) => void };
    manager.killNativeHelper('desktop-e2e-restart');
  }, path.join(process.cwd(), 'electron', 'nativeHelperManager.cjs'));
}

export async function invokeHost<T>(page: Page, command: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ command, args }) => {
    const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('Real Electron IPC unavailable');
    return internals.invoke(command, args);
  }, { command, args }) as Promise<T>;
}
