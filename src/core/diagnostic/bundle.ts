/**
 * Bundle producer — takes the file map from `collect.ts`, zips it with
 * fflate, writes the resulting bytes to disk via Tauri fs, and returns the
 * absolute output path.
 *
 * Output location: `~/Downloads/Abu-Diagnostic/abu-diagnostic-{shortId}-{ts}.zip`
 * (creates the directory if missing). We write into the user's Downloads
 * folder rather than appData so the file is easy to attach in any
 * upload/email flow without further finder navigation.
 */

import { zipSync, strToU8 } from 'fflate';
import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { collectBundleFiles, resolveConversationIds } from './collect';
import { useChatStore } from '@/stores/chatStore';

interface ProduceOptions {
  includeRawText: boolean;
  /** Legacy single-id form. Prefer `conversationIds`. See collect.ts. */
  conversationId?: string | null;
  /** Conversation IDs to embed (multi-select). Takes priority over `conversationId`. */
  conversationIds?: string[];
  /** Cap embedded messages to the most-recent N (or 'all'). See collect.ts. */
  messageCap?: number | 'all';
  /** Free-text user description, written verbatim into the bundle. */
  description?: string;
  /** Screenshots to embed as binary entries under feedback/screenshots/. */
  screenshots?: { name: string; bytes: Uint8Array }[];
}

export interface ProduceResult {
  /** Absolute path on disk. */
  path: string;
  /** Compressed bundle size in bytes. */
  sizeBytes: number;
  /** How many text fields were redacted/replaced (for the success card). */
  scrubbedTextCount: number;
  /** Filenames inside the zip for the manifest modal. */
  fileList: string[];
}

function fmtTimestampForFilename(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

interface ZipResult {
  bytes: Uint8Array;
  filename: string;
  scrubbedTextCount: number;
  fileList: string[];
}

/** Collect, scrub, and compress — without writing to disk. */
export async function collectAndZip(opts: ProduceOptions): Promise<ZipResult> {
  // Determine the ids actually in play, purely to derive a readable filename
  // — collect.ts (via the same resolveConversationIds) is still the source
  // of truth for what actually gets embedded. Sharing the resolver (instead
  // of re-deriving it here) keeps the filename's id set and the bundle's
  // actual content in lockstep — a prior drift here meant a bundle could be
  // named after the active conversation while containing none of it.
  const ids = resolveConversationIds(opts, useChatStore.getState().activeConversationId);

  const shortId =
    ids.length === 0 ? 'global' : ids.length === 1 ? ids[0].slice(0, 8) : `multi-${ids.length}`;
  const filename = `abu-diagnostic-${shortId}-${fmtTimestampForFilename(new Date())}.zip`;

  const { files, scrubbedTextCount } = await collectBundleFiles(opts);

  const zipInput: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    zipInput[name] = typeof content === 'string' ? strToU8(content) : content;
  }

  const bytes = zipSync(zipInput, { level: 6 });
  return { bytes, filename, scrubbedTextCount, fileList: Object.keys(files).sort() };
}

export async function produceBundle(opts: ProduceOptions): Promise<ProduceResult> {
  const { bytes, filename, scrubbedTextCount, fileList } = await collectAndZip(opts);

  const dlDir = await downloadDir();
  const outDir = joinPath(dlDir, 'Abu-Diagnostic');
  if (!(await exists(outDir))) {
    await mkdir(outDir, { recursive: true });
  }
  const outPath = joinPath(outDir, filename);
  await writeFile(outPath, bytes);

  return {
    path: outPath,
    sizeBytes: bytes.byteLength,
    scrubbedTextCount,
    fileList,
  };
}

/** Format a byte count for the success card / manifest modal. */
export function formatBundleSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
