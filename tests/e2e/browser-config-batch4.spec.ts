/** Real profile restart pins confirmed browser resource persistence. */
import { expect, test } from '@playwright/test';
import { closeAbuElectron, createElectronDataRoot, launchAbuElectron, removeElectronDataRoot, dismissFirstRunOverlays } from './electronHelpers';
import type { Page } from 'playwright';
async function openBrowser(page: Page) {
  await expect(page.getByPlaceholder(/想让阿布帮你做点什么|What can Abu help/)).toBeVisible({timeout:45000});
  await dismissFirstRunOverlays(page);
  const guide = page.locator('[data-abu-guide-modal="true"]');
  await guide.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  if (await guide.isVisible()) await guide.getByRole('button', {name:'我知道了', exact:true}).click();
  await page.getByRole('button',{name:/^(我|Me)$/}).click();
  await page.getByRole('menuitem',{name:/^(设置|Settings)$/}).click();
  await page.getByRole('button',{name:/^(能力|Capabilities)$/}).click();
  await page.getByRole('button',{name:/^(阿布内置浏览器|Abu built-in browser)/}).click();
}
test('resource permission is confirmed on disk and survives a real relaunch',async()=>{
 const root=createElectronDataRoot();let launched=await launchAbuElectron(root);
 try {
  let page=await launched.app.firstWindow();await openBrowser(page);
  await expect(page.getByText('自动任务',{exact:true})).toHaveCount(0);
  const browse=page.getByRole('button',{name:/^浏览网页:/});
  await expect(browse).toContainText('允许');
  await browse.click();await page.getByRole('button',{name:/^禁止 /}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('abu-settings')!).state.browserPermissionConfigV2.defaults.browse)).toBe('deny');
  await closeAbuElectron(launched.app);launched=await launchAbuElectron(root);
  page=await launched.app.firstWindow();await openBrowser(page);
  await expect(page.getByRole('button',{name:/^浏览网页:/})).toContainText('禁止');
  await expect(page.getByRole('button',{name:/^上传文件:/})).toContainText('每次询问');
  await expect(page.getByRole('button',{name:/^运行脚本:/})).toContainText('每次询问');
  await page.screenshot({path:'test-results/browser-alpha-after-restart.png'});
 } finally {await closeAbuElectron(launched.app);removeElectronDataRoot(root);}
});
