import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: repoRoot });

const MIGRATED = 'src/components/design-preview/__lint_fixture__.tsx';
const UI_MIGRATED = 'src/components/ds/icon.tsx';
const UI_TEST = 'src/components/ds/__lint_fixture__.test.tsx';
const MIGRATED_TEST = 'src/components/design-preview/__lint_fixture__.test.tsx';
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
    ['Tailwind palette black shadow', '<div className="shadow-black/20" />'],
    ['Tailwind palette white gradient stop', '<div className="from-white" />'],
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

  it('does not flag class names that only contain a palette prefix as a word part', async () => {
    const jsx = '<div className="divide-y history-item auto-cols-fr go-to-top" />';
    expect(await messages(component(jsx), MIGRATED)).toEqual([]);
  });

  it('lets ds/ files import lucide-react and render raw controls', async () => {
    const code = `import { X } from 'lucide-react';\n${component('<button type="button"><X /></button>')}`;
    expect(await messages(code, UI_MIGRATED)).toEqual([]);
  });

  it('still bans arbitrary values in ds/ files', async () => {
    expect(await messages(component('<div className="bg-[#ffffff]" />'), UI_MIGRATED)).not.toEqual([]);
  });

  it('leaves legacy files on the old rules during migration', async () => {
    expect(await messages(component('<div className="bg-[#ffffff] fixed inset-0" />'), LEGACY)).toEqual([]);
  });

  it('keeps the existing typography ban in migrated files', async () => {
    // eslint-disable-next-line no-restricted-syntax -- fixture for the typography rule
    expect(await messages(component('<div className="text-sm" />'), MIGRATED)).not.toEqual([]);
  });

  it.each([
    ['shadcn background', '<div className="bg-background" />'],
    ['shadcn muted text', '<div className="text-muted-foreground" />'],
    ['shadcn primary with opacity', '<div className="hover:bg-primary/90" />'],
    ['shadcn input border', '<div className="border-input" />'],
    ['legacy font size', '<div className="text-minor" />'],
    ['legacy heading size', '<div className="text-h-sm" />'],
    ['Tailwind radius', '<div className="rounded-lg" />'],
    ['bare Tailwind radius', '<div className="rounded" />'],
    ['Tailwind side radius', '<div className="rounded-t-md" />'],
    ['Tailwind z-index', '<div className="z-50" />'],
    ['negative Tailwind z-index', '<div className="-z-10" />'],
    ['Tailwind duration', '<div className="duration-150" />'],
    ['Tailwind shadow', '<div className="focus:shadow-lg" />'],
    ['bare Tailwind shadow', '<div className="shadow" />'],
    ['Tailwind easing', '<div className="ease-in-out" />'],
  ])('flags legacy %s in migrated and ds/ files', async (_name, jsx) => {
    expect(await messages(component(jsx), MIGRATED)).not.toEqual([]);
    expect(await messages(component(jsx), UI_MIGRATED)).not.toEqual([]);
  });

  it('accepts every design-system class that shares a prefix with a legacy one', async () => {
    const jsx = '<div className="rounded-full rounded-none rounded-t-panel shadow-none drop-shadow-md border-control-border ring-focus text-on-emphasis bg-fill-selected text-h1 text-caption data-[state=open]:duration-fast min-w-(--radix-select-trigger-width) font-code" />';
    expect(await messages(component(jsx), MIGRATED)).toEqual([]);
    expect(await messages(component(jsx), UI_MIGRATED)).toEqual([]);
  });

  it('points migrated files at the design-system type scale', async () => {
    // eslint-disable-next-line no-restricted-syntax -- fixture for the typography rule
    const [message] = await messages(component('<div className="text-sm" />'), MIGRATED);
    expect(message).toContain('text-ui');
  });

  it('keeps design rules and determinism rules together in migrated and ds/ test files', async () => {
    const code = `${component('<div className="z-50" />')}export const now = Date.now();\n`;
    const migrated = await messages(code, MIGRATED_TEST);
    const ds = await messages(code, UI_TEST);
    for (const found of [migrated, ds]) {
      expect(found.some((m) => m.startsWith('Design system'))).toBe(true);
      expect(found.some((m) => m.startsWith('TESTING.md'))).toBe(true);
    }
  });

  it('bans cmdk outside ds/', async () => {
    const code = `import { Command } from 'cmdk';\n${component('<Command />')}`;
    expect(await messages(code, MIGRATED)).not.toEqual([]);
  });

  it('flags a bare animate-in class that the legacy global rule hijacks', async () => {
    expect(await messages(component('<div className="animate-in fade-in-0" />'), MIGRATED)).not.toEqual([]);
  });

  it('accepts state-scoped animate-in forms', async () => {
    const jsx = '<div className="data-[state=open]:animate-in data-[state=closed]:animate-out" />';
    expect(await messages(component(jsx), MIGRATED)).toEqual([]);
  });

  it('checks the chat files that finished migrating', async () => {
    const code = component('<div className="text-[var(--abu-text-primary)]" />');
    expect(await messages(code, 'src/components/chat/ChatView.tsx')).not.toEqual([]);
  });

  it.each([
    'src/components/chat/chapters.ts',
    'src/components/chat/FileAttachment.test.tsx',
    'src/components/chat/SourcesSection.test.tsx',
    'src/components/chat/IMInfoBar.test.tsx',
    'src/components/common/FolderSelector.test.tsx',
    'src/components/chat/ConvIdBadge.test.tsx',
  ])('checks %s with the migrated rules', async (file) => {
    const code = `export const style = 'text-[var(--abu-text-primary)]';\n`;
    expect(await messages(code, file)).not.toEqual([]);
  });

  it('checks the right panel files that finished migrating', async () => {
    const code = component('<div className="text-[var(--abu-text-primary)]" />');
    expect(await messages(code, 'src/components/panel/workspace/TabStrip.tsx')).not.toEqual([]);
    expect(await messages(code, 'src/components/preview/ImagePreview.tsx')).not.toEqual([]);
  });

  it('checks the settings files that finished migrating', async () => {
    const code = component('<div className="text-[var(--abu-text-primary)]" />');
    expect(await messages(code, 'src/components/settings/SystemSettingsDialog.tsx')).not.toEqual([]);
    expect(await messages(code, 'src/components/settings/sections/SandboxSection.tsx')).not.toEqual([]);
    expect(await messages(code, 'src/components/settings/sections/ai-services/AddProviderModal.tsx')).not.toEqual([]);
    expect(await messages(code, 'src/components/account/LoginPage.tsx')).not.toEqual([]);
    // The file that re-exports the sections holds no JSX: an icon imported past the design system shows it is checked.
    const reexport = "import { X } from 'lucide-react';\nexport { X };\n";
    expect(await messages(reexport, 'src/components/settings/sections/index.ts')).not.toEqual([]);
  });

  it('checks the shell shared by the extensions and experts pages', async () => {
    const code = component('<div className="text-[var(--abu-text-primary)]" />');
    for (const file of [
      'src/components/toolbox/TopTabNav.tsx',
      'src/components/toolbox/SourceSubNav.test.tsx',
      'src/components/toolbox/ToolCard.tsx',
      'src/components/toolbox/ToolGrid.test.tsx',
      'src/components/toolbox/SourceBadge.tsx',
      'src/components/common/AgentAvatar.tsx',
      'src/components/common/AvatarPicker.test.tsx',
      'src/components/common/PluginUpdateBadge.tsx',
      'src/components/team/TeamAvatar.tsx',
      'src/components/settings/ToolboxModal.tsx',
      'src/components/settings/ToolboxModal.sources.test.tsx',
    ]) {
      expect(await messages(code, file), file).not.toEqual([]);
    }
    const icon = "import { X } from 'lucide-react';\nexport { X };\n";
    expect(await messages(icon, 'src/components/toolbox/extensionSource.ts')).not.toEqual([]);
    // common/ and team/ have no directory entry: files that have not migrated stay on the old rules.
    expect(await messages(code, 'src/components/common/ConfirmDialog.tsx')).toEqual([]);
    expect(await messages(code, 'src/components/team/DialogShell.tsx')).toEqual([]);
  });

  it('checks every file of the plugins page, tests and helpers included', async () => {
    const code = component('<div className="text-[var(--abu-text-primary)]" />');
    for (const file of [
      'src/components/toolbox/plugins/PluginsTab.tsx',
      'src/components/toolbox/plugins/MarketplaceBrowser.test.tsx',
      'src/components/toolbox/plugins/InstallDisclosureDialog.tsx',
      'src/components/toolbox/plugins/UninstallPluginDialog.tsx',
      'src/components/toolbox/plugins/AddMarketplaceDialog.test.tsx',
      'src/components/toolbox/plugins/AppMarketDialog.tsx',
      'src/components/toolbox/plugins/NewFileOfThePage.tsx',
    ]) {
      expect(await messages(code, file), file).not.toEqual([]);
    }
    const icon = "import { X } from 'lucide-react';\nexport { X };\n";
    expect(await messages(icon, 'src/components/toolbox/plugins/serverCommand.ts')).not.toEqual([]);
    // The focus helper the card grids of the page share.
    expect(await messages(icon, 'src/components/toolbox/cardFocus.ts')).not.toEqual([]);
    expect(await messages(icon, 'src/components/toolbox/cardFocus.test.ts')).not.toEqual([]);
  });

  it('checks every file of the skills page, tests and helpers included', async () => {
    const code = component('<div className="text-[var(--abu-text-primary)]" />');
    for (const file of [
      'src/components/customize/SkillsSection.tsx',
      'src/components/customize/SkillsSection.test.tsx',
      'src/components/customize/SkillEditor.tsx',
      'src/components/customize/SkillEditor.nameCollision.test.tsx',
      'src/components/customize/SkillUploadModal.tsx',
      'src/components/customize/SkillHistoryModal.test.tsx',
      'src/components/customize/SkillDraftsPanel.tsx',
      'src/components/customize/SkillCategoryBlocksPanel.tsx',
      'src/components/toolbox/skills/SkillDetailPanel.tsx',
      'src/components/toolbox/skills/NewFileOfThePage.tsx',
    ]) {
      expect(await messages(code, file), file).not.toEqual([]);
    }
    const icon = "import { X } from 'lucide-react';\nexport { X };\n";
    expect(await messages(icon, 'src/components/customize/skillHistoryTime.ts')).not.toEqual([]);
    expect(await messages(icon, 'src/components/toolbox/skills/isSystemSkill.ts')).not.toEqual([]);
    // customize/ has no directory entry: the pages that migrate in later tasks and the unused files stay on the old rules.
    expect(await messages(code, 'src/components/customize/MCPSection.tsx')).toEqual([]);
    expect(await messages(code, 'src/components/customize/SkillDetailModal.tsx')).toEqual([]);
    expect(await messages(code, 'src/components/toolbox/connectors/connectorPrefill.tsx')).toEqual([]);
  });
});
