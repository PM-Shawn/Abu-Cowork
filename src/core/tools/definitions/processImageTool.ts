import type { ToolDefinition } from '../../../types';
import { getI18n, format } from '../../../i18n';
import { isWindows } from '../../../utils/platform';
import { ensureParentDir, getParentDir } from '../../../utils/pathUtils';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import {
  buildMacImageCommand,
  buildWindowsImageCommand,
  type CommandOutput,
} from '../helpers/toolHelpers';
import { invokeTaskCommand } from '../helpers/scopedCommand';
import { TOOL_NAMES } from '../toolNames';

/**
 * `process_image` — extracted from `mediaTools.ts` (P1-3d-5 slice 1,
 * docs/2026-07-21-phase1-p3d-tool-migration-design.md) into its own file so
 * it can be registered in `sidecar/src/localTools/index.ts` without dragging
 * in `generateImageTool`'s store imports (`getUsableImageBackend` from
 * `stores/settingsStore`, `useWorkspaceStore`) — both forbidden inside the
 * sidecar bundle by `bundleGraphGuardPlugin` (`scripts/build-sidecar.mjs`).
 *
 * `execute()` itself is unchanged: no store, no toast, no i18n — every
 * dependency here is either a pure helper (`pathUtils`, `platform`,
 * `toolHelpers`'s command builders) or already bundle-safe via an existing
 * sidecar shim (`invoke` → `shims/tauriCoreInvokeRun.ts`; `sandbox/config`'s
 * `isSandboxEnabled`/`isNetworkIsolationEnabled` → the already-shimmed
 * settings reader, same as `search_files`/`find_files` already use).
 *
 * The actual command spawn still reverses to Rust via
 * `invoke('run_shell_command', ...)` — that's expected: only the JS-side
 * `execute()` dispatch moves local, not the sandboxed process spawn itself.
 */
export const processImageTool: ToolDefinition = {
  name: TOOL_NAMES.PROCESS_IMAGE,
  description: 'Process an image file: resize, crop, convert format, or compress. Use when the user needs to adjust image dimensions, convert formats, etc. Returns the path of the processed file.',
  inputSchema: {
    type: 'object',
    properties: {
      input_path: { type: 'string', description: 'Absolute path to the input image file' },
      output_path: { type: 'string', description: 'Absolute path for the output image file' },
      action: { type: 'string', description: 'Action to perform: resize, crop, convert, or compress', enum: ['resize', 'crop', 'convert', 'compress'] },
      width: { type: 'number', description: 'Target width in pixels (for resize and crop)' },
      height: { type: 'number', description: 'Target height in pixels (for resize and crop)' },
      x: { type: 'number', description: 'X offset for crop (default 0)' },
      y: { type: 'number', description: 'Y offset for crop (default 0)' },
      format: { type: 'string', description: 'Target format for convert (png, jpeg, gif, bmp, tiff)' },
      quality: { type: 'number', description: 'Quality 1-100 for compress (default 80)' },
    },
    required: ['input_path', 'output_path', 'action'],
  },
  execute: async (input, context) => {
    const inputPath = input.input_path as string;
    const outputPath = input.output_path as string;
    const action = input.action as string;
    // Merge top-level params with nested params object (top-level takes priority)
    const nested = (input.params as Record<string, unknown>) || {};
    const params: Record<string, unknown> = {
      ...nested,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
    };

    try {
      const validActions = processImageTool.inputSchema.properties.action.enum!;
      if (!validActions.includes(action)) {
        return format(getI18n().toolResult.media.errUnsupportedAction, {
          action,
          valid: validActions.join(', '),
        });
      }

      await ensureParentDir(outputPath);

      let command: string;

      if (isWindows()) {
        // Windows: use PowerShell + System.Drawing
        command = buildWindowsImageCommand(inputPath, outputPath, action, params);
      } else {
        // macOS/Linux: use sips (macOS built-in)
        command = buildMacImageCommand(inputPath, outputPath, action, params);
      }

      console.log('[process_image] command:', command);

      // outputPath's parent directory needs write access in sandbox
      const outputDir = getParentDir(outputPath);
      const output = await invokeTaskCommand<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 30,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: outputDir ? [outputDir] : [],
      }, context, { commandIdPrefix: 'process-image' });

      console.log('[process_image] exit code:', output.code, 'stdout:', output.stdout, 'stderr:', output.stderr);

      if (output.code !== 0) {
        return format(getI18n().toolResult.media.errProcessImage, {
          error: output.stderr || output.stdout,
        });
      }

      return format(getI18n().toolResult.media.imageProcessed, { path: outputPath });
    } catch (err) {
      return format(getI18n().toolResult.media.errProcessImage, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  isConcurrencySafe: false,
};
