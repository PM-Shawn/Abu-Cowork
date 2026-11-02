import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { launchAbuElectron, closeAbuElectron, createElectronDataRoot, removeElectronDataRoot, configureLocalMockProvider, dismissFirstRunOverlays } from '../e2e/electronHelpers';
import { startOpenAiMock, waitForApp } from '../e2e/openAiMock';
import { persistedStoreVersion } from '../e2e/storeVersions';

test('edits forty megapixels with fifty thousand points and a hundred comments, then streams a video over two hundred MiB', async () => {
  test.setTimeout(300_000);
  const root = createElectronDataRoot();
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace);
  const imagePath = path.join(workspace, 'large.png');
  const videoPath = path.join(workspace, 'large.mp4');
  await sharp({ create: { width: 8000, height: 5000, channels: 3, background: '#dbc6a0' } }).png().toFile(imagePath);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-vf', 'noise=alls=100:allf=t+u:all_seed=42', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '0', '-pix_fmt', 'yuv420p', '-fs', '230000000', videoPath,
  ], { timeout: 60_000, stdio: 'pipe' });
  const videoBytes = fs.statSync(videoPath).size;
  expect(videoBytes).toBeGreaterThan(200 * 1024 * 1024);
  const model = await startOpenAiMock([
    { kind: 'tool-call', toolCallId: 'present-performance', toolName: 'present_files', arguments: { files: [{ path: imagePath }, { path: videoPath }] } },
    { kind: 'complete', responseText: '性能素材已准备。' },
  ]);
  const { app } = await launchAbuElectron(root);
  try {
    const page = await app.firstWindow();
    await waitForApp(page);
    await page.evaluate(({ workspace, version }) => {
      localStorage.setItem('abu-projects', JSON.stringify({ version, state: { projects: {
        performance: { id: 'performance', name: '性能检查', workspacePath: workspace, pinned: false, archived: false, createdAt: 1, updatedAt: 1, lastActiveAt: 1 },
      } } }));
    }, { workspace, version: persistedStoreVersion('abu-projects') });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, model.baseUrl, { supportsTools: true, permissionMode: 'standard' });
    await page.getByRole('button', { name: '性能检查', exact: true }).locator('xpath=..').getByRole('button', { name: '新任务', exact: true }).click();
    const composer = page.locator('[data-chat-composer]');
    await composer.fill('显示性能素材');
    await composer.press('Enter');
    await expect(page.getByText('性能素材已准备。', { exact: true })).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId('chat-message-list').locator('.group\\/card').filter({ has: page.getByRole('img', { name: 'large.png', exact: true }) }).first();
    await card.hover();
    await card.getByRole('button', { name: '修改图片', exact: true }).click();
    const preview = page.locator('[role="tabpanel"]:not([hidden])');
    await expect(page.getByTestId('image-edit-reference')).toBeVisible();
    await preview.getByRole('button', { name: '全屏', exact: true }).click();
    await preview.getByRole('button', { name: '标记', exact: true }).click();
    const image = preview.getByRole('img', { name: 'large.png', exact: true });
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(8000);
    const bounds = await image.boundingBox();
    expect(bounds).toBeTruthy();
    const samples: number[] = [];
    for (let stroke = 0; stroke < 100; stroke += 1) {
      const x = bounds!.x + bounds!.width * 0.2;
      const y = bounds!.y + bounds!.height * (0.2 + (stroke % 20) / 40);
      await page.mouse.move(x, y);
      await page.mouse.down();
      samples.push(await image.locator('..').evaluate(async (stage, point) => {
        const started = performance.now();
        for (let index = 1; index < 500; index += 1) {
          stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: point.x + index / 5, clientY: point.y + Math.sin(index / 10) * 4 }));
          if (index % 100 === 0) await new Promise(requestAnimationFrame);
        }
        await new Promise(requestAnimationFrame);
        return performance.now() - started;
      }, { x, y }));
      await page.mouse.up();
    }
    const paths = image.locator('..').locator(':scope > svg > path');
    await expect(paths).toHaveCount(100);
    await preview.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(paths).toHaveCount(99);
    await preview.getByRole('button', { name: '重做', exact: true }).click();
    await expect(paths).toHaveCount(100);
    await preview.getByRole('button', { name: '批注', exact: true }).click();
    for (let index = 0; index < 100; index += 1) {
      await image.click({ position: { x: bounds!.width * (0.05 + (index % 10) * 0.1), y: bounds!.height * (0.05 + Math.floor(index / 10) * 0.1) } });
      const field = page.getByRole('textbox', { name: `批注 ${index + 1}`, exact: true });
      await expect(field).toBeFocused();
      await field.fill('保留这部分内容');
      await field.press('Enter');
      await expect(page.getByTestId('image-comment-editor')).toBeHidden();
    }
    await expect(preview.getByRole('button', { name: /^批注 \d+$/ })).toHaveCount(100);
    await preview.getByRole('button', { name: '批注 100', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '批注 100', exact: true })).toHaveValue('保留这部分内容');
    await page.getByRole('textbox', { name: '批注 100', exact: true }).press('Escape');
    await preview.getByRole('button', { name: '退出全屏', exact: true }).click();
    const video = page.getByTestId('chat-message-list').locator('video[aria-label="large.mp4"]').first();
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await video.press('Space');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    await video.press('Space');
    await video.evaluate(element => { const video = element as HTMLVideoElement; video.currentTime = video.duration / 2; });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).seeking)).toBe(false);
    const videoState = await video.evaluate(element => { const video = element as HTMLVideoElement; return { duration: video.duration, currentTime: video.currentTime, paused: video.paused, error: video.error?.code ?? null }; });
    expect(videoState.error).toBeNull();
    expect(videoState.currentTime).toBeCloseTo(videoState.duration / 2, 1);
    await video.press('Space');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(videoState.currentTime);
    await video.press('Space');
    await video.evaluate(element => { const video = element as HTMLVideoElement; video.currentTime = Math.max(0, video.duration - 0.75); });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).seeking)).toBe(false);
    const nearEnd = await video.evaluate(element => (element as HTMLVideoElement).currentTime);
    expect(nearEnd).toBeCloseTo(videoState.duration - 0.75, 1);
    await video.press('Space');
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(nearEnd);
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).ended)).toBe(true);
    const endState = await video.evaluate(element => { const video = element as HTMLVideoElement; return { currentTime: video.currentTime, ended: video.ended, error: video.error?.code ?? null }; });
    expect(endState.error).toBeNull();
    const memory = await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === 'Tab').map(metric => metric.memory));
    const report = { platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), width: 8000, height: 5000, strokes: 100, points: 50_000, comments: 100, medianStrokeMs: [...samples].sort((a, b) => a - b)[50], maxStrokeMs: Math.max(...samples), undoRedo: true, videoBytes, videoState, endState, rendererMemory: memory };
    const reportDirectory = path.resolve('.agent/media-performance');
    fs.mkdirSync(reportDirectory, { recursive: true });
    const reportPath = path.join(reportDirectory, 'renderer.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await test.info().attach('multimedia-performance', { path: reportPath, contentType: 'application/json' });
  } finally {
    await closeAbuElectron(app);
    await model.close();
    removeElectronDataRoot(root);
  }
});
