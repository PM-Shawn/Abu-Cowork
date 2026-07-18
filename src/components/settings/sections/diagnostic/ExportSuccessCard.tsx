import { CheckCircle2, FolderOpen, Copy, FileText, X, Check } from 'lucide-react';
import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n, format as i18nFormat } from '@/i18n';
import { formatBundleSize } from '@/core/diagnostic/bundle';
import { getBaseName } from '@/utils/pathUtils';
import BundleManifestModal from './BundleManifestModal';

interface Props {
  path: string;
  sizeBytes: number;
  scrubbedTextCount: number;
  fileList: string[];
  onDismiss: () => void;
}

export default function ExportSuccessCard({ path, sizeBytes, scrubbedTextCount, fileList, onDismiss }: Props) {
  const { t } = useI18n();
  const [pathCopied, setPathCopied] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);

  const onShowInFinder = async () => {
    try { await revealItemInDir(path); } catch { /* ignore */ }
  };

  const onCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <>
      <div className="rounded-lg border border-[var(--abu-success)] bg-[var(--abu-success-bg)] p-4 flex items-start gap-3">
        <CheckCircle2 className="h-5 w-5 text-[var(--abu-success)] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-h-sm font-medium text-[var(--abu-success)]">{t.diagnostic.successTitle}</div>
          <div className="text-minor font-mono text-[var(--abu-success)] mt-0.5 break-all">{getBaseName(path)}</div>
          <div className="text-caption text-[var(--abu-success)] mt-0.5">
            {i18nFormat(t.diagnostic.successMeta, {
              size: formatBundleSize(sizeBytes),
              count: fileList.length,
              scrubbed: scrubbedTextCount,
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              onClick={onShowInFinder}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-caption font-medium bg-white border border-[var(--abu-success)] text-[var(--abu-success)] hover:bg-[var(--abu-success-bg)] transition-colors"
            >
              <FolderOpen className="h-3 w-3" />
              {t.diagnostic.successOpenFinder}
            </button>
            <button
              onClick={onCopyPath}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-caption font-medium bg-white border border-[var(--abu-success)] text-[var(--abu-success)] hover:bg-[var(--abu-success-bg)] transition-colors"
            >
              {pathCopied ? <Check className="h-3 w-3 text-[var(--abu-success)]" /> : <Copy className="h-3 w-3" />}
              {pathCopied ? t.diagnostic.pathCopied : t.diagnostic.successCopyPath}
            </button>
            <button
              onClick={() => setManifestOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-caption font-medium bg-white border border-[var(--abu-success)] text-[var(--abu-success)] hover:bg-[var(--abu-success-bg)] transition-colors"
            >
              <FileText className="h-3 w-3" />
              {t.diagnostic.successManifest}
            </button>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="p-1 rounded-md text-[var(--abu-success)] hover:text-[var(--abu-success)] hover:bg-[var(--abu-success-bg)] transition-colors"
          aria-label={t.diagnostic.successDismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <BundleManifestModal
        open={manifestOpen}
        fileList={fileList}
        onClose={() => setManifestOpen(false)}
      />
    </>
  );
}
