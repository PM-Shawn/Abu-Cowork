/**
 * Diagnostic — types shared by the in-app self-test (online diagnostic) and
 * the diagnostic-bundle export.
 *
 * The two surfaces share `CheckResult` so the export bundle can carry the
 * latest online-diagnostic snapshot directly (PM-side: zip → snapshot.json
 * is the first thing you read).
 */

export type CheckCategory =
  | 'ai-services'
  | 'permissions'
  | 'mcp'
  | 'skills'
  | 'network'
  | 'app';

export type CheckStatus =
  /** Item is healthy. */
  | 'passed'
  /** Item is broken in a way that blocks the user from using something. */
  | 'failed'
  /** Item is not strictly broken but worth attention. */
  | 'warning'
  /** Item is not applicable in current setup (e.g. provider not enabled). */
  | 'skipped'
  /** Currently running. */
  | 'checking';

export interface SuggestedAction {
  /**
   * `open-settings` — deep-link into a system-settings tab.
   * `open-toolbox` — open the customize/toolbox modal (skills/MCP).
   * `retry` — re-run this single item.
   */
  type: 'open-settings' | 'open-toolbox' | 'retry';
  /** Tab identifier or modal target. Format depends on `type`. */
  target?: string;
  /** Button label (already i18n-resolved). */
  label: string;
}

export interface CheckResult {
  /** Stable id, format: `${category}:${subkey}` (e.g. `ai-services:anthropic-1`). */
  id: string;
  category: CheckCategory;
  /** User-visible name (already i18n-resolved). */
  name: string;
  status: CheckStatus;
  /** Short metric to render next to the name (e.g. "312ms", "12 个"). */
  metric?: string;
  /** One-line error explanation for the failed/warning state. */
  errorMessage?: string;
  /** Full error detail used by the "复制错误" button. */
  errorDetail?: string;
  /** Suggested user action to recover from a failure. */
  suggestedAction?: SuggestedAction;
  /** Epoch ms of the last completed check. 0 while still `checking`. */
  checkedAt: number;
  /** Wall time spent on this check in ms. */
  durationMs: number;
}

/** A `CheckResult` instance still in-flight (status === 'checking'). */
export type PendingCheck = Omit<CheckResult, 'status' | 'errorMessage' | 'errorDetail' | 'metric'> & {
  status: 'checking';
};

/** Aggregate verdict computed from all results. */
export type OverallStatus = 'all-passed' | 'has-warnings' | 'has-failures' | 'checking' | 'no-data';

/** Snapshot embedded inside the diagnostic-bundle zip. */
export interface DiagnosticSnapshot {
  schemaVersion: 1;
  takenAt: number;
  appVersion: string;
  bundleId: string;
  os: string;
  overall: OverallStatus;
  results: CheckResult[];
}
