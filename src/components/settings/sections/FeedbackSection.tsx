import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import wechatQr from '@/assets/wechat-qr.png';
import { useI18n } from '@/i18n';
import type { ProduceResult } from '@/core/diagnostic/bundle';
import DiagnosticUpload from './diagnostic/DiagnosticUpload';
import ExportSuccessCard from './diagnostic/ExportSuccessCard';

export default function FeedbackSection() {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [exportSuccess, setExportSuccess] = useState<ProduceResult | null>(null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-[var(--abu-clay-bg)] flex items-center justify-center shrink-0">
          <MessageCircle className="h-5 w-5 text-[var(--abu-clay)]" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <h2 className="text-[16px] font-semibold text-[var(--abu-text-primary)]">{t.about.feedback}</h2>
          <p className="text-[12px] text-[var(--abu-text-tertiary)] mt-0.5">{t.diagnostic.exportDesc}</p>
        </div>
      </div>

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
