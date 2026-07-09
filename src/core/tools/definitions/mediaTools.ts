import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition } from '../../../types';
import { isWindows } from '../../../utils/platform';
import { joinPath, ensureParentDir, getParentDir } from '../../../utils/pathUtils';
import { getTauriFetch } from '../../llm/tauriFetch';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import { useSettingsStore, getActiveApiKey, getActiveProvider } from '../../../stores/settingsStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  buildMacImageCommand,
  buildWindowsImageCommand,
  type CommandOutput,
} from '../helpers/toolHelpers';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

export const generateImageTool: ToolDefinition = {
  name: TOOL_NAMES.GENERATE_IMAGE,
  description: 'Generate an image from a text description (using DALL-E). Use when the user asks to generate photorealistic images, illustrations, logos, etc. For charts and data visualizations, output an HTML code block directly. Returns the saved image file path.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image to generate' },
      size: { type: 'string', description: 'Image size: 1024x1024, 1792x1024, or 1024x1792 (default: 1024x1024)' },
      style: { type: 'string', description: 'Image style: vivid or natural (default: vivid)' },
      save_path: { type: 'string', description: 'Optional absolute path to save the image. If not provided, saves to Downloads folder.' },
    },
    required: ['prompt'],
  },
  execute: async (input, context) => {
    const prompt = input.prompt as string;
    const size = (input.size as string) || '1024x1024';
    const style = (input.style as string) || 'vivid';
    const savePath = input.save_path as string | undefined;

    try {

      const state = useSettingsStore.getState();

      // Resolve API key: auxiliaryServices.imageGen > active provider key (if OpenAI-compatible)
      let apiKey = state.auxiliaryServices.imageGen?.apiKey ?? '';
      if (!apiKey) {
        const activeProvider = getActiveProvider(state);
        if (activeProvider?.apiFormat === 'openai-compatible') {
          apiKey = getActiveApiKey(state);
        }
      }
      if (!apiKey) {
        return 'Error: No API key configured for image generation. Please set an OpenAI API key in Settings → Image Generation, or configure an OpenAI provider.';
      }

      const model = state.auxiliaryServices.imageGen?.model || 'dall-e-3';

      // Resolve base URL: auxiliaryServices.imageGen.baseUrl > default OpenAI
      const baseUrl = (state.auxiliaryServices.imageGen?.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');

      // Call image generation API via Tauri fetch (bypasses CORS)
      const fetchFn = await getTauriFetch();

      // Build request body — only include params the model supports
      const reqBody: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      };
      // DALL-E 3 supports style, other models may not
      if (model.startsWith('dall-e-3')) {
        reqBody.style = style;
      }

      const response = await fetchFn(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return `Error generating image: ${response.status} ${errorText}`;
      }

      const result = await response.json() as {
        data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      };

      // Decode image data — prefer b64_json, fallback to URL download
      let bytes: Uint8Array;
      const b64Data = result.data?.[0]?.b64_json;
      if (b64Data) {
        const resp = await fetch(`data:image/png;base64,${b64Data}`);
        bytes = new Uint8Array(await resp.arrayBuffer());
      } else {
        const imageUrl = result.data?.[0]?.url;
        if (!imageUrl) {
          return getI18n().toolResult.media.errNoImageData;
        }
        const imageResponse = await fetchFn(imageUrl);
        if (!imageResponse.ok) {
          return `Error downloading image: ${imageResponse.status}`;
        }
        bytes = new Uint8Array(await imageResponse.arrayBuffer());
      }

      // Determine save path: explicit > workspace > downloads
      let finalPath = savePath;
      if (!finalPath) {
        const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
        const baseDir = workspacePath || await downloadDir();
        const timestamp = Date.now();
        finalPath = joinPath(baseDir, `abu-image-${timestamp}.png`);
      }

      await ensureParentDir(finalPath);
      await writeBinFile(finalPath, bytes);

      const revisedPrompt = result.data?.[0]?.revised_prompt;
      const tm = getI18n().toolResult.media;
      let msg = format(tm.imageSaved, { path: finalPath });
      if (revisedPrompt) {
        msg += format(tm.revisedPrompt, { prompt: revisedPrompt });
      }
      return msg;
    } catch (err) {
      return `Error generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: false,
};

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
  execute: async (input) => {
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
        return `Error: Unsupported action "${action}". Use one of: ${validActions.join(', ')}`;
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
      const output = await invoke<CommandOutput>('run_shell_command', {
        command,
        cwd: null,
        background: false,
        timeout: 30,
        sandboxEnabled: isSandboxEnabled(),
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths: outputDir ? [outputDir] : [],
      });

      console.log('[process_image] exit code:', output.code, 'stdout:', output.stdout, 'stderr:', output.stderr);

      if (output.code !== 0) {
        return `Error processing image: ${output.stderr || output.stdout}`;
      }

      return `Image processed successfully: ${outputPath}`;
    } catch (err) {
      return `Error processing image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: false,
};
