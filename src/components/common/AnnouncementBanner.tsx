import { X, ExternalLink } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { AnnouncementItem } from '@/utils/consoleAnnouncement'

const TYPE_STYLE: Record<string, { label: (t: ReturnType<typeof useI18n>['t']) => string; accent: string; border: string }> = {
  version_update: {
    label: (t) => t.announcement.typeVersionUpdate,
    accent: 'text-[var(--abu-info)]',
    border: 'border-[var(--abu-info)]',
  },
  feature: {
    label: (t) => t.announcement.typeFeature,
    accent: 'text-[var(--abu-success)]',
    border: 'border-[var(--abu-success)]',
  },
  breaking: {
    label: (t) => t.announcement.typeBreaking,
    accent: 'text-[var(--abu-danger)]',
    border: 'border-[var(--abu-danger)]',
  },
  general: {
    label: (t) => t.announcement.typeGeneral,
    accent: 'text-[var(--abu-text-tertiary)]',
    border: 'border-[var(--abu-border)]',
  },
}

export default function AnnouncementBanner({
  item,
  onDismiss,
}: {
  item: AnnouncementItem
  onDismiss: () => void
}) {
  const { t } = useI18n()
  const style = TYPE_STYLE[item.type] ?? TYPE_STYLE.general

  async function handleCta() {
    if (item.ctaUrl) {
      try { await openUrl(item.ctaUrl) } catch { /* ignore */ }
    }
  }

  return (
    <div
      className={cn(
        'fixed bottom-6 right-6 z-50 w-80 rounded-xl border bg-[var(--abu-bg-muted)] shadow-xl',
        style.border,
      )}
    >
      <div className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <span className={cn('text-minor font-semibold', style.accent)}>
            {style.label(t)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDismiss}
            className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] shrink-0 -mt-0.5 -mr-1"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <p className="text-body font-medium text-[var(--abu-text-primary)] leading-snug">
          {item.title}
        </p>

        {item.body && (
          <div className="text-minor text-[var(--abu-text-secondary)] leading-relaxed line-clamp-4
            [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-0.5
            [&_ol]:list-decimal [&_ol]:pl-4
            [&_strong]:font-semibold [&_strong]:text-[var(--abu-text-primary)]
            [&_p]:leading-relaxed">
            <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]}>
              {item.body}
            </ReactMarkdown>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={onDismiss}
            className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] px-0"
          >
            {t.announcement.dismiss}
          </Button>
          {item.ctaUrl && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { void handleCta() }}
              className="text-[var(--abu-clay)] hover:underline px-0"
            >
              {item.ctaLabel ?? t.announcement.ctaDefault}
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
