import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import type { ToolDefinition } from '../../../types';
import { joinPath, ensureParentDir } from '../../../utils/pathUtils';
import { getTauriFetch } from '../../llm/tauriFetch';
import { normalizeImageGenerationsUrl } from '../../llm/urlUtils';
import { buildImageRequest, parseImageResponse, resolveImageVendor, isVolcengineChatEndpoint, VOLCENGINE_IMAGE_BASE_URL } from '../../llm/imageGen';
import { getUsableImageBackend } from '../../../stores/settingsStore';
import { getSettingsReader } from '../../agent/ports/settingsReader';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

// `process_image` lives in its own file (P1-3d-5 slice 1) so the sidecar can
// register it locally without dragging in generateImageTool's store imports
// (getUsableImageBackend/useWorkspaceStore, above) — import it from
// `./processImageTool` directly.

export const generateImageTool: ToolDefinition = {
  name: TOOL_NAMES.GENERATE_IMAGE,
  description: 'Generate an image from a text description, using the default image-generation backend configured in Settings → Image Generation. Use when the user asks to generate photorealistic images, illustrations, logos, etc. For charts and data visualizations, output an HTML code block directly. Returns the saved image file path and displays the image inline.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image to generate' },
      size: { type: 'string', description: 'Optional image size — the accepted values depend on the backend (e.g. 1024x1024 or 2048x2048). Omit to use the backend\'s own default.' },
      style: { type: 'string', description: 'Image style: vivid or natural (default: vivid)' },
      save_path: { type: 'string', description: 'Optional absolute path to save the image. If not provided, saves to Downloads folder.' },
    },
    required: ['prompt'],
  },
  execute: async (input, context) => {
    const prompt = input.prompt as string;
    // No hardcoded default here — an empty/omitted size lets the per-vendor
    // request builder decide (see imageGen/vendors/openai.ts, which restores
    // the pre-refactor 1024x1024 default for the openai/custom shape only).
    // Some backends (e.g. Seedream) require a minimum pixel count
    // (>=3686400px) well above 1024x1024 and reject that value outright, so
    // volcengine's builder applies its own floor (normalizeSeedreamSize)
    // instead of inheriting a size default meant for OpenAI-shape backends.
    const size = input.size as string | undefined;
    const style = (input.style as string) || 'vivid';
    const savePath = input.save_path as string | undefined;

    try {
      const state = getSettingsReader().getSnapshot();

      // Resolve the image-generation backend from the independent
      // imageGeneration config (design doc §3.1, "C-a") — fully decoupled
      // from chat providers/models, since a backend's endpoint may live on a
      // different base path than any chat provider (e.g. Volcengine Agent
      // Plan's /api/plan/v3 vs the chat endpoint /api/coding/v3).
      // getUsableImageBackend adds a zero-config fallback on top of an
      // explicitly-configured backend: if the user never added one in
      // Settings → Image Generation but their active chat provider is
      // OpenAI-compatible, it synthesizes a DALL-E 3 backend from that
      // provider's API key (restores pre-refactor zero-config behavior).
      const backend = getUsableImageBackend(state);
      if (!backend) {
        return getI18n().toolResult.media.errNoImageBackend;
      }
      const apiKey = backend.apiKey;
      const modelId = backend.model;

      // Build the endpoint idempotently: users paste EITHER the bare base
      // (`.../api/v3`) OR the full endpoint (`.../api/v3/images/generations`,
      // exactly as Volcengine's docs present it). normalizeImageGenerationsUrl
      // strips any trailing /images/generations before re-appending, and keeps a
      // version segment (/api/v3, /v1) intact — so both inputs resolve correctly
      // instead of doubling into .../images/generations/v1/images/generations.
      const endpoint = normalizeImageGenerationsUrl(backend.baseUrl);

      // Trust the backend's own stored vendor when the user (or a migration
      // that could infer it) has set one; otherwise fall back to baseUrl-host
      // inference. See imageGen/vendorResolve.ts.
      const vendor = resolveImageVendor(backend.baseUrl, backend.vendor);

      // Call image generation API via Tauri fetch (bypasses CORS)
      const fetchFn = await getTauriFetch();

      // Build request body via the per-vendor mapper (field names, size
      // normalization/snapping, and response_format quirks all differ by
      // vendor — see src/core/llm/imageGen/).
      const reqBody = buildImageRequest(vendor, { model: modelId, prompt, size, style });

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(reqBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let msg = `Error generating image: ${response.status} ${errorText}`;
        const tm = getI18n().toolResult.media;
        // Misconfiguration hints: a chat endpoint (or wrong model) yields a
        // bare "404 " with an empty body — undiagnosable for both the model
        // and the user without pointing at the actual setting to fix. The
        // V41-migrated Volcengine chat endpoint is detected explicitly; other
        // 404/401s get the generic "check baseUrl/model/key" nudge.
        if (isVolcengineChatEndpoint(backend.baseUrl, backend.vendor)) {
          msg += `\n${format(tm.hintVolcChatEndpoint, { url: VOLCENGINE_IMAGE_BASE_URL })}`;
        } else if (response.status === 404 || response.status === 401) {
          msg += `\n${tm.hintCheckImageBackend}`;
        }
        return msg;
      }

      const result = await response.json();
      // Normalize the response envelope via the per-vendor parser —
      // SiliconFlow returns `images[]` instead of OpenAI/Volcengine/Zhipu's
      // `data[]`, so this can't be a single fixed shape.
      const parsed = parseImageResponse(vendor, result);

      // Decode image data — prefer b64_json, fallback to URL download.
      // Decode base64 with atob() rather than fetch(`data:...`): the app's CSP
      // lists `data:` under img-src/font-src but NOT connect-src, and a fetch()
      // of a data: URL is governed by connect-src — so in the packaged WKWebView
      // build it is blocked and rejects with `TypeError: Load failed` (verified
      // in WebKit). atob() is a pure-JS decode that touches no network stack, so
      // it is unaffected by CSP (and faster). This is the whole reason b64_json
      // backends — Volcengine Seedream (always b64) and OpenAI gpt-image-1 —
      // failed to generate while URL-returning backends worked.
      let bytes: Uint8Array;
      if (parsed.b64) {
        const bin = atob(parsed.b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else if (parsed.url) {
        const imageResponse = await fetchFn(parsed.url);
        if (!imageResponse.ok) {
          return `Error downloading image: ${imageResponse.status}`;
        }
        bytes = new Uint8Array(await imageResponse.arrayBuffer());
      } else {
        return getI18n().toolResult.media.errNoImageData;
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

      const revisedPrompt = parsed.revisedPrompt;
      const tm = getI18n().toolResult.media;
      let msg = format(tm.imageSaved, { path: finalPath });
      if (revisedPrompt) {
        msg += format(tm.revisedPrompt, { prompt: revisedPrompt });
      }

      // Return just the text summary. The saved file already renders inline as
      // a rich ImagePreviewCard (filename + real dimensions + preview + reveal),
      // driven by workflowExtractor matching this "图片已保存到: <path>" text —
      // a pre-existing path that covers both workspace and Downloads. Returning
      // an extra base64 image block here would (a) double the image in the
      // conversation and (b) push the full 2048×2048 base64 into the LLM
      // context. So text only.
      return msg;
    } catch (err) {
      return `Error generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: false,
};
