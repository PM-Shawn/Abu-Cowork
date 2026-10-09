import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { useI18n } from '@/i18n';

interface Props {
  open: boolean;
  fileList: string[];
  onClose: () => void;
}

export default function BundleManifestModal({ open, fileList, onClose }: Props) {
  const { t } = useI18n();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={t.diagnostic.manifestTitle}
      size="md"
      closeButton
      footer={<Button variant="secondary" onClick={onClose}>{t.diagnostic.manifestClose}</Button>}
    >
      <ul className="divide-y divide-separator rounded-control border border-separator">
        {fileList.map((f) => (
          <li key={f} className="flex items-center gap-2 px-3 py-2 font-code text-ui-sm text-label">
            <Icon icon={AppIcons.file} size="sm" className="text-label-tertiary" />
            <span className="truncate">{f}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
