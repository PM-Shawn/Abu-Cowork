import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Button, IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { StatusIcon } from '@/components/ds/status-icon';
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
      <div className="flex items-start gap-3 rounded-panel border border-separator p-4">
        <span className="flex h-5 shrink-0 items-center"><StatusIcon tone="success" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-label">{t.diagnostic.successTitle}</div>
          <div className="mt-1 select-text break-all font-code text-ui-sm text-label-secondary">{getBaseName(path)}</div>
          <div className="mt-1 text-caption text-label-secondary">
            {i18nFormat(t.diagnostic.successMeta, {
              size: formatBundleSize(sizeBytes),
              count: fileList.length,
              scrubbed: scrubbedTextCount,
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="plain" size="sm" icon={AppIcons.folderOpen} onClick={onShowInFinder}>
              {t.diagnostic.successOpenFinder}
            </Button>
            <Button variant="plain" size="sm" icon={pathCopied ? AppIcons.done : AppIcons.copy} onClick={onCopyPath}>
              {pathCopied ? t.diagnostic.pathCopied : t.diagnostic.successCopyPath}
            </Button>
            <Button variant="plain" size="sm" icon={AppIcons.file} onClick={() => setManifestOpen(true)}>
              {t.diagnostic.successManifest}
            </Button>
          </div>
        </div>
        <IconButton size="sm" icon={AppIcons.close} label={t.diagnostic.successDismiss} onClick={onDismiss} />
      </div>

      <BundleManifestModal
        open={manifestOpen}
        fileList={fileList}
        onClose={() => setManifestOpen(false)}
      />
    </>
  );
}
