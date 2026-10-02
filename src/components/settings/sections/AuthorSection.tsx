import { useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import wechatQr from '@/assets/wechat-qr.png';
import sponsorQr from '@/assets/sponsor-qr.png';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { AUTHOR_LINKS, DISCLAIMER_URL_BASE } from '@/utils/authorLinks';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type QrKey = 'wechat' | 'sponsor';

const QR_SRC: Record<QrKey, string> = { wechat: wechatQr, sponsor: sponsorQr };

const TEXT_LINK = 'inline-flex items-center gap-1 rounded-control text-ui-sm text-link hover:underline';

async function openLink(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    console.error('Failed to open link:', e);
  }
}

/**
 * The page about the person behind Abu: who they are, where to find them, and
 * the two QR codes (official account, tip jar). The disclaimer and copyright
 * live here too — they describe the product's terms, not its version, so they
 * moved off the 「版本」 page when this one was split out of it.
 *
 * Both QR images are bundled with the renderer exactly like the WeChat code
 * always was — an `import` that Vite emits as an asset. Nothing is fetched.
 */
export default function AuthorSection() {
  const { t, locale } = useI18n();
  const [zoomed, setZoomed] = useState<QrKey | null>(null);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const disclaimerRef = useRef<HTMLDivElement>(null);
  const disclaimerUrl = `${DISCLAIMER_URL_BASE}/${locale === 'zh-CN' ? 'DISCLAIMER.zh-CN.md' : 'DISCLAIMER.md'}`;

  const socials = [
    { label: t.author.xiaohongshu, url: AUTHOR_LINKS.xiaohongshu },
    { label: t.author.x, url: AUTHOR_LINKS.x },
    { label: t.author.github, url: AUTHOR_LINKS.github },
  ];

  const qrTiles: Array<{ key: QrKey; label: string; caption: string }> = [
    { key: 'wechat', label: t.author.wechatLabel, caption: t.author.wechatCaption },
    { key: 'sponsor', label: t.author.sponsorLabel, caption: t.author.sponsorCaption },
  ];

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.author.title} />

      {/* Who */}
      <div className="flex flex-col items-center gap-2 rounded-panel border border-separator p-4 text-center">
        <h4 className="text-title text-label">{t.author.name}</h4>
        <p className="text-ui text-label-secondary">{t.author.tagline}</p>
        <p className="text-ui-sm text-label-tertiary">{t.author.role}</p>
        <p className="text-ui-sm text-label-tertiary">
          {t.author.vibe}
          <span className="mx-2">·</span>
          {t.author.build}
        </p>
      </div>

      {/* Contact & support */}
      <div className="flex flex-col items-center gap-5 rounded-panel border border-separator p-4 text-center">
        <p className="text-caption text-label-tertiary">{t.author.contactTitle}</p>

        <div className="flex justify-center gap-8">
          {qrTiles.map(({ key, label, caption }) => (
            <Pressable
              key={key}
              onClick={() => setZoomed(key)}
              title={t.author.zoomHint}
              className="flex cursor-zoom-in flex-col items-center gap-1 rounded-control"
            >
              {/* A QR code is read against white, in every appearance. */}
              <img
                src={QR_SRC[key]}
                alt={label}
                className="mb-2 size-26 rounded-control border border-separator bg-page-canvas"
              />
              <span className="text-ui font-medium text-label">{label}</span>
              <span className="text-caption text-label-tertiary">{caption}</span>
            </Pressable>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-4">
          {socials.map(({ label, url }) => (
            <Pressable key={label} onClick={() => void openLink(url)} className={TEXT_LINK}>
              {label}
              <Icon icon={AppIcons.openExternal} size="sm" />
            </Pressable>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="space-y-1 text-center">
        <p className="text-ui">
          <span className="mr-2 text-label-tertiary">{t.author.website}</span>
          <Pressable onClick={() => void openLink(OFFICIAL_WEBSITE_URL)} className={TEXT_LINK}>
            myabu.cn
            <Icon icon={AppIcons.openExternal} size="sm" />
          </Pressable>
        </p>
        <p className="text-ui-sm text-label-tertiary">
          © 2026 {t.common.appName}. All rights reserved.
          <span className="mx-2">·</span>
          <Pressable
            onClick={() => {
              setDisclaimerOpen((o) => !o);
              if (!disclaimerOpen) {
                setTimeout(() => disclaimerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
              }
            }}
            aria-expanded={disclaimerOpen}
            className={cn('rounded-control hover:text-label-secondary', disclaimerOpen && 'text-label-secondary')}
          >
            {t.about.disclaimerLink}
          </Pressable>
        </p>
      </div>

      {/* Expandable disclaimer — moved verbatim from the version page */}
      {disclaimerOpen && (
        <div
          ref={disclaimerRef}
          className="max-h-64 space-y-2 overflow-y-auto rounded-panel border border-separator p-3"
        >
          <p className="text-ui-sm font-medium text-label">{t.about.disclaimerTitle}</p>
          <div className="space-y-2 text-ui-sm text-label-secondary">
            <p>· {t.disclaimerBanner.line1}</p>
            <p>· {t.disclaimerBanner.line2}</p>
            <p>· {t.disclaimerBanner.line3}</p>
          </div>
          <Pressable onClick={() => void openLink(disclaimerUrl)} className={TEXT_LINK}>
            <Icon icon={AppIcons.openExternal} size="sm" />
            {t.about.disclaimerLink}{t.about.disclaimerFullSuffix}
          </Pressable>
          <Pressable
            onClick={() => setDisclaimerOpen(false)}
            className="block rounded-control text-ui-sm text-label-tertiary hover:text-label-secondary"
          >
            {t.about.disclaimerClose}
          </Pressable>
        </div>
      )}

      {zoomed && (
        <QrZoom
          src={QR_SRC[zoomed]}
          title={zoomed === 'wechat' ? t.author.wechatLabel : t.author.sponsorLabel}
          caption={zoomed === 'wechat' ? t.author.wechatCaptionFull : t.author.sponsorCaptionFull}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
}

/**
 * A QR code big enough to scan from across a desk. Deliberately NOT the chat's
 * `ImageLightbox`: that one is built around base64 tool output and on-disk
 * files (save / reveal / paging), none of which a bundled asset has — reusing
 * it would mean inlining the PNGs into the JS bundle just to satisfy its
 * contract.
 *
 * A dialog opened inside the settings window: Escape, a press outside it and its
 * close button put the QR code away and leave the settings window open.
 */
function QrZoom({
  src,
  title,
  caption,
  onClose,
}: {
  src: string;
  title: string;
  caption: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={title} titleHidden size="sm" closeButton>
      <div className="flex flex-col items-center gap-2">
        <div className="rounded-control bg-page-canvas p-3">
          <img src={src} alt={title} className="size-65" />
        </div>
        <p className="text-ui font-medium text-label">{title}</p>
        <p className="text-ui-sm text-label-secondary">{caption}</p>
      </div>
    </Dialog>
  );
}
