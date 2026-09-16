import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink, X } from 'lucide-react';
import wechatQr from '@/assets/wechat-qr.png';
import sponsorQr from '@/assets/sponsor-qr.png';
import { AUTHOR_LINKS, DISCLAIMER_URL_BASE } from '@/utils/authorLinks';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { useI18n } from '@/i18n';

type QrKey = 'wechat' | 'sponsor';

const QR_SRC: Record<QrKey, string> = { wechat: wechatQr, sponsor: sponsorQr };

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
      <div className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-6 py-7 flex flex-col items-center text-center gap-1.5">
        <h4 className="text-h-md text-[var(--abu-text-primary)]">{t.author.name}</h4>
        <p className="text-body text-[var(--abu-text-secondary)]">{t.author.tagline}</p>
        <p className="text-minor text-[var(--abu-text-muted)]">{t.author.role}</p>
        <p className="text-minor text-[var(--abu-text-muted)]">
          {t.author.vibe}
          <span className="mx-2">·</span>
          {t.author.build}
        </p>
      </div>

      {/* Contact & support */}
      <div className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-6 py-6 flex flex-col items-center text-center gap-5">
        <p className="text-caption tracking-wider text-[var(--abu-text-muted)]">{t.author.contactTitle}</p>

        <div className="flex justify-center gap-12">
          {qrTiles.map(({ key, label, caption }) => (
            <button
              key={key}
              type="button"
              onClick={() => setZoomed(key)}
              title={t.author.zoomHint}
              className="group flex flex-col items-center gap-1 cursor-zoom-in"
            >
              <img
                src={QR_SRC[key]}
                alt={label}
                className="w-[104px] h-[104px] rounded-xl border border-[var(--abu-border)] bg-white shadow-sm mb-1.5 transition-transform group-hover:-translate-y-px"
              />
              <span className="text-body font-medium text-[var(--abu-text-primary)]">{label}</span>
              <span className="text-caption text-[var(--abu-text-muted)]">{caption}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {socials.map(({ label, url }) => (
            <button
              key={label}
              type="button"
              onClick={() => void openLink(url)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-3 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
            >
              {label}
              <ExternalLink className="h-3 w-3 text-[var(--abu-text-muted)]" />
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center space-y-1 pt-1">
        <p className="text-body">
          <span className="text-[var(--abu-text-tertiary)] mr-2">{t.author.website}</span>
          <button
            type="button"
            onClick={() => void openLink(OFFICIAL_WEBSITE_URL)}
            className="inline-flex items-center gap-1 text-[var(--abu-clay)] font-medium hover:underline"
          >
            myabu.cn
            <ExternalLink className="h-3 w-3" />
          </button>
        </p>
        <p className="text-minor text-[var(--abu-text-muted)]">
          © 2026 {t.common.appName}. All rights reserved.
          <span className="mx-1.5">·</span>
          <button
            type="button"
            onClick={() => {
              setDisclaimerOpen((o) => !o);
              if (!disclaimerOpen) {
                setTimeout(() => disclaimerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
              }
            }}
            className={disclaimerOpen
              ? 'text-[var(--abu-text-secondary)]'
              : 'transition-colors hover:text-[var(--abu-text-secondary)]'}
          >
            {t.about.disclaimerLink}
          </button>
        </p>
      </div>

      {/* Expandable disclaimer — moved verbatim from the version page */}
      {disclaimerOpen && (
        <div
          ref={disclaimerRef}
          className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-active)] p-3 max-h-64 overflow-y-auto space-y-2"
        >
          <p className="text-minor font-semibold text-[var(--abu-text-primary)]">{t.about.disclaimerTitle}</p>
          <div className="text-minor text-[var(--abu-text-secondary)] space-y-1.5 leading-relaxed">
            <p>· {t.disclaimerBanner.line1}</p>
            <p>· {t.disclaimerBanner.line2}</p>
            <p>· {t.disclaimerBanner.line3}</p>
          </div>
          <button
            type="button"
            onClick={() => void openLink(disclaimerUrl)}
            className="flex items-center gap-1 text-minor text-[var(--abu-clay)] hover:underline mt-1"
          >
            <ExternalLink className="h-3 w-3" />
            {t.about.disclaimerLink}{t.about.disclaimerFullSuffix}
          </button>
          <button
            type="button"
            onClick={() => setDisclaimerOpen(false)}
            className="block text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] mt-1"
          >
            {t.about.disclaimerClose}
          </button>
        </div>
      )}

      {zoomed && (
        <QrZoom
          src={QR_SRC[zoomed]}
          title={zoomed === 'wechat' ? t.author.wechatLabel : t.author.sponsorLabel}
          caption={zoomed === 'wechat' ? t.author.wechatCaptionFull : t.author.sponsorCaptionFull}
          closeLabel={t.common.close}
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
 */
function QrZoom({
  src,
  title,
  caption,
  closeLabel,
  onClose,
}: {
  src: string;
  title: string;
  caption: string;
  closeLabel: string;
  onClose: () => void;
}) {
  useEffect(() => {
    // Capture phase + stopImmediatePropagation: the settings dialog underneath
    // also closes on a document-level Escape, and one keypress must not
    // collapse both layers — the user pressed Esc to put the QR code away,
    // not to leave settings.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      // Opts the overlay out of the Windows title-bar drag lanes — without it
      // a click in the top 72px moves the window instead (overlayDragRegions).
      data-electron-no-drag
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex flex-col items-center gap-2 rounded-2xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-6 pt-6 pb-5 shadow-xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-md text-[var(--abu-text-tertiary)] transition-colors hover:bg-[var(--abu-bg-hover)]"
        >
          <X className="h-4 w-4" />
        </button>
        <img src={src} alt={title} className="w-[260px] h-[260px] rounded-xl border border-[var(--abu-border)] bg-white" />
        <p className="text-body font-semibold text-[var(--abu-text-primary)] mt-1">{title}</p>
        <p className="text-minor text-[var(--abu-text-tertiary)]">{caption}</p>
      </div>
    </div>,
    document.body,
  );
}
