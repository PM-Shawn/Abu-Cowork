/**
 * SensitiveAuditDialog — one-shot v0.15 sensitive-memory audit dialog.
 *
 * Triggered lazily: the personal-memory settings panel sets
 * `shouldRunMemoryAudit = true` when the user first opens it, which kicks
 * off the scan here. The dialog only opens when there are actual sensitive
 * hits — zero-hit cases (including fresh installs with no memories) are
 * silently marked done so the user is never bothered unnecessarily.
 *
 * `hasRunSensitiveAudit_v015` flips to true once the scan found nothing or the
 * user answered with one of the two buttons, so the audit never runs again.
 *
 * The dialog is a question asked over the settings window. When the scan ends
 * after the settings window has closed, or the settings window goes away while
 * the question is open, nothing is marked done: the panel asks again the next
 * time it opens.
 */

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Tag } from '@/components/ds/tag';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { scanMemoryFiles } from '@/core/memdir/scan';
import { auditMemories, type SensitiveAuditResult, type SensitivePatternId } from '@/core/memdir/sensitiveScan';
import { setMemoryPrivate } from '@/core/memdir/write';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

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
  const rowId = useId();

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
        // The question belongs over the settings window (which also keeps a native web
        // view out of its way). With that window gone, the panel asks again next time.
        if (!useSettingsStore.getState().systemSettingsOpen) return;
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

  const shown = open && !loading && !hasRun;

  const finish = () => {
    setOpen(false);
    setHasRun(true);
  };

  // The dialog stays on the page while it fades out; its buttons do nothing by then.
  const handleClose = () => {
    if (!shown) return;
    finish();
  };

  const handleMarkAll = async () => {
    if (applying || !shown) return;
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
      finish();
    }
  };

  const toggleEntry = (filename: string, workspacePath: string | null) => {
    if (!shown) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.result.header.filename === filename && e.workspacePath === workspacePath
          ? { ...e, selected: !e.selected }
          : e,
      ),
    );
  };

  const selectedCount = entries.filter((e) => e.selected).length;
  const isEmpty = entries.length === 0;

  return (
    // Only the two buttons close it: this is a one-shot privacy onboarding, and a stray
    // Escape or press outside would silently skip the audit for good. The layer registry
    // closes it when the settings window under it goes away; that marks nothing done.
    <Dialog
      open={shown}
      onOpenChange={(next) => { if (!next) setOpen(false); }}
      role="alertdialog"
      dismissible={false}
      title={(
        <span className="flex items-center gap-2">
          <Icon icon={AppIcons.shield} className="text-warning" />
          {t.memory.auditTitle}
        </span>
      )}
      description={isEmpty
        ? t.memory.auditEmpty
        : format(t.memory.auditIntro, { count: String(entries.length) })}
      footer={(
        <>
          {!isEmpty && (
            <span className="mr-auto self-center text-ui-sm text-label-tertiary">
              {format(t.memory.bulkSelected, { count: String(selectedCount) })}
            </span>
          )}
          <Button variant="plain" onClick={handleClose} disabled={applying}>
            {isEmpty ? t.common.confirm : t.memory.auditCancel}
          </Button>
          {!isEmpty && (
            <Button
              variant="primary"
              icon={AppIcons.private}
              onClick={handleMarkAll}
              disabled={applying || selectedCount === 0}
            >
              {t.memory.auditMarkAll}
            </Button>
          )}
        </>
      )}
    >
      {!isEmpty && (
        <div className="space-y-2">
          {entries.map((entry) => {
            const h = entry.result.header;
            const key = `${entry.workspacePath ?? 'g'}:${h.filename}`;
            const boxId = `${rowId}-${key}`;
            return (
              // The whole row ticks its box: the row is the box's label.
              <label
                key={key}
                htmlFor={boxId}
                className={cn(
                  'flex items-start gap-3 rounded-control border p-3',
                  entry.selected ? 'border-control-border bg-fill-selected' : 'border-separator',
                )}
              >
                <Checkbox
                  id={boxId}
                  checked={entry.selected}
                  onCheckedChange={() => toggleEntry(h.filename, entry.workspacePath)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-label">{h.name}</span>
                  <span className="mt-1 block truncate font-code text-ui-sm text-label-tertiary">{h.filename}</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {entry.result.matches.map((m) => (
                      <Tag key={m.patternId} tone="warning">{patternLabel(m.patternId, t)}</Tag>
                    ))}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
