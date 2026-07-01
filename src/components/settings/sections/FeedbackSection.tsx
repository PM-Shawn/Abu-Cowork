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
    <div className="space-y-6 max-w-lg">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[var(--abu-clay-bg)] flex items-center justify-center shrink-0">
          <MessageCircle className="h-5 w-5 text-[var(--abu-clay)]" />
        </div>
        <div>
          <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)]">{t.about.feedback}</h3>
        </div>
      </div>

      {/* Diagnostic upload + description */}
      <DiagnosticUpload
        onExportSuccess={setExportSuccess}
        description={description}
        onDescriptionChange={setDescription}
      />

      {/* Export success card */}
      {exportSuccess && (
        <ExportSuccessCard
          path={exportSuccess.path}
          sizeBytes={exportSuccess.sizeBytes}
          scrubbedTextCount={exportSuccess.scrubbedTextCount}
          fileList={exportSuccess.fileList}
          onDismiss={() => setExportSuccess(null)}
        />
      )}

      {/* Divider */}
      <div className="border-t border-[var(--abu-border)]" />

      {/* WeChat QR section */}
      <div className="flex flex-col items-center text-center space-y-3">
        <p className="text-[12px] font-medium text-[var(--abu-text-secondary)]">{t.about.wechatSectionTitle}</p>
        <img src={wechatQr} alt="WeChat QR" className="w-40 h-40 rounded-xl shadow-sm" />
        <p className="text-[12px] text-[var(--abu-text-tertiary)]">{t.about.feedbackDesc}</p>
      </div>
    </div>
  );
}
