/** Real Electron + sidecar + real PDF reader. Only the provider and native
 * dialog response are deterministic substitutes; no personal data is used. */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import {
  closeAbuElectron, configureLocalMockProvider, createElectronDataRoot,
  launchAbuElectron, removeElectronDataRoot,
} from './electronHelpers';

const PDF_TEXT = 'ABU_PDF_REGRESSION_20260914 revenue 12345';

function fixturePdf(): string {
  const stream = `BT /F1 14 Tf 40 160 Td (${PDF_TEXT}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

type RequestBody = { messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }> };

function sse(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'pdf-fixture', object: 'chat.completion.chunk', created: 0,
    model: 'abu-e2e-local-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

for (const route of ['main', 'direct', 'delegate', 'batch'] as const) {
  test(`PDF picker → ${route} → actual read_file text extraction`, async () => {
    const dataRoot = createElectronDataRoot();
    const filePath = path.join(dataRoot.rootDir, '季度 报告.PDF');
    fs.writeFileSync(filePath, fixturePdf());
    const requests: RequestBody[] = [];
    let delegated = false;
    let reads = 0;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw) as RequestBody;
      requests.push(body);
      const toolMessages = body.messages?.filter((message) => message.role === 'tool') ?? [];
      const hasReadResult = toolMessages.some((message) => String(message.content).includes(PDF_TEXT));
      let response: string;
      if ((route === 'delegate' || route === 'batch') && !delegated) {
        delegated = true;
        const input = route === 'delegate'
          ? { type: 'research', task: 'Read the attached PDF with read_file and report its text.' }
          : { tasks: [
            { type: 'research', task: 'Read the attached PDF facts with read_file.' },
            { type: 'writer', task: 'Read the attached PDF figures with read_file.' },
          ] };
        response = sse({ tool_calls: [{ index: 0, id: 'pdf-delegate', type: 'function',
          function: { name: route === 'delegate' ? 'delegate_to_agent' : 'run_agent_batch', arguments: JSON.stringify(input) } }] })
          + sse({}, 'tool_calls');
      } else if (!hasReadResult && toolMessages.length === 0 && body.messages?.some((message) =>
        message.role === 'user' && JSON.stringify(message.content).includes(filePath))) {
        reads++;
        response = sse({ tool_calls: [{ index: 0, id: `pdf-read-${reads}`, type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: filePath }) } }] }) + sse({}, 'tool_calls');
      } else {
        response = sse({ content: hasReadResult ? `Verified ${PDF_TEXT}` : 'PDF reader did not return expected text.' }) + sse({}, 'stop');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(response + 'data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback bind failed');
    const launched = await launchAbuElectron(dataRoot);
    try {
      const page = await launched.app.firstWindow();
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 45_000 });
      await configureLocalMockProvider(page, `http://2130706433:${address.port}/v1`, { supportsTools: true, permissionMode: 'standard' });
      await page.reload();
      await expect(page.getByRole('textbox')).toBeVisible({ timeout: 45_000 });
      if (route === 'main') {
        // setInputFiles creates a native-backed Chromium File. A synthetic File
        // cannot pass webUtils.getPathForFile, which is the boundary under test.
        await page.evaluate(() => {
          const input = document.createElement('input');
          input.type = 'file'; input.id = 'pdf-drop-fixture'; input.hidden = true;
          document.body.append(input);
        });
        await page.locator('#pdf-drop-fixture').setInputFiles(filePath);
        await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('#pdf-drop-fixture')!;
          const transfer = new DataTransfer();
          transfer.items.add(input.files![0]);
          document.querySelector('textarea')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          input.remove();
        });
        const badge = page.getByText('季度 报告.PDF', { exact: true });
        await expect(badge).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('pdf-dropped.png') });
        await badge.locator('..').getByRole('button').click();
        await expect(badge).toHaveCount(0);
      }
      await launched.app.evaluate(({ dialog }, selectedPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
      }, filePath);
      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-add-file').click();
      await expect(page.getByText('季度 报告.PDF', { exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('pdf-attached.png') });
      await page.getByRole('textbox').fill(`${route === 'direct' ? '@数据分析师 ' : ''}Read the attached PDF and report the exact revenue text.`);
      await page.getByRole('textbox').press('Enter');
      await expect.poll(() => requests.filter((body) => body.messages?.some((message) =>
        message.role === 'tool' && String(message.content).includes(PDF_TEXT))).length,
      { timeout: 45_000 }).toBeGreaterThanOrEqual(route === 'batch' ? 2 : 1);
      expect(reads).toBe(route === 'batch' ? 2 : 1);
      expect(JSON.stringify(requests)).not.toContain('"type":"document"');
      expect(JSON.stringify(requests[0])).toContain('季度 报告.PDF');
      await page.screenshot({ path: test.info().outputPath('pdf-read.png') });
    } finally {
      if (test.info().status !== test.info().expectedStatus) {
        await test.info().attach('provider-requests', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' });
      }
      await closeAbuElectron(launched.app);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeElectronDataRoot(dataRoot);
    }
  });
}
