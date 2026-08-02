export interface UpdateInfo {
  version: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
}

export type UpdateDownloadPhase = 'preparing' | 'downloading' | 'verifying';

export interface UpdateDownloadProgress {
  phase: UpdateDownloadPhase;
  downloaded: number;
  total: number;
}
