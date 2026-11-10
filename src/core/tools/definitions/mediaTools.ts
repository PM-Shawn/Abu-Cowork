import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import type { ToolDefinition } from '../../../types';
import { joinPath, ensureParentDir } from '../../../utils/pathUtils';
import { getTauriFetch } from '../../llm/tauriFetch';
import { normalizeImageGenerationsUrl } from '../../llm/urlUtils';
import { buildImageRequest, parseImageResponse, resolveImageVendor, isVolcengineChatEndpoint, volcengineMaxReferenceImages, VOLCENGINE_IMAGE_BASE_URL } from '../../llm/imageGen';
import { getUsableImageBackend } from '../../../stores/settingsStore';
import { getSettingsReader } from '../../agent/ports/settingsReader';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { runFileOperationStage, type ToolFileAccess } from '@/core/tools/fileOperation';
import { uint8ArrayToBase64 } from '../../../utils/base64';
import { readFile as readBinFile } from '../fsBridge';

// `process_image` lives in its own file (P1-3d-5 slice 1) so the sidecar can
// register it locally without dragging in generateImageTool's store imports
// (getUsableImageBackend/useWorkspaceStore, above) — import it from
// `./processImageTool` directly.

// Seedream allows 30 MB per reference image, but a local file goes out as
// base64, which inflates it by a third, so cap the file well below that to keep
// the request body reasonable. The count limit depends on the model
// (volcengineMaxReferenceImages).
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

const REFERENCE_EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif',
};

/** The model may pass one string or an array; blanks are noise, not references. */
function parseReferenceImages(raw: unknown): string[] {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  return list.flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim()] : []));
}

/** URLs and inline data go to the backend as given; anything else is a local file. */
function isRemoteReference(entry: string): boolean {
  return /^(https?:\/\/|data:)/i.test(entry);
}

/** Magic bytes first: a file's extension says what it was named, not what it is. */
function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (offset: number, ...expected: number[]) => expected.every((byte, i) => bytes[offset + i] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'; // "GIF8"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'; // "RIFF"....."WEBP"
  if (at(0, 0x42, 0x4d)) return 'image/bmp'; // "BM"
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  // ISO base media: "ftyp" at byte 4, the brand right after it.
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'heic' || brand === 'heix') return 'image/heic';
    if (brand === 'mif1' || brand === 'heif') return 'image/heif';
  }
  return null;
}

/**
 * Turn the model's reference entries into what the backend accepts: URLs and
 * data URIs pass through, local files are read and inlined as data URIs. The
 * result is either the encoded list or a ready-to-return error text.
 */
async function encodeReferenceImages(
  entries: string[],
  files: ToolFileAccess | undefined,
): Promise<{ images: string[] } | { error: string }> {
  const tm = getI18n().toolResult.media;
  const images: string[] = [];
  for (const entry of entries) {
    if (isRemoteReference(entry)) {
      images.push(entry);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await runFileOperationStage(files, () => (files ? files.readFile(entry) : readBinFile(entry)));
    } catch (err) {
      return { error: format(tm.errRefRead, { path: entry, error: err instanceof Error ? err.message : String(err) }) };
    }
    if (bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
      return {
        error: format(tm.errRefTooLarge, {
          path: entry,
          sizeMb: (bytes.byteLength / 1024 / 1024).toFixed(1),
          maxMb: MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024,
        }),
      };
    }
    const extension = /\.([a-z0-9]+)$/i.exec(entry)?.[1].toLowerCase();
    const mime = sniffImageMime(bytes) ?? (extension ? REFERENCE_EXTENSION_MIME[extension] : undefined);
    if (!mime) return { error: format(tm.errRefUnsupportedType, { path: entry }) };
    images.push(`data:${mime};base64,${uint8ArrayToBase64(bytes)}`);
  }
  return { images };
}

