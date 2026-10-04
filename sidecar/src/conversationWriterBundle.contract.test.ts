// @vitest-environment node

/**
 * Contract test: the conversation writer can be bundled into the sidecar.
 *  1. Its own import closure is pure: bundled with the sidecar's bundle-graph
 *     guard and WITHOUT the shim redirects, it reaches no `@tauri-apps/*`
 *     package and nothing under `src/stores` or `src/components`.
 *  2. The sidecar's instantiation of it bundles with the sidecar's real
 *     plugins, and the writer's files are in that bundle.
 */
import { describe, expect, it } from 'vitest';
import { build, type Plugin } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleGraphGuardPlugin, shimPlugin, SIDECAR_BUILD_RESOLUTION } from '../../scripts/build-sidecar.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function inputsOf(entry: string, plugins: Plugin[]): Promise<string[]> {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    ...SIDECAR_BUILD_RESOLUTION,
    plugins,
  });
  return Object.keys(result.metafile!.inputs).map((input) => input.split(path.sep).join('/'));
}

describe('the conversation writer is bundle-safe for the sidecar', () => {
  it('its own closure needs no shim and reaches nothing the guard bans', async () => {
    const inputs = await inputsOf('src/core/session/conversationWriter.ts', [bundleGraphGuardPlugin]);
    expect(inputs).toContain('src/core/session/conversationWriter.ts');
    expect(inputs).toContain('src/core/session/conversationPaths.ts');
    expect(inputs).toContain('src/core/session/ledgerLineSerializer.ts');
    expect(inputs.filter((i) => i.includes('node_modules/'))).toEqual([]);
    expect(inputs.filter((i) => i.startsWith('sidecar/'))).toEqual([]);
    expect(inputs.filter((i) => /^src\/(stores|components)\//.test(i))).toEqual([]);
  }, 60_000);

  it('the sidecar instantiation bundles with the sidecar plugins', async () => {
    const inputs = await inputsOf('sidecar/src/conversationWriterNode.ts', [shimPlugin, bundleGraphGuardPlugin]);
    expect(inputs).toContain('src/core/session/conversationWriter.ts');
    expect(inputs).toContain('sidecar/src/conversationFsNode.ts');
    expect(inputs).not.toContain('src/core/session/conversationStorage.ts');
    expect(inputs).not.toContain('src/core/session/conversationFsRenderer.ts');
  }, 60_000);

  it('the guard still bites: the renderer adapter cannot be bundled without shims', async () => {
    await expect(inputsOf('src/core/session/conversationFsRenderer.ts', [bundleGraphGuardPlugin])).rejects.toThrow(/Forbidden import/);
  }, 60_000);
});
