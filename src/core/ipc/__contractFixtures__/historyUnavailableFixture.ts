/** The rejected-start payload both tiers pin. Numbers only: no path, no content. */
export const HISTORY_UNAVAILABLE_CONTRACT_FIXTURE = {
  code: 'history_unavailable',
  reason: 'watermark_beyond_file',
  uptoBytes: 4096,
  fileBytes: 1024,
} as const;
