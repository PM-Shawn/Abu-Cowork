export type PluginManifestErrorReason =
  | 'missing'
  | 'type'
  | 'range'
  | 'duplicate'
  | 'unknown-reference'
  | 'origin'
  | 'version'
  | 'unknown-field';

/** Thrown when a package field fails validation; `field` is the full path of the offending field. */
export class PluginManifestError extends Error {
  readonly field?: string;
  readonly reason?: PluginManifestErrorReason;
  constructor(message: string, field?: string, reason?: PluginManifestErrorReason);
}
