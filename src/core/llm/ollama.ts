/**
 * Ollama Service Client
 *
 * Handles health checks and model discovery for local Ollama instances.
 * Uses tauriFetch to bypass CORS restrictions in Tauri WebView.
 */

import { getTauriFetch } from './tauriFetch';

// ── Types ──────────────────────────────────────────────────────────

export interface OllamaModelDetails {
  parent_model: string;
  format: string;
  family: string;
  parameter_size: string;
  quantization_level: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: OllamaModelDetails;
}

export interface OllamaTagsResponse {
  models: OllamaModel[];
}

export type OllamaStatus = 'unknown' | 'checking' | 'online' | 'offline';

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const HEALTH_CHECK_TIMEOUT = 5000;   // 5s for health check
const MODEL_LIST_TIMEOUT = 10000;    // 10s for model list

// ── API Functions ──────────────────────────────────────────────────

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export interface OllamaHealthResult {
  ok: boolean;
  error?: string;
}

/**
 * Check if Ollama service is running.
 * Pings the root endpoint — returns 200 with "Ollama is running" if alive.
 */
export async function checkOllamaHealth(baseUrl = DEFAULT_OLLAMA_URL): Promise<OllamaHealthResult> {
  try {
    const fetchFn = await getTauriFetch();
    const res = await withTimeout(fetchFn(baseUrl), HEALTH_CHECK_TIMEOUT);
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Ollama] Health check failed:', err);
    return { ok: false, error: msg };
  }
}

/**
 * Fetch locally installed models from Ollama.
 * Calls GET /api/tags which returns all pulled models with metadata.
 */
export async function fetchOllamaModels(baseUrl = DEFAULT_OLLAMA_URL): Promise<OllamaModel[]> {
  const fetchFn = await getTauriFetch();
  const res = await withTimeout(
    fetchFn(`${baseUrl}/api/tags`),
    MODEL_LIST_TIMEOUT
  );

  if (!res.ok) {
    throw new Error(`Ollama /api/tags returned ${res.status}`);
  }

  const data = (await res.json()) as OllamaTagsResponse;
  return data.models ?? [];
}

// ── Helpers ────────────────────────────────────────────────────────

/** Format file size to human-readable string (e.g. "4.7 GB") */
export function formatModelSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

/**
 * Build a display label for an Ollama model.
 * e.g. "gemma3:27b" → "gemma3:27b (27B, Q4_K_M)"
 */
export function formatOllamaModelLabel(model: OllamaModel): string {
  const parts: string[] = [];
  if (model.details.parameter_size) parts.push(model.details.parameter_size);
  if (model.details.quantization_level) parts.push(model.details.quantization_level);
  return parts.length > 0 ? `${model.name} (${parts.join(', ')})` : model.name;
}
