import { appDataDir } from '@tauri-apps/api/path';
import { exists, mkdir } from '@tauri-apps/plugin-fs';
import { isTauriEnv } from '../../utils/tauriEnv';
import { createConversationPaths, type ConversationPaths } from './conversationPaths';

let cachedPaths: ConversationPaths | null = null;

/**
 * Get the session output directory for a specific conversation.
 * Creates the directory if it doesn't exist.
 *
 * Returns null in web / E2E mode (no Tauri app data dir available).
 *
 * Directory structure (platform-dependent):
 * macOS: ~/Library/Application Support/com.abu.app/conversations/{id}/outputs/
 * Windows: %APPDATA%/com.abu.app/conversations/{id}/outputs/
 */
export async function getSessionOutputDir(conversationId: string): Promise<string | null> {
  if (!isTauriEnv()) return null; // web / E2E: no app data dir

  if (!cachedPaths) {
    cachedPaths = createConversationPaths(await appDataDir());
  }

  const outputDir = cachedPaths.outputsDir(conversationId);

  if (!(await exists(outputDir))) {
    await mkdir(outputDir, { recursive: true });
  }

  return outputDir;
}
