/**
 * The `reference_images` argument of `generate_image`, parsed in one place so
 * the permission check, the host file plan and the tool itself agree on which
 * entries are local files.
 */

/** The model may pass one string or an array; blanks are noise, not references. */
export function parseReferenceImages(raw: unknown): string[] {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  return list.flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim()] : []));
}

/** URLs and inline data go to the backend as given; anything else is a local file. */
export function isRemoteReference(entry: string): boolean {
  return /^(https?:\/\/|data:)/i.test(entry);
}

/** The entries that name local files, in the order the model gave them. */
export function localReferenceImages(raw: unknown): string[] {
  return parseReferenceImages(raw).filter((entry) => !isRemoteReference(entry));
}
