/**
 * The sidecar's instantiation of the shared conversation writer
 * (`src/core/session/conversationWriter.ts`) over `node:fs`.
 *
 * No catalog bump is wired: the catalog lives in the Electron main process
 * and is reindexed from the ledger. The output manifest is the sidecar's own
 * copy of `outputSnapshots.ts`, which reads the same files the renderer's does.
 */
import {
  createConversationWriter,
  type ConversationWriter,
  type ConversationWriterCapabilities,
} from '@/core/session/conversationWriter';
import { findToolResultImageSnapshot, refreshOutputManifest } from '@/core/session/outputSnapshots';
import { createNodeConversationFs } from './conversationFsNode';

export interface NodeConversationWriterOptions {
  appDataDir: string;
  appVersion: string;
  capabilities: ConversationWriterCapabilities;
  trace(event: string, attributes: Record<string, unknown>): void;
  now?: () => number;
  randomSuffix?: () => string;
}

/** The string `runtimeErrorType` produces; that module imports the renderer bridge and stays out of the sidecar. */
function errorType(err: unknown): string {
  const raw = err instanceof Error ? err.name : typeof err;
  return raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80) || 'unknown';
}

export function createNodeConversationWriter(options: NodeConversationWriterOptions): ConversationWriter {
  return createConversationWriter({
    fs: createNodeConversationFs(),
    env: {
      appDataDir: async () => options.appDataDir,
      appVersion: options.appVersion,
      now: options.now ?? (() => Date.now()),
      randomSuffix: options.randomSuffix ?? (() => Math.random().toString(36).substring(2, 8)),
      trace: options.trace,
      errorType,
      outputManifest: { refresh: refreshOutputManifest, findToolResultImageSnapshot },
    },
    capabilities: options.capabilities,
  });
}