export const generateImageTool: ToolDefinition = {
  name: TOOL_NAMES.GENERATE_IMAGE,
  description: 'Generate an image from a text description, using the default image-generation backend configured in Settings → Image Generation. Use when the user asks to generate photorealistic images, illustrations, logos, etc. Pass reference_images to edit, restyle, extend or combine existing images (image-to-image); reference images are only supported when the backend is Volcengine Seedream. For Seedream 5.0 the size should be one of 1K / 1.5K / 2K. For charts and data visualizations, output an HTML code block directly. Returns the saved image file path and displays the image inline.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image to generate' },
      size: { type: 'string', description: 'Optional image size — the accepted values depend on the backend (e.g. 1024x1024 or 2048x2048). For Seedream 5.0 pro/flash use 1K, 1.5K or 2K (default 2K) and describe the aspect ratio in the prompt. Omit to use the backend\'s own default.' },
      style: { type: 'string', description: 'Image style: vivid or natural (default: vivid)' },
      save_path: { type: 'string', description: 'Optional absolute path to save the image. If not provided, saves to Downloads folder.' },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional reference images (up to 10 for Seedream 5.0 pro/flash, up to 14 for 5.0 lite/4.5/4.0): absolute local file paths (under 20 MB each; compress or resize larger ones with process_image first) or http(s) URLs. Use when the user wants to edit, restyle, extend or combine existing images, including images the user attached (their file paths are given in the conversation) and images you generated earlier. The backend refers to them as image 1, image 2, ... in array order, so the prompt can say e.g. "put the product from image 1 into the scene of image 2". The prompt should describe the desired output, not repeat the reference.',
      },
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
    const referenceEntries = parseReferenceImages(input.reference_images);
    const files = context?.files;

    try {
      // Freeze the output before any generation request can start.
      let finalPath = savePath;
      if (!finalPath) {
        const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
        const baseDir = workspacePath || await downloadDir();
        finalPath = joinPath(baseDir, `abu-image-${Date.now()}.png`);
      }
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

      // Only the Volcengine mapper puts reference images on the wire; the other
      // vendors would silently drop them and return an unrelated picture, so
      // refuse before reading any file or calling the API.
      let referenceImages: string[] = [];
      if (referenceEntries.length > 0) {
        const tm = getI18n().toolResult.media;
        if (vendor !== 'volcengine') {
          return format(tm.errRefNotSupported, { vendor });
        }
        const maxReferences = volcengineMaxReferenceImages(modelId);
        if (referenceEntries.length > maxReferences) {
          return format(tm.errTooManyRefs, { max: maxReferences, count: referenceEntries.length });
        }
        const encoded = await encodeReferenceImages(referenceEntries, files);
        if ('error' in encoded) return encoded.error;
        referenceImages = encoded.images;
      }

      // Call image generation API via Tauri fetch (bypasses CORS)
      const fetchFn = await getTauriFetch();

      // Build request body via the per-vendor mapper (field names, size
      // normalization/snapping, and response_format quirks all differ by
      // vendor — see src/core/llm/imageGen/).
      const reqBody = buildImageRequest(vendor, { model: modelId, prompt, size, style, referenceImages, watermark: state.imageGeneration.watermark !== false });

      const response = await runFileOperationStage(files, () => fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(reqBody),
      }));

      if (!response.ok) {
        const errorText = await runFileOperationStage(files, () => response.text());
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

      const result = await runFileOperationStage(files, () => response.json());
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
        const imageResponse = await runFileOperationStage(files, () => fetchFn(parsed.url!));
        if (!imageResponse.ok) {
          return `Error downloading image: ${imageResponse.status}`;
        }
        bytes = new Uint8Array(await runFileOperationStage(files, () => imageResponse.arrayBuffer()));
      } else {
        return getI18n().toolResult.media.errNoImageData;
      }

      const io = files ?? { ensureParentDir, writeFile: writeBinFile };
      await io.ensureParentDir(finalPath);
      await io.writeFile(finalPath, bytes);

      const revisedPrompt = parsed.revisedPrompt;
      const tm = getI18n().toolResult.media;
      let msg = format(tm.imageSaved, { path: finalPath });
      if (revisedPrompt) {
        msg += format(tm.revisedPrompt, { prompt: revisedPrompt });
      }
      // After the first line on purpose: the preview card reads the saved path
      // up to the first newline.
      if (referenceImages.length > 0) {
        msg += format(tm.refsUsed, { count: referenceImages.length });
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
