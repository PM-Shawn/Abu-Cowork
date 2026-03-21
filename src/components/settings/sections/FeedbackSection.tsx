import { MessageCircle } from 'lucide-react';
import wechatQr from '@/assets/wechat-qr.png';
import { useI18n } from '@/i18n';

export default function FeedbackSection() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col items-center text-center space-y-6 py-8">
      <div className="h-12 w-12 rounded-2xl bg-[var(--abu-clay-bg)] flex items-center justify-center">
        <MessageCircle className="h-6 w-6 text-[var(--abu-clay)]" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-[var(--abu-text-primary)]">{t.about.feedback}</h3>
        <p className="text-sm text-[var(--abu-text-tertiary)]">{t.about.feedbackDesc}</p>
      </div>
      <img src={wechatQr} alt="WeChat QR" className="w-52 h-52 rounded-xl shadow-sm" />
    </div>
  );
}
