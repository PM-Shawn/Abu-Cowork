import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { useI18n } from '@/i18n';

interface GuideModalProps {
  open: boolean;
  onClose: () => void;
  onNavigateToAIServices?: () => void;
}

export default function GuideModal({ open, onClose, onNavigateToAIServices }: GuideModalProps) {
  const { t } = useI18n();

  const steps = [
    { title: t.guide.step1Title, desc: t.guide.step1Desc },
    { title: t.guide.step2Title, desc: t.guide.step2Desc },
    { title: t.guide.step3Title, desc: t.guide.step3Desc },
    { title: t.guide.step4Title, desc: t.guide.step4Desc },
  ];

  // The window keeps rendering while it fades out: its buttons do nothing more then.
  const dismiss = () => {
    if (!open) return;
    onClose();
  };
  const goToAIServices = () => {
    if (!open || !onNavigateToAIServices) return;
    onClose();
    onNavigateToAIServices();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={t.guide.title}
      size="md"
      closeButton
      // The first-run helpers find the window by this mark.
      contentProps={{ 'data-abu-guide-modal': 'true' }}
      // It opens by itself on the first run: the first focus is on the button that only dismisses it.
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-guide-dismiss]')}
      footer={<Button variant="primary" data-guide-dismiss onClick={dismiss}>{t.guide.dismiss}</Button>}
    >
      <div className="flex flex-col gap-4">
        {steps.map((step, i) => (
          <div key={step.title} className="flex items-start gap-3">
            <Tag>{i + 1}</Tag>
            <div className="min-w-0 flex-1">
              <div className="text-ui font-medium text-label">{step.title}</div>
              <div className="mt-1 text-ui-sm text-label-secondary">
                {step.desc}
                {i === 0 && onNavigateToAIServices && (
                  <>
                    {'，'}
                    <Pressable onClick={goToAIServices} className="rounded-control text-link hover:underline">
                      {t.guide.step1Link}
                    </Pressable>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
