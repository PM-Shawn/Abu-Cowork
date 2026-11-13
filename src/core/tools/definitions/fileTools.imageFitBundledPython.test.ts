import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolExecutionContext, ToolResultContent } from '@/types';
import { admissionMaxDimension, imageAcceptanceLimits } from '@/core/llm/imagePolicy';
import { admissionRawBytes } from '@/core/llm/imageFit';
import { normalizeMessages } from '@/core/llm/messageNormalizer';
import { imageHeaderSize } from '@/utils/imageHeaderSize';
import { base64ToUint8Array } from '@/utils/base64';

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPillow = spawnSync(python, ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;

// The build with no authorization provider hands read_file no `files`: the picture is read by
// fsBridge and fitted by the bundled Python, which this test replaces with this machine's Python.
vi.mock('../fsBridge', async () => {
  const fs = await import('node:fs');
  return {
    exists: async (p: string) => fs.existsSync(p),
    readFile: async (p: string) => new Uint8Array(fs.readFileSync(p)),
    readTextFile: async (p: string) => fs.readFileSync(p, 'utf8'),
    stat: async (p: string) => ({ size: fs.statSync(p).size, isFile: true, isDirectory: false }),
    writeTextFile: vi.fn(), readDir: vi.fn(),
  };
});
const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../helpers/scopedCommand', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers/scopedCommand')>()),
  invokeTaskCommand: (...args: unknown[]) => commands.run(...args),
}));

import { readFileTool } from './fileTools';

const spawnProgram = async (_cmd: string, args: { program: string; args: string[] }) => {
  const out = spawnSync(args.program, args.args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { code: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
};

let dir = '';
/** `noise`: random pixels (a photograph, large as a PNG); otherwise flat colour (small). */
function picture(name: string, width: number, height: number, noise: boolean): string {
  const file = join(dir, name);
  const make = noise
    ? `import os; im = Image.frombytes('RGB', (${width}, ${height}), os.urandom(${width * height * 3}))`
    : `im = Image.new('RGB', (${width}, ${height}), (200, 40, 40))`;
  const done = spawnSync(python, ['-c', `from PIL import Image\n${make}\nim.save(${JSON.stringify(file)})`], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(done.stderr);
  return file;
}

const imageOf = (result: unknown) => (result as ToolResultContent[]).find((b): b is Extract<ToolResultContent, { type: 'image' }> => b.type === 'image')!;

describe.skipIf(!hasPillow)('read_file with no file access (the open-source build) fits a plain picture by its long side and byte limit', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fit-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const read = (file: string) => readFileTool.execute({ path: file }, { supportsVision: true } as ToolExecutionContext);

  it('fits a wide picture that is small in bytes: long side at the admission limit, a PNG stays a PNG', async () => {
    commands.run.mockImplementation(spawnProgram);
    const file = picture('wide.png', 5200, 1300, false);
    expect(statSync(file).size).toBeLessThan(admissionRawBytes());
    const result = await read(file);
    const image = imageOf(result);
    const size = imageHeaderSize(base64ToUint8Array(image.source.data))!;
    expect(Math.max(size.w, size.h)).toBe(admissionMaxDimension());
    expect(size.h).toBe(Math.round(1300 * admissionMaxDimension() / 5200));
    expect(image.source.media_type).toBe('image/png');
    // The picture's caption (not a separate resize note) tells the model the size it is shown at.
    expect(JSON.stringify((result as ToolResultContent[])[0])).toContain(`shown at ${size.w}×${size.h} px`);
  });

  it('fits a tall picture by its height', async () => {
    commands.run.mockImplementation(spawnProgram);
    const image = imageOf(await read(picture('tall.png', 1000, 6000, false)));
    const size = imageHeaderSize(base64ToUint8Array(image.source.data))!;
    // The width is rounded down to a whole pixel, so the height lands at most a few pixels under the limit.
    expect(size.h).toBeLessThanOrEqual(admissionMaxDimension());
    expect(size.h).toBeGreaterThan(admissionMaxDimension() - 10);
  });

  it('brings a photograph that is inside the side limit but over the byte limit under the byte limit, as a JPEG', async () => {
    commands.run.mockImplementation(spawnProgram);
    const file = picture('photo.png', 1900, 1500, true);
    expect(statSync(file).size).toBeGreaterThan(admissionRawBytes());
    const image = imageOf(await read(file));
    expect(image.source.media_type).toBe('image/jpeg');
    expect(base64ToUint8Array(image.source.data).length).toBeLessThanOrEqual(admissionRawBytes());
  });

  it('leaves a picture inside both limits as it is, without starting Python', async () => {
    commands.run.mockClear();
    const file = picture('small.png', 800, 600, false);
    const image = imageOf(await read(file));
    expect(commands.run).not.toHaveBeenCalled();
    expect(base64ToUint8Array(image.source.data)).toEqual(new Uint8Array(readFileSync(file)));
  });

  it('sends the picture as it is when Python cannot run, for the send-time check to judge', async () => {
    commands.run.mockRejectedValue(new Error('spawn python3 ENOENT'));
    const file = picture('nopy.png', 4000, 1000, false);
    const result = await read(file) as ToolResultContent[];
    expect(base64ToUint8Array(imageOf(result).source.data)).toEqual(new Uint8Array(readFileSync(file)));
    expect(JSON.stringify(result[0])).not.toContain('resized');
  });

  // The model gets what the request carries, so the picture is followed to the request body.
  it.each(['claude-sonnet-4-6', 'deepseek-v4-flash'])('the request to %s carries the fitted picture, not a note', async (model) => {
    commands.run.mockImplementation(spawnProgram);
    const file = picture('request.png', 10032, 4178, false);
    const content = await read(file) as ToolResultContent[];
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'look', timestamp: 1 },
      { id: 'a', role: 'assistant', content: '', timestamp: 1, toolCallsForContext: [{ id: 't1', name: 'read_file', input: { path: file }, result: 'ok', resultContent: content }] } as Message,
    ];
    const turns = normalizeMessages(messages, { supportsVision: true, ...imageAcceptanceLimits(model) } as never);
    const assistant = turns.find((t) => t.kind === 'assistant');
    if (assistant?.kind !== 'assistant') throw new Error('no assistant turn');
    expect(assistant.toolCalls[0].resultImages).toHaveLength(1);
    expect(assistant.toolCalls[0].result).not.toContain('left out');
  });
});
