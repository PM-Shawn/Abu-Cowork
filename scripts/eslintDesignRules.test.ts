import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';
import * as lintConfig from '../eslint.config.js';

const { overlayLintConfig } = lintConfig;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: repoRoot });

const PAGE = 'src/components/chat/__lint_fixture__.tsx';
const PAGE_TEST = 'src/components/chat/__lint_fixture__.test.tsx';
const DS = 'src/components/ds/icon.tsx';
const DS_TEST = 'src/components/ds/__lint_fixture__.test.tsx';

async function messages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });
  return result.messages.map((m) => m.message);
}

interface RestrictedSyntax { selector: string; message: string }
interface RestrictedImports { paths: { name: string }[]; patterns?: { group: string[] }[] }

// The rules ESLint ends up with for one path: the messages of no-restricted-syntax
// and the package names of no-restricted-imports.
async function rulesFor(filePath: string): Promise<{ syntax: string[]; imports: string[] }> {
  const config = await eslint.calculateConfigForFile(path.join(repoRoot, filePath));
  const [, ...selectors] = config.rules['no-restricted-syntax'] as [unknown, ...RestrictedSyntax[]];
  const [, restriction] = config.rules['no-restricted-imports'] as [unknown, RestrictedImports];
  return {
    syntax: selectors.map((entry) => entry.message),
    imports: restriction.paths.map((entry) => entry.name),
  };
}

const ARBITRARY_SIZE = 'not an arbitrary size';
const TOKEN_CLASS = 'use a token class';
const RAW_CONTROL = 'instead of a raw form control';
const DETERMINISM = 'TESTING.md';

const component = (body: string) => `export function Fixture() { return (${body}); }\n`;

describe('design-system lint rules', { timeout: 60_000 }, () => {
  it.each([
    ['arbitrary color', '<div className="bg-[#ffffff]" />'],
    ['arbitrary variable color', '<div className="text-[var(--ds-label)]" />'],
    ['arbitrary z-index', '<div className="z-[9999]" />'],
    ['arbitrary radius', '<div className="rounded-[12px]" />'],
    ['Tailwind palette gray', '<div className="bg-gray-100" />'],
    ['Tailwind palette white', '<div className="text-white" />'],
    ['Tailwind palette black shadow', '<div className="shadow-black/20" />'],
    ['Tailwind palette white gradient stop', '<div className="from-white" />'],
    ['hand-written scrim', '<div className="fixed inset-0" />'],
  ])('flags %s in page code', async (_name, jsx) => {
    expect(await messages(component(jsx), PAGE)).not.toEqual([]);
  });

  it('flags raw form controls in page code', async () => {
    expect(await messages(component('<button type="button" />'), PAGE)).not.toEqual([]);
    expect(await messages(component('<input />'), PAGE)).not.toEqual([]);
  });

  it('flags importing lucide-react directly in page code', async () => {
    const code = `import { X } from 'lucide-react';\n${component('<X />')}`;
    expect(await messages(code, PAGE)).not.toEqual([]);
  });

  it('accepts design-system tokens in page code', async () => {
    const jsx = '<div className="bg-surface text-label rounded-panel shadow-float z-popover duration-base ease-enter" />';
    expect(await messages(component(jsx), PAGE)).toEqual([]);
  });

  it('does not flag class names that only contain a palette prefix as a word part', async () => {
    const jsx = '<div className="divide-y history-item auto-cols-fr go-to-top" />';
    expect(await messages(component(jsx), PAGE)).toEqual([]);
  });

  it('lets ds/ files import lucide-react and render raw controls', async () => {
    const code = `import { X } from 'lucide-react';\n${component('<button type="button"><X /></button>')}`;
    expect(await messages(code, DS)).toEqual([]);
  });

  it('bans arbitrary values in ds/ files', async () => {
    expect(await messages(component('<div className="bg-[#ffffff]" />'), DS)).not.toEqual([]);
  });

  it('bans Tailwind named sizes in page code', async () => {
    // eslint-disable-next-line no-restricted-syntax -- fixture for the typography rule
    expect(await messages(component('<div className="text-sm" />'), PAGE)).not.toEqual([]);
  });

  it.each([
    ['shadcn background', '<div className="bg-background" />'],
    ['shadcn muted text', '<div className="text-muted-foreground" />'],
    ['shadcn primary with opacity', '<div className="hover:bg-primary/90" />'],
    ['shadcn input border', '<div className="border-input" />'],
    ['font size outside the scale', '<div className="text-minor" />'],
    ['heading size outside the scale', '<div className="text-h-sm" />'],
    ['Tailwind radius', '<div className="rounded-lg" />'],
    ['bare Tailwind radius', '<div className="rounded" />'],
    ['Tailwind side radius', '<div className="rounded-t-md" />'],
    ['Tailwind z-index', '<div className="z-50" />'],
    ['negative Tailwind z-index', '<div className="-z-10" />'],
    ['Tailwind duration', '<div className="duration-150" />'],
    ['Tailwind shadow', '<div className="focus:shadow-lg" />'],
    ['bare Tailwind shadow', '<div className="shadow" />'],
    ['Tailwind easing', '<div className="ease-in-out" />'],
  ])('flags %s in page code and in ds/ files', async (_name, jsx) => {
    expect(await messages(component(jsx), PAGE)).not.toEqual([]);
    expect(await messages(component(jsx), DS)).not.toEqual([]);
  });

  it('accepts every design-system class that shares a prefix with a banned one', async () => {
    const jsx = '<div className="rounded-full rounded-none rounded-t-panel shadow-none drop-shadow-md border-control-border ring-focus text-on-emphasis bg-fill-selected text-h1 text-caption data-[state=open]:duration-fast min-w-(--radix-select-trigger-width) font-code" />';
    expect(await messages(component(jsx), PAGE)).toEqual([]);
    expect(await messages(component(jsx), DS)).toEqual([]);
  });

  it('points page code at the design-system type scale', async () => {
    // eslint-disable-next-line no-restricted-syntax -- fixture for the typography rule
    const [message] = await messages(component('<div className="text-sm" />'), PAGE);
    expect(message).toContain('text-ui');
  });

  it('keeps design rules and determinism rules together in test files', async () => {
    const code = `${component('<div className="z-50" />')}export const now = Date.now();\n`;
    const page = await messages(code, PAGE_TEST);
    const ds = await messages(code, DS_TEST);
    for (const found of [page, ds]) {
      expect(found.some((m) => m.startsWith('Design system'))).toBe(true);
      expect(found.some((m) => m.startsWith(DETERMINISM))).toBe(true);
    }
  });

  it.each([
    ['the radix-ui package', "import { Dialog } from 'radix-ui';\n"],
    ['a radix-ui subpath', "import { FocusScope } from 'radix-ui/internal';\n"],
    ['a scoped @radix-ui package', "import * as Dialog from '@radix-ui/react-dialog';\n"],
  ])('bans %s outside ds/ and allows it inside', async (_name, importLine) => {
    const code = `${importLine}${component('<div />')}export const used = [typeof Dialog, typeof FocusScope];\n`.replace(
      importLine.includes('FocusScope') ? 'typeof Dialog, ' : ', typeof FocusScope',
      '',
    );
    const outside = await messages(code, PAGE);
    expect(outside.some((message) => message.includes('use the wrappers in @/components/ds'))).toBe(true);
    const inside = await messages(code, DS);
    expect(inside.some((message) => message.includes('use the wrappers in @/components/ds'))).toBe(false);
  });

  it('bans cmdk outside ds/', async () => {
    const code = `import { Command } from 'cmdk';\n${component('<Command />')}`;
    expect(await messages(code, PAGE)).not.toEqual([]);
  });

  it('flags a bare animate-in class', async () => {
    expect(await messages(component('<div className="animate-in fade-in-0" />'), PAGE)).not.toEqual([]);
  });

  it('accepts state-scoped animate-in forms', async () => {
    const jsx = '<div className="data-[state=open]:animate-in data-[state=closed]:animate-out" />';
    expect(await messages(component(jsx), PAGE)).toEqual([]);
  });
});

