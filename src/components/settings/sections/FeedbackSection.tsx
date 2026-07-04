import { useState } from 'react';
import wechatQr from '@/assets/wechat-qr.png';
import { useI18n } from '@/i18n';
import type { ProduceResult } from '@/core/diagnostic/bundle';
import DiagnosticUpload from './diagnostic/DiagnosticUpload';
import ExportSuccessCard from './diagnostic/ExportSuccessCard';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';

export default function FeedbackSection() {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [exportSuccess, setExportSuccess] = useState<ProduceResult | null>(null);

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.about.feedback} description={t.diagnostic.exportDesc} />

      {/* Upload form */}
      <DiagnosticUpload
        onExportSuccess={setExportSuccess}
        description={description}
        onDescriptionChange={setDescription}
      />
      {exportSuccess && (
        <ExportSuccessCard
          path={exportSuccess.path}
          sizeBytes={exportSuccess.sizeBytes}
          scrubbedTextCount={exportSuccess.scrubbedTextCount}
          fileList={exportSuccess.fileList}
          onDismiss={() => setExportSuccess(null)}
        />
      )}

      {/* WeChat QR */}
      <div className="pt-2 border-t border-[var(--abu-border)] flex flex-col items-center text-center gap-2">
        <p className="text-[12px] font-medium text-[var(--abu-text-secondary)]">{t.about.wechatSectionTitle}</p>
        <img src={wechatQr} alt="WeChat QR" className="w-36 h-36 rounded-xl shadow-sm" />
        <p className="text-[11px] text-[var(--abu-text-tertiary)]">{t.about.feedbackDesc}</p>
      </div>
    </div>
  );
}
