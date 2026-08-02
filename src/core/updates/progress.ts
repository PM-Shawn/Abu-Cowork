import type { UpdateDownloadProgress } from './types';

export interface UpdateProgressPresentation {
  indeterminate: boolean;
  percent: number | null;
  percentLabel: string | null;
}

/**
 * Turn updater byte counters into a stable UI presentation.
 *
 * Preparing, verification, and downloads without a known total deliberately
 * remain indeterminate: showing a static 0% would imply that the app is stuck.
 * Once a real total is available, one decimal place keeps slow large downloads
 * visibly moving without inventing a remaining-time estimate.
 */
export function getUpdateProgressPresentation(
  progress: UpdateDownloadProgress,
): UpdateProgressPresentation {
  if (progress.phase !== 'downloading' || progress.total <= 0) {
    return { indeterminate: true, percent: null, percentLabel: null };
  }

  const rawPercent = (progress.downloaded / progress.total) * 100;
  const percent = Number.isFinite(rawPercent)
    ? Math.min(100, Math.max(0, rawPercent))
    : 0;

  return {
    indeterminate: false,
    percent,
    percentLabel: percent >= 100 ? '100' : percent.toFixed(1),
  };
}
