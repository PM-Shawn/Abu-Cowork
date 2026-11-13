/**
 * The one rule for fitting a picture at entry (composer attachment, read_file):
 * what to re-encode it to so no route rejects it, derived from the route table
 * in imagePolicy.ts.
 *
 * Two limits apply together and either one triggers a fit:
 * - the pixel side: the strictest `maxDimension` of any route, because the route
 *   is not known when a picture enters and it is re-sent for the rest of the
 *   conversation (`admissionMaxDimension`);
 * - the bytes of the encoded picture: the strictest `maxImageBytes` (Anthropic
 *   refuses a picture over 5 MB, Bedrock-served Claude included), as raw bytes.
 *
 * This file only decides; the two encoders that carry it out are the renderer's
 * canvas (`fitImageToDimension`, composer) and the native `fit-width` operation
 * (read_file, in the sidecar). A step is tried in order and the first result
 * under the byte limit wins:
 *   1. the long side at the limit, in the picture's own format (a JPEG stays a
 *      JPEG: PNG of a photograph is several times larger);
 *   2. the same size as a JPEG (the only way to shrink a PNG that is large
 *      because it is a photograph; transparency is lost, which is why it is not
 *      the first step);
 *   3. and 4. a JPEG at 70% and then 50% of that size.
 * A picture no step brings under the limits is left as it is: the send-time
 * check (imageAcceptance.ts) then judges it against the route and, if the route
 * would refuse it, replaces it with a note, so nothing wedges the session.
 */

import { admissionMaxDimension, admissionMaxImageBytes } from './imagePolicy';

export interface FitStep {
  /** Target width in px; the height follows the aspect ratio. */
  width: number;
  /** `same`: the picture's own format where the encoder can write it (JPEG stays JPEG; others PNG or, on canvas, WebP). */
  format: 'same' | 'jpeg';
  /** JPEG quality, 1-100 (also used for `same` when the picture is a JPEG). */
  quality: number;
}

export interface FitLimits {
  maxDimension: number;
  /** Raw (not base64) bytes of the encoded picture. */
  maxBytes: number;
}

/**
 * Raw bytes of a picture whose base64 form is within the strictest per-picture
 * ceiling (base64 is 4 characters per 3 bytes, so a 5 MiB ceiling is 3.75 MiB raw).
 */
export function admissionRawBytes(): number {
  return Math.floor(admissionMaxImageBytes() / 4) * 3;
}

export function planImageFit(
  picture: { width: number; height: number; byteLength: number; mediaType: string },
  limits: FitLimits = { maxDimension: admissionMaxDimension(), maxBytes: admissionRawBytes() },
): FitStep[] {
  const { width, height, byteLength, mediaType } = picture;
  const side = Math.max(width, height);
  const overSide = Number.isFinite(limits.maxDimension) && limits.maxDimension > 0 && side > limits.maxDimension;
  const overBytes = Number.isFinite(limits.maxBytes) && limits.maxBytes > 0 && byteLength > limits.maxBytes;
  if (!overSide && !overBytes) return [];

  const base = overSide ? limits.maxDimension : side;
  const widthAt = (factor: number) => Math.max(1, Math.floor(width * base * factor / side));
  const steps: FitStep[] = [];
  // Re-encoding the same pixels in a lossless format cannot shrink the file: when only the
  // bytes are over, the first useful step for anything but a JPEG is already a JPEG.
  if (overSide || mediaType === 'image/jpeg') steps.push({ width: widthAt(1), format: 'same', quality: 85 });
  steps.push({ width: widthAt(1), format: 'jpeg', quality: 75 });
  steps.push({ width: widthAt(0.7), format: 'jpeg', quality: 70 });
  steps.push({ width: widthAt(0.5), format: 'jpeg', quality: 70 });
  return steps.filter((step, i) => i === 0 || step.width < steps[i - 1].width || step.format !== steps[i - 1].format
    || step.quality !== steps[i - 1].quality);
}
