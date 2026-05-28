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
import { RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
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
      <div className="h-40 w-40 rounded-lg border border-[var(--abu-border)] flex items-center justify-center bg-white">
        <Loader2 className="h-6 w-6 text-[var(--abu-text-muted)] animate-spin" />
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt="WeChat QR Code"
      className={`h-40 w-40 rounded-lg border border-[var(--abu-border)] bg-white transition-opacity ${dimmed ? 'opacity-30' : 'opacity-100'}`}
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

  const wrapCls = compact
    ? 'rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4'
    : 'rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-5';

  if (phase.id === 'idle') {
    return (
      <div className={`${wrapCls} flex flex-col items-center gap-3 text-center`}>
        <p className="text-[13px] text-[var(--abu-text-tertiary)]">{t.imChannel.wechatBindHint}</p>
        <button
          onClick={fetchQR}
          className="px-4 py-2 text-sm font-medium text-white bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] rounded-lg transition-colors"
        >
          {t.imChannel.wechatScanQR}
        </button>
      </div>
    );
  }

  if (phase.id === 'loading') {
    return (
      <div className={`${wrapCls} flex flex-col items-center gap-3`}>
        <Loader2 className="h-8 w-8 text-[var(--abu-clay)] animate-spin" />
        <p className="text-[13px] text-[var(--abu-text-muted)]">{t.imChannel.wechatScanQR}…</p>
      </div>
    );
  }

  if (phase.id === 'waiting' || phase.id === 'scanned') {
    const isScanned = phase.id === 'scanned';
    const payload = phase.payload;
    const secsLeft = phase.id === 'waiting' ? phase.secsLeft : undefined;

    return (
      <div className={`${wrapCls} flex flex-col items-center gap-3`}>
        {/* QR code generated from payload, with overlay when scanned */}
        <div className="relative">
          <QRImage payload={payload} dimmed={isScanned} />
          {isScanned && (
            <div className="absolute inset-0 flex items-center justify-center">
              <CheckCircle className="h-12 w-12 text-green-500" />
            </div>
          )}
        </div>

        {/* Status text */}
        <div className="text-center space-y-1">
          <p className="text-[13px] font-medium text-[var(--abu-text-primary)]">
            {isScanned ? t.imChannel.wechatScanned : t.imChannel.wechatWaiting}
          </p>
          {secsLeft !== undefined && (
            <p className="text-[11px] text-[var(--abu-text-muted)]">
              {format(t.imChannel.wechatExpireIn, { secs: String(secsLeft) })}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (phase.id === 'confirmed') {
    return (
      <div className={`${wrapCls} flex flex-col items-center gap-2`}>
        <CheckCircle className="h-8 w-8 text-green-500" />
        <p className="text-[13px] font-medium text-green-600">{t.imChannel.wechatSuccess}</p>
      </div>
    );
  }

  if (phase.id === 'expired') {
    return (
      <div className={`${wrapCls} flex flex-col items-center gap-3 text-center`}>
        <p className="text-[13px] text-[var(--abu-text-muted)]">{t.imChannel.wechatExpired}</p>
        <button
          onClick={fetchQR}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-[var(--abu-clay)] border border-[var(--abu-clay-40)] rounded-lg hover:bg-[var(--abu-clay-5)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t.imChannel.wechatRetry}
        </button>
      </div>
    );
  }

  // error
  if (phase.id === 'error') {
    return (
      <div className={`${wrapCls} flex flex-col items-center gap-3 text-center`}>
        <AlertCircle className="h-7 w-7 text-red-400" />
        <p className="text-[12px] text-red-500 max-w-[280px]">{phase.message}</p>
        <button
          onClick={fetchQR}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-[var(--abu-clay)] border border-[var(--abu-clay-40)] rounded-lg hover:bg-[var(--abu-clay-5)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t.imChannel.wechatRetry}
        </button>
      </div>
    );
  }

  return null;
}