describe('where the design-system rules apply', { timeout: 60_000 }, () => {
  it.each([
    'src/App.tsx',
    'src/pet/PetApp.tsx',
    'src/components/chat/ChatView.tsx',
    'src/hooks/useNativeViewOcclusion.ts',
    'src/components/chat/ChatView.approvals.test.tsx',
  ])('gives %s the three class groups and the import restriction', async (file) => {
    const { syntax, imports } = await rulesFor(file);
    expect(syntax.some((m) => m.startsWith('Design system'))).toBe(true);
    expect(syntax.some((m) => m.includes(ARBITRARY_SIZE))).toBe(true);
    expect(syntax.some((m) => m.includes(TOKEN_CLASS))).toBe(true);
    expect(syntax.some((m) => m.includes(RAW_CONTROL))).toBe(true);
    expect(imports).toContain('lucide-react');
    expect(imports).toContain('radix-ui');
    expect(imports).toContain('cmdk');
  });

  it.each([
    'src/core/team/avatarPresets.ts',
    'src/stores/chatStore.ts',
    'src/stores/pluginStore.test.ts',
    'src/i18n/locales/zh-CN.ts',
    'src/eval/promptSnapshot.test.ts',
  ])('gives %s the import restriction and no class group', async (file) => {
    const { syntax, imports } = await rulesFor(file);
    expect(syntax.filter((m) => m.startsWith('Design system'))).toEqual([]);
    expect(imports).toContain('lucide-react');
    expect(imports).toContain('radix-ui');
    expect(imports).toContain('cmdk');
  });

  it('keeps the determinism rules in the test files of the directories that hold prose', async () => {
    for (const file of ['src/stores/pluginStore.test.ts', 'src/eval/promptSnapshot.test.ts']) {
      const { syntax } = await rulesFor(file);
      expect(syntax.some((m) => m.startsWith(DETERMINISM)), file).toBe(true);
    }
    const { syntax } = await rulesFor('src/stores/chatStore.ts');
    expect(syntax.some((m) => m.startsWith(DETERMINISM))).toBe(false);
  });

  it('gives a page test file the three class groups next to the determinism rules', async () => {
    const { syntax } = await rulesFor('src/components/chat/ChatView.approvals.test.tsx');
    expect(syntax.some((m) => m.includes(RAW_CONTROL))).toBe(true);
    expect(syntax.some((m) => m.startsWith(DETERMINISM))).toBe(true);
  });

  it('gives src/components/ds/button.tsx the size and value groups, no structure group and free imports', async () => {
    const { syntax, imports } = await rulesFor('src/components/ds/button.tsx');
    expect(syntax.some((m) => m.includes(ARBITRARY_SIZE))).toBe(true);
    expect(syntax.some((m) => m.includes(TOKEN_CLASS))).toBe(true);
    expect(syntax.some((m) => m.includes(RAW_CONTROL))).toBe(false);
    expect(imports).not.toContain('lucide-react');
    expect(imports).not.toContain('radix-ui');
    expect(imports).not.toContain('cmdk');
  });

  it('gives a ds/ test file the size and value groups next to the determinism rules', async () => {
    const { syntax, imports } = await rulesFor('src/components/ds/button.test.tsx');
    expect(syntax.some((m) => m.includes(TOKEN_CLASS))).toBe(true);
    expect(syntax.some((m) => m.includes(RAW_CONTROL))).toBe(false);
    expect(syntax.some((m) => m.startsWith(DETERMINISM))).toBe(true);
    expect(imports).not.toContain('lucide-react');
  });

  it('checks a file in any directory of src/ from its first commit', async () => {
    const code = component('<div className="z-50" />');
    for (const file of [
      'src/NewFileAtTheRoot.tsx',
      'src/components/NewDirectory/NewFile.tsx',
      'src/features/new-feature/NewFile.tsx',
      'src/hooks/useNewHook.ts',
      'src/utils/newHelper.ts',
      'src/lib/newWrapper.ts',
    ]) {
      expect(await messages(code, file), file).not.toEqual([]);
    }
  });

  it('reads no class name out of the prose of core/, stores/, i18n/ and eval/', async () => {
    const prose = "export const text = 'a rounded container with a shadow';\n";
    for (const file of [
      'src/core/widget/newGuide.ts',
      'src/stores/newStore.test.ts',
      'src/i18n/locales/newLocale.ts',
      'src/eval/newEval.test.ts',
    ]) {
      expect(await messages(prose, file), file).toEqual([]);
    }
    expect(await messages(prose, 'src/utils/newHelper.ts')).not.toEqual([]);
  });

  it('bans a direct icon import in the directories that hold prose', async () => {
    const icon = "import { X } from 'lucide-react';\nexport { X };\n";
    for (const file of ['src/core/team/newPresets.ts', 'src/stores/newStore.ts', 'src/i18n/newHelper.ts']) {
      const found = await messages(icon, file);
      expect(found.some((m) => m.includes('render icons through Icon + AppIcons')), file).toBe(true);
    }
  });

  it('exports no list of files', () => {
    expect(Object.keys(lintConfig).sort()).toEqual(['default', 'overlayLintConfig']);
  });
});

