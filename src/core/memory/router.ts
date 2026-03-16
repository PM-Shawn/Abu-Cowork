/**
 * Memory Router — selects the active memory backend.
 *
 * Currently uses LocalMemoryBackend.
 * Future: detect MCP memory servers (e.g., Mem0) and route to them.
 */

import type { MemoryBackend } from './types';
import { LocalMemoryBackend } from './localBackend';

let activeBackend: MemoryBackend | null = null;

/**
 * Get the active memory backend.
 * Returns LocalMemoryBackend by default.
 * Can be overridden for testing or future MCP-backed backends.
 */
export function getMemoryBackend(): MemoryBackend {
  if (!activeBackend) {
    activeBackend = new LocalMemoryBackend();
  }
  return activeBackend;
}

/**
 * Override the active backend (for testing or MCP integration).
 */
export function setMemoryBackend(backend: MemoryBackend): void {
  activeBackend = backend;
}
