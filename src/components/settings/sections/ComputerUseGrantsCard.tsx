import { useCallback, useEffect, useState } from 'react';
import { format, useI18n } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Tag } from '@/components/ds/tag';
import {
  listComputerUseGrants,
  revokeComputerUseGrant,
  setComputerUseAppDenied,
  type ComputerUseGrantList,
  type ComputerUseGrantRecord,
  type ComputerUseDeniedRecord,
} from '@/core/computer-use/grants';

const SUBHEADING = 'mt-4 text-ui-sm font-medium text-label-tertiary';
// The same bordered box as a settings group, one line between apps.
const ROW_BOX = 'mt-2 divide-y divide-separator rounded-panel border border-separator px-4';

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
    <section>
      <h4 className="text-ui font-medium text-label">
        {t.sandbox.computerUseGrantsTitle}
      </h4>
      <p className="mt-1 text-ui-sm text-label-secondary">
        {t.sandbox.computerUseGrantsDescription}
      </p>

      {loadFailed && (
        <div className="mt-2">
          <InlineMessage tone="danger">{t.sandbox.computerUseGrantsLoadFailed}</InlineMessage>
        </div>
      )}
      {!loadFailed && list && !list.available && (
        <p className="mt-2 text-ui-sm text-label-tertiary">{t.sandbox.computerUseGrantsUnavailable}</p>
      )}

      {list?.available && (
        <>
          <h5 className={SUBHEADING}>
            {t.sandbox.computerUseGrantsAlwaysTitle}
          </h5>
          {list.grants.length === 0 ? (
            <p className="mt-1 text-ui-sm text-label-tertiary">{t.sandbox.computerUseGrantsEmpty}</p>
          ) : (
            <div className={ROW_BOX}>
              {list.grants.map((record) => (
                <GrantRow key={record.key} record={record} onRevoke={revoke} onDeny={deny} />
              ))}
            </div>
          )}

          <h5 className={SUBHEADING}>
            {t.sandbox.computerUseGrantsDeniedTitle}
          </h5>
          {list.denied.length === 0 ? (
            <p className="mt-1 text-ui-sm text-label-tertiary">{t.sandbox.computerUseGrantsDeniedEmpty}</p>
          ) : (
            <div className={ROW_BOX}>
              {list.denied.map((record) => (
                <DeniedRow key={record.key} record={record} onRestore={restore} />
              ))}
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-caption text-label-tertiary">
        {t.sandbox.computerUseGrantsRedLines}
      </p>
    </section>
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
    <div className="flex items-center gap-2 py-2">
      <Icon icon={AppIcons.appWindow} size="sm" className="text-label-tertiary" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ui text-label" title={record.key}>
            {record.displayName}
          </span>
          <span className="flex shrink-0">
            <Tag>{tierLabel}</Tag>
          </span>
        </div>
        <p className="truncate text-caption text-label-tertiary">
          {format(t.sandbox.computerUseGrantGrantedAt, { date: formatDay(record.grantedAt) })}
          {' · '}
          {format(t.sandbox.computerUseGrantLastUsed, { date: formatDay(record.lastUsedAt) })}
        </p>
      </div>
      <Button variant="plain" size="sm" icon={AppIcons.block} onClick={() => void onDeny(record)} title={t.sandbox.computerUseGrantDeny}>
        {t.sandbox.computerUseGrantDeny}
      </Button>
      <Button variant="plain" size="sm" icon={AppIcons.delete} onClick={() => void onRevoke(record)} title={t.sandbox.computerUseGrantRevoke}>
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
    <div className="flex items-center gap-2 py-2">
      <Icon icon={AppIcons.block} size="sm" className="text-label-tertiary" />
      <span className="min-w-0 flex-1 truncate text-ui text-label" title={record.key}>
        {record.displayName}
      </span>
      <Button variant="plain" size="sm" icon={AppIcons.undo} onClick={() => void onRestore(record)} title={t.sandbox.computerUseGrantRestore}>
        {t.sandbox.computerUseGrantRestore}
      </Button>
    </div>
  );
}
