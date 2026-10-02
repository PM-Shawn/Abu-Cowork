/**
 * WeChatQRPanel — QR code scan-to-bind flow for WeChat iLink.
 *
 * Phases:
 *   idle → loading → waiting(countdown) → scanned → confirmed
 *                                       ↘ expired → idle (retry)
 *                        error at any point → error → idle (retry)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { getWeChatQRCode, pollWeChatQRStatus } from '@/core/im/adapters/wechat';
import type { WeChatCredentials } from '@/core/im/adapters/wechat';

/**
 * QRImage — renders a QR code from a payload string.
 * The iLink API returns `qrcode_img_content` as a deep-link URL (the payload),
 * NOT an image. We encode it into a QR code locally for the user to scan.
 */
function QRImage({ payload, dimmed }: { payload: string; dimmed?: boolean }) {
  const { t } = useI18n();
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(payload, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setDataUrl(''); });
    return () => { cancelled = true; };
  }, [payload]);

  if (!dataUrl) {
    return (
      <div className="flex size-40 items-center justify-center rounded-control border border-separator">
        <Spinner label={`${t.imChannel.wechatScanQR}…`} />
      </div>
    );
  }

  // A QR code is scanned off a white ground, whatever the appearance.
  return (
    <img
      src={dataUrl}
      alt="WeChat QR Code"
      className={cn('size-40 rounded-control border border-separator bg-page-canvas transition-opacity duration-fast', dimmed ? 'opacity-30' : 'opacity-100')}
    />
  );
}

type Phase =
  | { id: 'idle' }
  | { id: 'loading' }
  | { id: 'waiting'; qrcode: string; payload: string; secsLeft: number }
  | { id: 'scanned'; qrcode: string; payload: string }
  | { id: 'confirmed' }
  | { id: 'expired' }
  | { id: 'error'; message: string };

const QR_TTL_SECS = 120;
const POLL_MS = 2000;

interface WeChatQRPanelProps {
  /** Called once when the user has confirmed the QR scan and creds are ready. */
  onBound: (creds: WeChatCredentials) => void;
  /** Whether to show in compact form (used inside expanded channel settings). */
  compact?: boolean;
}

export default function WeChatQRPanel({ onBound, compact = false }: WeChatQRPanelProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ id: 'idle' });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const startPolling = useCallback((qrcode: string, payload: string) => {
    let secsLeft = QR_TTL_SECS;

    setPhase({ id: 'waiting', qrcode, payload, secsLeft });

    countdownRef.current = setInterval(() => {
      secsLeft -= 1;
      setPhase((prev) => {
        if (prev.id !== 'waiting' && prev.id !== 'scanned') return prev;
        if (secsLeft <= 0) {
          clearTimers();
          return { id: 'expired' };
        }
        if (prev.id === 'waiting') return { ...prev, secsLeft };
        return prev; // scanned: no countdown update needed in UI
      });
    }, 1000);

    pollRef.current = setInterval(async () => {
      try {
        const status = await pollWeChatQRStatus(qrcode);
        if (status.status === 'scanned') {
          setPhase((prev) =>
            prev.id === 'waiting' || prev.id === 'scanned'
              ? { id: 'scanned', qrcode, payload }
              : prev,
          );
        } else if (status.status === 'confirmed') {
          clearTimers();
          setPhase({ id: 'confirmed' });
          onBound(status.credentials);
        } else if (status.status === 'expired') {
          clearTimers();
          setPhase({ id: 'expired' });
        }
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_MS);
  }, [clearTimers, onBound]);

  const fetchQR = useCallback(async () => {
    clearTimers();
    setPhase({ id: 'loading' });
    try {
      const { qrcode, qrcode_img_content } = await getWeChatQRCode();
      startPolling(qrcode, qrcode_img_content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase({ id: 'error', message: msg });
    }
  }, [clearTimers, startPolling]);

  // ── Render ──

  const wrapCls = cn('rounded-panel border border-separator', compact ? 'p-4' : 'p-5');

  if (phase.id === 'idle') {
    return (
      <div className={cn(wrapCls, 'flex flex-col items-center gap-3 text-center')}>
        <p className="text-ui text-label-secondary">{t.imChannel.wechatBindHint}</p>
        {/* The panel always sits in a place that has its own filled button. */}
        <Button variant="secondary" onClick={fetchQR}>
          {t.imChannel.wechatScanQR}
        </Button>
      </div>
    );
  }

  if (phase.id === 'loading') {
    return (
      <div className={cn(wrapCls, 'flex flex-col items-center gap-3')}>
        <Spinner label={`${t.imChannel.wechatScanQR}…`} />
      </div>
    );
  }

  if (phase.id === 'waiting' || phase.id === 'scanned') {
    const isScanned = phase.id === 'scanned';
    const payload = phase.payload;
    const secsLeft = phase.id === 'waiting' ? phase.secsLeft : undefined;

    return (
      <div className={cn(wrapCls, 'flex flex-col items-center gap-3')}>
        {/* QR code generated from payload, with overlay when scanned */}
        <div className="relative">
          <QRImage payload={payload} dimmed={isScanned} />
          {isScanned && (
            <div className="absolute inset-0 flex items-center justify-center">
              {/* On its own raised chip: the mark keeps its contrast over the white code. */}
              <span className="flex rounded-control bg-raised p-1 shadow-float">
                <StatusIcon tone="success" size="lg" />
              </span>
            </div>
          )}
        </div>

        {/* Status text: the user is the one acting here, so nothing spins. */}
        <div className="space-y-1 text-center">
          <p className="text-ui font-medium text-label">
            {isScanned ? t.imChannel.wechatScanned : t.imChannel.wechatWaiting}
          </p>
          {secsLeft !== undefined && (
            <p className="text-caption text-label-tertiary">
              {format(t.imChannel.wechatExpireIn, { secs: String(secsLeft) })}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (phase.id === 'confirmed') {
    return (
      <div className={cn(wrapCls, 'flex flex-col items-center gap-2')}>
        <StatusIcon tone="success" size="lg" />
        <p className="text-ui font-medium text-success">{t.imChannel.wechatSuccess}</p>
      </div>
    );
  }

  if (phase.id === 'expired') {
    return (
      <div className={cn(wrapCls, 'flex flex-col items-center gap-3 text-center')}>
        <p className="text-ui text-label-secondary">{t.imChannel.wechatExpired}</p>
        <Button variant="secondary" icon={AppIcons.retry} onClick={fetchQR}>
          {t.imChannel.wechatRetry}
        </Button>
      </div>
    );
  }

  // error
  if (phase.id === 'error') {
    return (
      <div className={cn(wrapCls, 'flex flex-col items-center gap-3 text-center')}>
        <StatusIcon tone="danger" size="lg" />
        <p className="max-w-70 text-ui-sm text-danger">{phase.message}</p>
        <Button variant="secondary" icon={AppIcons.retry} onClick={fetchQR}>
          {t.imChannel.wechatRetry}
        </Button>
      </div>
    );
  }

  return null;
}
