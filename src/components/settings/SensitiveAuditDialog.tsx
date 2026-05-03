/**
 * SensitiveAuditDialog — one-shot v0.15 sensitive-memory audit dialog.
 *
 * Triggered lazily: the personal-memory settings panel sets
 * `shouldRunMemoryAudit = true` when the user first opens it, which kicks
 * off the scan here. The dialog only opens when there are actual sensitive
 * hits — zero-hit cases (including fresh installs with no memories) are
 * silently marked done so the user is never bothered unnecessarily.
 *
 * `hasRunSensitiveAudit_v015` flips to true after any completed scan
 * (regardless of hits), so the audit never runs again.
 */

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Lock, ShieldAlert } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { scanMemoryFiles } from '@/core/memdir/scan';
import { auditMemories, type SensitiveAuditResult, type SensitivePatternId } from '@/core/memdir/sensitiveScan';
import { setMemoryPrivate } from '@/core/memdir/write';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { Button } from '@/components/ui/button';

interface AuditEntry {
  result: SensitiveAuditResult;
  workspacePath: string | null;
  selected: boolean;
}

function patternLabel(id: SensitivePatternId, t: ReturnType<typeof useI18n>['t']): string {
  switch (id) {
    case 'cn_id_card': return t.memory.auditPatternIdCard;
    case 'bank_card': return t.memory.auditPatternBankCard;
    case 'mobile_phone': return t.memory.auditPatternMobile;
    case 'email_with_password': return t.memory.auditPatternEmailPassword;
    case 'salary_keyword': return t.memory.auditPatternSalary;
  }
}

export default function SensitiveAuditDialog() {
  const { t } = useI18n();
  const hasRun = useSettingsStore((s) => s.hasRunSensitiveAudit_v015);
  const setHasRun = useSettingsStore((s) => s.setHasRunSensitiveAudit_v015);
  const shouldRun = useSettingsStore((s) => s.shouldRunMemoryAudit);
  const setShouldRun = useSettingsStore((s) => s.setShouldRunMemoryAudit);
  const recentPaths = useWorkspaceStore((s) => s.recentPaths);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [applying, setApplying] = useState(false);

  // Triggered by the personal-memory settings panel (shouldRun = true).
  // Only opens the dialog when there are actual sensitive hits — zero-hit
  // cases (fresh installs included) are silently marked done.
  useEffect(() => {
    if (!shouldRun || hasRun) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const buckets: Array<{ path: string | null; headers: Awaited<ReturnType<typeof scanMemoryFiles>> }> = [];
        buckets.push({ path: null, headers: await scanMemoryFiles(null) });
        for (const wsPath of recentPaths) {
          try {
            buckets.push({ path: wsPath, headers: await scanMemoryFiles(wsPath) });
          } catch {
            // Skip inaccessible workspace
          }
        }

        const flagged: AuditEntry[] = [];
        for (const { path, headers } of buckets) {
          const audited = await auditMemories(headers);
          for (const result of audited) {
            flagged.push({ result, workspacePath: path, selected: true });
          }
        }

        if (cancelled) return;
        setShouldRun(false);
        if (flagged.length === 0) {
          // No sensitive content found — silently mark done, no dialog needed.
          setHasRun(true);
          return;
        }
        setEntries(flagged);
        setOpen(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Reset the trigger so a future panel open can re-fire the audit.
      setShouldRun(false);
    };
  }, [shouldRun, hasRun, recentPaths, setShouldRun, setHasRun]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setHasRun(true);
  }, [setHasRun]);

  const handleMarkAll = useCallback(async () => {
    if (applying) return;
    setApplying(true);
    try {
      const targets = entries.filter((e) => e.selected);
      for (const target of targets) {
        try {
          await setMemoryPrivate(target.result.header.filename, true, target.workspacePath);
        } catch (err) {
          console.error(`[Audit] failed to mark ${target.result.header.filename} private:`, err);
        }
      }
    } finally {
      setApplying(false);
      handleClose();
    }
  }, [applying, entries, handleClose]);

  const toggleEntry = (filename: string, workspacePath: string | null) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.result.header.filename === filename && e.workspacePath === workspacePath
          ? { ...e, selected: !e.selected }
          : e,
      ),
    );
  };

  if (loading || !open || hasRun) return null;

  const selectedCount = entries.filter((e) => e.selected).length;
  const isEmpty = entries.length === 0;

  return createPortal(
    // No backdrop-click dismiss: this is a one-shot privacy onboarding;
    // accidentally clicking outside would silently skip the audit and the
    // user wouldn't see the dialog again. Force them to read and click a
    // button. Same reasoning for not handling ESC.
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="px-6 pt-6 pb-3 border-b border-[var(--abu-bg-muted)]">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)]">
              {t.memory.auditTitle}
            </h3>
          </div>
          <p className="text-[13px] text-[var(--abu-text-tertiary)] leading-relaxed">
            {isEmpty
              ? t.memory.auditEmpty
              : format(t.memory.auditIntro, { count: String(entries.length) })}
          </p>
        </div>

        {!isEmpty && (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
            {entries.map((entry) => {
              const h = entry.result.header;
              const key = `${entry.workspacePath ?? 'g'}:${h.filename}`;
              return (
                <label
                  key={key}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    entry.selected
                      ? 'border-[var(--abu-clay)] bg-orange-50/40'
                      : 'border-[var(--abu-border)] bg-[var(--abu-bg-muted)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    onChange={() => toggleEntry(h.filename, entry.workspacePath)}
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--abu-clay)] cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[var(--abu-text-primary)] truncate">
                      {h.name}
                    </div>
                    <div className="text-[11px] text-[var(--abu-text-placeholder)] mt-0.5">
                      {h.filename}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {entry.result.matches.map((m) => (
                        <span
                          key={m.patternId}
                          className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
                        >
                          {patternLabel(m.patternId, t)}
                        </span>
                      ))}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--abu-bg-muted)]">
          {!isEmpty && (
            <span className="text-[11px] text-[var(--abu-text-placeholder)] mr-auto">
              {format(t.memory.bulkSelected, { count: String(selectedCount) })}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={applying}>
            {isEmpty ? t.common.confirm : t.memory.auditCancel}
          </Button>
          {!isEmpty && (
            <Button
              variant="default"
              size="sm"
              onClick={handleMarkAll}
              disabled={applying || selectedCount === 0}
              className="gap-1.5"
            >
              <Lock className="h-3.5 w-3.5" />
              {t.memory.auditMarkAll}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
