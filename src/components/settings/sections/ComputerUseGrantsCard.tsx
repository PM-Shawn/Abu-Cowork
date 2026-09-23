import { useCallback, useEffect, useState } from 'react';
import { AppWindow, Ban, RotateCcw, Trash2 } from 'lucide-react';
import { format, useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  listComputerUseGrants,
  revokeComputerUseGrant,
  setComputerUseAppDenied,
  type ComputerUseGrantList,
  type ComputerUseGrantRecord,
  type ComputerUseDeniedRecord,
} from '@/core/computer-use/grants';

/**
 * Settings › Security › Computer Use: the apps the user answered
 * "Always allow" for, and the apps they denied (L2 §2.4). The Host Gate
 * owns the records; this card only reads the projection and sends
 * revoke / deny / restore.
 */
export default function ComputerUseGrantsCard() {
  const { t } = useI18n();
  const [list, setList] = useState<ComputerUseGrantList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await listComputerUseGrants();
      setList(next);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listComputerUseGrants().then(
      (next) => {
        if (!cancelled) setList(next);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = useCallback(async (record: ComputerUseGrantRecord) => {
    await revokeComputerUseGrant(record.key);
    await reload();
  }, [reload]);

  const deny = useCallback(async (record: ComputerUseGrantRecord) => {
    await setComputerUseAppDenied(record.key, true, record.displayName);
    await reload();
  }, [reload]);

  const restore = useCallback(async (record: ComputerUseDeniedRecord) => {
    await setComputerUseAppDenied(record.key, false, record.displayName);
    await reload();
  }, [reload]);

  return (
    <div>
      <h4 className="text-body font-medium text-[var(--abu-text-primary)] mb-1">
        {t.sandbox.computerUseGrantsTitle}
      </h4>
      <p className="text-minor text-[var(--abu-text-tertiary)]">
        {t.sandbox.computerUseGrantsDescription}
      </p>

      {loadFailed && (
        <p className="text-minor text-[var(--abu-danger)] mt-2">{t.sandbox.computerUseGrantsLoadFailed}</p>
      )}
      {!loadFailed && list && !list.available && (
        <p className="text-minor text-[var(--abu-text-tertiary)] mt-2">{t.sandbox.computerUseGrantsUnavailable}</p>
      )}

      {list?.available && (
        <>
          <h5 className="text-h-xs text-[var(--abu-text-secondary)] mt-4 mb-1">
            {t.sandbox.computerUseGrantsAlwaysTitle}
          </h5>
          {list.grants.length === 0 ? (
            <p className="text-minor text-[var(--abu-text-tertiary)]">{t.sandbox.computerUseGrantsEmpty}</p>
          ) : (
            <div className="space-y-1.5">
              {list.grants.map((record) => (
                <GrantRow key={record.key} record={record} onRevoke={revoke} onDeny={deny} />
              ))}
            </div>
          )}

          <h5 className="text-h-xs text-[var(--abu-text-secondary)] mt-4 mb-1">
            {t.sandbox.computerUseGrantsDeniedTitle}
          </h5>
          {list.denied.length === 0 ? (
            <p className="text-minor text-[var(--abu-text-tertiary)]">{t.sandbox.computerUseGrantsDeniedEmpty}</p>
          ) : (
            <div className="space-y-1.5">
              {list.denied.map((record) => (
                <DeniedRow key={record.key} record={record} onRestore={restore} />
              ))}
            </div>
          )}
        </>
      )}

      <p className="text-caption text-[var(--abu-text-muted)] mt-3">
        {t.sandbox.computerUseGrantsRedLines}
      </p>
    </div>
  );
}

function formatDay(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

function GrantRow({
  record,
  onRevoke,
  onDeny,
}: {
  record: ComputerUseGrantRecord;
  onRevoke: (record: ComputerUseGrantRecord) => Promise<void>;
  onDeny: (record: ComputerUseGrantRecord) => Promise<void>;
}) {
  const { t } = useI18n();
  const tierLabel = record.tier === 'ordinary'
    ? t.sandbox.computerUseGrantTierOrdinary
    : t.sandbox.computerUseGrantTierApprovalRequired;
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-secondary)]">
      <AppWindow className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-minor text-[var(--abu-text-secondary)] truncate" title={record.key}>
            {record.displayName}
          </span>
          <span className="text-caption px-1.5 rounded bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)] shrink-0">
            {tierLabel}
          </span>
        </div>
        <p className="text-caption text-[var(--abu-text-muted)] truncate">
          {format(t.sandbox.computerUseGrantGrantedAt, { date: formatDay(record.grantedAt) })}
          {' · '}
          {format(t.sandbox.computerUseGrantLastUsed, { date: formatDay(record.lastUsedAt) })}
        </p>
      </div>
      <Button variant="ghost" size="xs" onClick={() => void onDeny(record)} title={t.sandbox.computerUseGrantDeny}>
        <Ban className="h-3 w-3" />
        {t.sandbox.computerUseGrantDeny}
      </Button>
      <Button variant="ghost" size="xs" onClick={() => void onRevoke(record)} title={t.sandbox.computerUseGrantRevoke}>
        <Trash2 className="h-3 w-3" />
        {t.sandbox.computerUseGrantRevoke}
      </Button>
    </div>
  );
}

function DeniedRow({
  record,
  onRestore,
}: {
  record: ComputerUseDeniedRecord;
  onRestore: (record: ComputerUseDeniedRecord) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-secondary)]">
      <Ban className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
      <span className="flex-1 text-minor text-[var(--abu-text-secondary)] truncate" title={record.key}>
        {record.displayName}
      </span>
      <Button variant="ghost" size="xs" onClick={() => void onRestore(record)} title={t.sandbox.computerUseGrantRestore}>
        <RotateCcw className="h-3 w-3" />
        {t.sandbox.computerUseGrantRestore}
      </Button>
    </div>
  );
}
