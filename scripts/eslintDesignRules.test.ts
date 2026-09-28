import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: repoRoot });

const MIGRATED = 'src/components/design-preview/__lint_fixture__.tsx';
const UI_MIGRATED = 'src/components/ui/icon.tsx';
const LEGACY = 'src/components/chat/__lint_fixture__.tsx';

async function messages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });
  return result.messages.map((m) => m.message);
}

const component = (body: string) => `export function Fixture() { return (${body}); }\n`;

describe('design-system lint rules', { timeout: 60_000 }, () => {
  it.each([
    ['arbitrary color', '<div className="bg-[#ffffff]" />'],
    ['arbitrary var color', '<div className="text-[var(--abu-text-primary)]" />'],
    ['arbitrary z-index', '<div className="z-[9999]" />'],
    ['arbitrary radius', '<div className="rounded-[12px]" />'],
    ['Tailwind palette gray', '<div className="bg-gray-100" />'],
    ['Tailwind palette white', '<div className="text-white" />'],
    ['hand-written scrim', '<div className="fixed inset-0" />'],
  ])('flags %s in a migrated file', async (_name, jsx) => {
    expect(await messages(component(jsx), MIGRATED)).not.toEqual([]);
  });

  it('flags raw form controls in a migrated file', async () => {
    expect(await messages(component('<button type="button" />'), MIGRATED)).not.toEqual([]);
    expect(await messages(component('<input />'), MIGRATED)).not.toEqual([]);
  });

  it('flags importing lucide-react directly in a migrated file', async () => {
    const code = `import { X } from 'lucide-react';\n${component('<X />')}`;
    expect(await messages(code, MIGRATED)).not.toEqual([]);
  });

  it('accepts design-system tokens in a migrated file', async () => {
    const jsx = '<div className="bg-surface text-label rounded-panel shadow-float z-popover duration-base ease-enter" />';
    expect(await messages(component(jsx), MIGRATED)).toEqual([]);
  });

  it('lets ui/ files import lucide-react and render raw controls', async () => {
    const code = `import { X } from 'lucide-react';\n${component('<button type="button"><X /></button>')}`;
    expect(await messages(code, UI_MIGRATED)).toEqual([]);
  });

  it('still bans arbitrary values in ui/ files', async () => {
    expect(await messages(component('<div className="bg-[#ffffff]" />'), UI_MIGRATED)).not.toEqual([]);
  });

  it('leaves legacy files on the old rules during migration', async () => {
    expect(await messages(component('<div className="bg-[#ffffff] fixed inset-0" />'), LEGACY)).toEqual([]);
  });

  it('keeps the existing typography ban in migrated files', async () => {
    // eslint-disable-next-line no-restricted-syntax -- fixture for the typography rule
    expect(await messages(component('<div className="text-sm" />'), MIGRATED)).not.toEqual([]);
  });
});
