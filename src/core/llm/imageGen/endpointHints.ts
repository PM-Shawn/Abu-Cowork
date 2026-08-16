import type { ImageGenVendor } from '@/types/provider';
import { resolveImageVendor } from './vendorResolve';

/** The correct Volcengine Ark image-generation base URL, surfaced in user
 *  hints when a backend is misconfigured with a chat endpoint instead. */
export const VOLCENGINE_IMAGE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * True when an image-gen backend's baseUrl points at a Volcengine *chat*
 * endpoint (`/api/coding/...`) rather than the image-generation endpoint
 * (`/api/v3` or Agent Plan's `/api/plan/v3`). This is the exact shape the
 * V41 migration produced for users whose legacy `auxiliaryServices.imageGen`
 * held their chat coding endpoint — every generate_image call then 404s with
 * an empty body, which is undiagnosable without this check.
 *
 * `vendor` is the backend's stored vendor; 'custom'/undefined falls back to
 * baseUrl-host inference (same contract as {@link resolveImageVendor}), so
 * migrated backends that never had an explicit vendor still match.
 */
export function isVolcengineChatEndpoint(
  baseUrl: string | undefined | null,
  vendor?: ImageGenVendor,
): boolean {
  const url = (baseUrl ?? '').trim();
  if (!url) return false;
  if (resolveImageVendor(url, vendor) !== 'volcengine') return false;
  return /\/api\/coding(\/|$)/.test(url);
}
