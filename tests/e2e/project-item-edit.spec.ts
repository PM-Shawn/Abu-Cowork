/**
 * Real-Electron acceptance: editing an expert or skill that does NOT live
 * under ~/.abu/<folder>/ saves it where it lives, and never touches the
 * user's own same-named item (finding I4 of the #470 re-review).
 *
 * Before the fix the editor wrote a copy to ~/.abu/<folder>/<name>/ without
 * create-new: the user's same-named item was silently overwritten, and the
 * list kept showing the project item, which outranks the copy — the edit
 * never took. Deterministic per TESTING.md: no provider, no model run.
 *
 * Fixtures:
 * - Project-level expert: the registry's project root is `.abu/agents`
 *   resolved against the main process cwd, which launchAbuElectron pins to
 *   REPO_ROOT (gitignored `.abu/`; removed in `finally`; workers: 1).
 * - Project skill: `<isolated HOME>/i4-workspace/.abu/skills`, made the
 *   current workspace by starting a task in a seeded sidebar project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import {
  REPO_ROOT,
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const AGENT = 'e2e-project-expert';
const SKILL = 'e2e-project-skill';
const RENAMED_SKILL = 'e2e-project-skill-v2';
const PROJECT_NAME = 'E2E项目';

const agentMd = (tag: string) => `---\nname: ${AGENT}\ndescription: ${tag} copy\n---\n\n${tag}-PROMPT\n`;
const skillMd = (tag: string) => `---\nname: ${SKILL}\ndescription: ${tag} copy\n---\n\n${tag}-BODY\n`;

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const read = (file: string) => fs.readFileSync(file, 'utf8');

/** The detail's "…" menu has no testid; it is the only ellipsis button once the detail is open. */
function detailMenuButton(page: Page) {
  return page.locator('button:has(svg[class*="ellipsis"]), button:has(svg[class*="more-horizontal"])').last();
}

test.describe('editing an item outside ~/.abu', () => {
  test('saves the project expert and skill in place; the user\'s same-named items are untouched', async () => {
    test.setTimeout(300_000);
    const dataRoot = createElectronDataRoot();
    const home = path.join(dataRoot.appDataDir, 'Home');
    const workspace = path.join(home, 'i4-workspace');
    const userAgent = path.join(home, '.abu', 'agents', AGENT, 'AGENT.md');
    // Remove only what this test creates: all of `.abu/` when it made it.
    const repoAbu = path.join(REPO_ROOT, '.abu');
    const projectAgentDir = path.join(repoAbu, 'agents', AGENT);
    const cleanupDir = fs.existsSync(repoAbu) ? projectAgentDir : repoAbu;
    const projectAgent = path.join(projectAgentDir, 'AGENT.md');
    const userSkill = path.join(home, '.abu', 'skills', SKILL, 'SKILL.md');
    const projectSkillsRoot = path.join(workspace, '.abu', 'skills');
    const projectSkill = path.join(projectSkillsRoot, SKILL, 'SKILL.md');
    const projectScript = path.join(projectSkillsRoot, SKILL, 'scripts', 'run.sh');
    write(userAgent, agentMd('USER'));
    write(projectAgent, agentMd('PROJECT'));
    write(userSkill, skillMd('USER'));
    write(projectSkill, skillMd('PROJECT'));
    write(projectScript, 'echo project\n');
    let launched: Awaited<ReturnType<typeof launchAbuElectron>> | undefined;
    try {
      launched = await launchAbuElectron(dataRoot);
      const page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      // A sidebar project bound to the fixture workspace: no native folder dialog.
      await page.evaluate(({ ws, name }) => {
        const at = 1_700_000_000_000;
        window.localStorage.setItem('abu-projects', JSON.stringify({
          state: { projects: { e2e: { id: 'e2e', name, workspacePath: ws, pinned: false, archived: false, createdAt: at, updatedAt: at, lastActiveAt: at } } },
          version: 1,
        }));
      }, { ws: workspace, name: PROJECT_NAME });
      await dismissFirstRunOverlays(page);

      // ---- 1. The project expert (it outranks the user's same-named one) -----
      await page.getByTestId('sidebar-team').click();
      await page.getByTestId('top-tab-nav').getByRole('button', { name: '队员' }).click();
      await page.getByText(AGENT, { exact: true }).first().click();
      await expect(page.getByText('PROJECT-PROMPT')).toBeVisible();
      await detailMenuButton(page).click();
      await page.getByText('编辑', { exact: true }).click();
      await page.getByPlaceholder('Write agent system prompt in Markdown...').fill('EDITED-PROMPT');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText(AGENT, { exact: true }).first().click();
      await expect(page.getByText('EDITED-PROMPT')).toBeVisible();
      await page.keyboard.press('Escape');
      expect(read(projectAgent)).toContain('EDITED-PROMPT');
      expect(read(userAgent)).toBe(agentMd('USER'));

      // ---- 2. The project skill ------------------------------------------------
      await page.getByText(PROJECT_NAME, { exact: true }).hover();
      await page.getByTitle('新任务', { exact: true }).first().click();
      await page.getByLabel('Main navigation').getByRole('button', { name: '扩展', exact: true }).click();
      await page.getByRole('button', { name: '技能', exact: true }).click();
      const card = page.getByRole('button', { name: new RegExp(`^${SKILL} `) });
      await expect(card).toContainText('项目');
      await card.click();
      const detail = page.locator('[data-electron-no-drag]').filter({ has: page.getByTestId('skill-detail') }).last();
      await expect(detail).toContainText('PROJECT-BODY');
      await detail.getByTestId('skill-detail-menu').click();
      await detail.getByText('编辑', { exact: true }).click();
      await page.getByPlaceholder('Write skill instructions in Markdown...').fill('EDITED-BODY');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await card.click();
      await expect(detail).toContainText('EDITED-BODY');
      expect(read(projectSkill)).toContain('EDITED-BODY');
      expect(read(userSkill)).toBe(skillMd('USER'));

      // ---- 3. Renaming it moves its folder inside the project -----------------
      await detail.getByTestId('skill-detail-menu').click();
      await detail.getByText('编辑', { exact: true }).click();
      await page.getByPlaceholder('my-skill').fill(RENAMED_SKILL);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('button', { name: new RegExp(`^${RENAMED_SKILL} `) })).toContainText('项目');
      expect(read(path.join(projectSkillsRoot, RENAMED_SKILL, 'SKILL.md'))).toContain(`name: ${RENAMED_SKILL}`);
      expect(read(path.join(projectSkillsRoot, RENAMED_SKILL, 'scripts', 'run.sh'))).toBe('echo project\n');
      expect(fs.existsSync(path.join(projectSkillsRoot, SKILL))).toBe(false);
      expect(fs.existsSync(path.join(home, '.abu', 'skills', RENAMED_SKILL))).toBe(false);
      expect(read(userSkill)).toBe(skillMd('USER'));
    } finally {
      if (launched) await closeAbuElectron(launched.app);
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      removeElectronDataRoot(dataRoot);
    }
  });
});