describe('overlayLintConfig', { timeout: 60_000 }, () => {
  const FILE = 'src/components/__overlay_fixture__.tsx';

  async function overlayMessages(migrated: string[], code: string): Promise<string[]> {
    const overlay = new ESLint({ cwd: repoRoot, overrideConfigFile: true, overrideConfig: overlayLintConfig(migrated) });
    const [result] = await overlay.lintText(code, { filePath: path.join(repoRoot, FILE) });
    return result.messages.map((m) => m.message);
  }

  it('applies the design-system rules to the files it is given', async () => {
    const palette = await overlayMessages(['src/**/*.tsx'], component('<div className="bg-gray-100" />'));
    expect(palette.some((m) => m.startsWith('Design system'))).toBe(true);
    expect(await overlayMessages(['src/**/*.tsx'], component('<div className="bg-surface text-label rounded-panel" />'))).toEqual([]);
    const icon = await overlayMessages(['src/**/*.tsx'], `import { X } from 'lucide-react';\n${component('<X />')}`);
    expect(icon.some((m) => m.includes('render icons through Icon + AppIcons'))).toBe(true);
  });

  it('holds only the base rules when no file has migrated', async () => {
    const palette = await overlayMessages([], component('<div className="bg-gray-100" />'));
    expect(palette.some((m) => m.startsWith('Design system'))).toBe(false);
    // The base rules are in force: an unused variable is reported.
    expect(await overlayMessages([], 'const unused = 1;\n')).not.toEqual([]);
  });
});
