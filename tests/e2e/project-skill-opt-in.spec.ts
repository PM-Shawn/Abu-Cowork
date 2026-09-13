/**
 * Real Electron coverage for project-skill switches.
 *
 * Project skills (`<workspace>/.abu/skills/*`) are on by default like every
 * other skill source, and only the user flips their switch in 扩展 › 技能. A
 * discovery refresh runs on every boot, workspace switch and skills-folder
 * change; it used to switch project skills off, which (2026-09-12 repro):
 *
 *  1. undid the user's opt-in on the next workspace switch or restart;
 *  2. switched off the user's own same-named skill (`~/.abu/skills/<name>`) in
 *     every other workspace, the switch list being keyed by name.
 *
 * Under E2E the host's home directory is `<appData>/Home`, so the user-level
 * skill lives in the test's own data root, never in the developer's `~/.abu`.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const PROJECT_ONLY_SKILL = 'e2e-project-only';
const SHARED_SKILL = 'e2e-shared-name';

function writeSkill(dir: string, name: string, description: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function disabledTestSkills(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    const names = raw ? (JSON.parse(raw).state.disabledSkills as string[]) : [];
    return names.filter((name) => name.startsWith('e2e-'));
  });
}

function projectRow(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).locator('xpath=..');
}

async function startTaskIn(page: Page, projectName: string): Promise<void> {
  await projectRow(page, projectName).getByTitle('新任务', { exact: true }).click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
}

async function openSkills(page: Page): Promise<void> {
  await page.getByLabel('Main navigation').getByRole('button', { name: '扩展', exact: true }).click();
  await page.getByRole('button', { name: '技能', exact: true }).click();
}

function skillSwitch(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name} `) }).getByRole('switch');
}

async function expectSwitch(page: Page, name: string, on: boolean): Promise<void> {
  await expect(skillSwitch(page, name)).toHaveAttribute('aria-checked', on ? 'true' : 'false', { timeout: 15_000 });
}

async function flipSwitch(page: Page, name: string, on: boolean): Promise<void> {
  await expectSwitch(page, name, !on);
  await skillSwitch(page, name).click();
  await expectSwitch(page, name, on);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

/**
 * Seed workspace A (both project skills), an empty workspace B, the user copy
 * of the shared name, and a project for each workspace; launch and open A.
 */
async function launchInProjectA(): Promise<{ page: Page; root: ElectronDataRoot }> {
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspaceA = path.join(root.rootDir, 'workspace-a');
  const workspaceB = path.join(root.rootDir, 'workspace-b');
  fs.mkdirSync(workspaceB, { recursive: true });
  writeSkill(path.join(workspaceA, '.abu', 'skills'), PROJECT_ONLY_SKILL, 'project skill only');
  writeSkill(path.join(workspaceA, '.abu', 'skills'), SHARED_SKILL, 'project copy of a shared name');
  writeSkill(path.join(root.appDataDir, 'Home', '.abu', 'skills'), SHARED_SKILL, 'user copy of a shared name');

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ a, b, version }) => {
    const project = (id: string, name: string, workspacePath: string) => ({
      id, name, workspacePath, pinned: false, archived: false,
      createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, lastActiveAt: 1_800_000_000_000,
    });
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: { projects: { 'project-a': project('project-a', 'E2E Project A', a), 'project-b': project('project-b', 'E2E Project B', b) } },
      version,
    }));
  }, { a: workspaceA, b: workspaceB, version: persistedStoreVersion('abu-projects') });
  await dismissFirstRunOverlays(page);

  await startTaskIn(page, 'E2E Project A');
  await openSkills(page);
  // Both project skills were discovered, and neither was switched off.
  await expectSwitch(page, PROJECT_ONLY_SKILL, true);
  await expectSwitch(page, SHARED_SKILL, true);
  expect(await disabledTestSkills(page)).toEqual([]);
  return { page, root };
}

test('project skill switches survive workspace switches and never reach a same-named user skill', async () => {
  test.setTimeout(150_000);
  const { page } = await launchInProjectA();
  await flipSwitch(page, PROJECT_ONLY_SKILL, false);

  // Workspace B shows only the user's own copy of the shared name — still on.
  await startTaskIn(page, 'E2E Project B');
  await openSkills(page);
  await expectSwitch(page, SHARED_SKILL, true);

  // Back in A the user's "off" held; turn it on again and switch once more.
  await startTaskIn(page, 'E2E Project A');
  await openSkills(page);
  await expectSwitch(page, PROJECT_ONLY_SKILL, false);
  await flipSwitch(page, PROJECT_ONLY_SKILL, true);
  await startTaskIn(page, 'E2E Project B');
  await startTaskIn(page, 'E2E Project A');
  await openSkills(page);
  await expectSwitch(page, PROJECT_ONLY_SKILL, true);
  expect(await disabledTestSkills(page)).toEqual([]);
});

test('project skill switches survive a restart', async () => {
  test.setTimeout(180_000);
  const { page, root } = await launchInProjectA();
  await flipSwitch(page, PROJECT_ONLY_SKILL, false);

  await closeAbuElectron(app!);
  app = (await launchAbuElectron(root)).app;
  const relaunched = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(relaunched);
  await startTaskIn(relaunched, 'E2E Project A');
  await openSkills(relaunched);
  // The user's "off" held, and the boot refresh switched nothing else off.
  await expectSwitch(relaunched, PROJECT_ONLY_SKILL, false);
  await expectSwitch(relaunched, SHARED_SKILL, true);
  expect(await disabledTestSkills(relaunched)).toEqual([PROJECT_ONLY_SKILL]);
});
