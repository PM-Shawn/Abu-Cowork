import { openUrl } from '@tauri-apps/plugin-opener'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '@/i18n'
import { Button, IconButton } from '@/components/ds/button'
import { Icon } from '@/components/ds/icon'
import { AppIcons } from '@/components/ds/icons'
import type { StatusTone } from '@/components/ds/status-icon'
import { Tag } from '@/components/ds/tag'
import type { AnnouncementItem } from '@/utils/consoleAnnouncement'

// The type of an announcement is a status: its color comes with a shape (Tag).
const TYPE_STYLE: Record<string, { label: (t: ReturnType<typeof useI18n>['t']) => string; tone: 'neutral' | StatusTone }> = {
  version_update: { label: (t) => t.announcement.typeVersionUpdate, tone: 'info' },
  feature: { label: (t) => t.announcement.typeFeature, tone: 'success' },
  breaking: { label: (t) => t.announcement.typeBreaking, tone: 'danger' },
  general: { label: (t) => t.announcement.typeGeneral, tone: 'neutral' },
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
    // On the fullscreen level and after the page in the document: over a preview that covers the
    // window, under every floating layer.
    <div
      data-electron-no-drag
      className="fixed bottom-6 right-6 z-fullscreen w-80 space-y-2 rounded-panel border border-separator bg-raised p-4 shadow-float"
    >
      <div className="flex items-start justify-between gap-2">
        <Tag tone={style.tone}>{style.label(t)}</Tag>
        <IconButton icon={AppIcons.close} label={t.common.close} size="sm" onClick={onDismiss} className="-mr-1 -mt-1" />
      </div>

      <p className="text-ui font-medium text-label">
        {item.title}
      </p>

      {item.body && (
        <div className="line-clamp-4 text-ui-sm text-label-secondary [&_ol]:list-decimal [&_ol]:pl-4 [&_strong]:font-semibold [&_strong]:text-label [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-4">
          <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]}>
            {item.body}
          </ReactMarkdown>
        </div>
      )}

      {/* The negative margin puts the words of the two buttons on the edges of the text above. */}
      <div className="-mx-2 flex items-center justify-between pt-1">
        <Button variant="plain" size="sm" onClick={onDismiss}>
          {t.announcement.dismiss}
        </Button>
        {item.ctaUrl && (
          <Button variant="plain" size="sm" onClick={() => { void handleCta() }}>
            {item.ctaLabel ?? t.announcement.ctaDefault}
            <Icon icon={AppIcons.openExternal} size="sm" />
          </Button>
        )}
      </div>
    </div>
  )
}
