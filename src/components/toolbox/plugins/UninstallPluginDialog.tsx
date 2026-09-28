/**
 * The uninstall confirmation, owned in one place.
 *
 * Four surfaces can now remove a plugin — a market row's `···` menu, an
 * orphaned install's menu, the manage dialog, and the 「我的」 list. Uninstall
 * deletes a package directory and withdraws its skills, MCP servers and agents
 * (the last of which live outside the package, under `~/.abu/agents`), so the
 * confirmation has to name that collateral every time; leaving four copies of
 * the dialog around is how one of them ends up quietly skipping the count, or
 * the toast, or the confirmation itself.
 *
 * So this component owns the whole step: the second confirmation, the store
 * call, the failure toast, and the in-flight guard. Callers only say *which*
 * install is pending.
 */

import { useRef, useState } from 'react';
import { useI18n, format } from '@/i18n';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

interface UninstallPluginDialogProps {
  home: string;
  /** The install awaiting confirmation; `null` closes the dialog. */
  target: InstalledPlugin | null;
  onClose: () => void;
}

export default function UninstallPluginDialog({
  home,
  target,
  onClose,
}: UninstallPluginDialogProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const uninstall = usePluginStore((s) => s.uninstall);
  const addToast = useToastStore((s) => s.addToast);
  // A package that brought an app or expert teams takes them away too, and the
  // conversations started inside the app stay readable — the user decides with
  // all three in front of them, not just the skill and connector counts.
  const isApp = useAppStore((s) => target !== null && s.installedApps.some((app) => app.pluginKey === target.key));
  const teamCount = target?.contributed.teams?.length ?? 0;
  const message = [
    format(tb.pluginsUninstallMessage, {
      name: target?.name ?? '',
      skills: target?.contributed.skills.length ?? 0,
      servers: target?.contributed.mcpServers.length ?? 0,
      agents: target?.contributed.agents.length ?? 0,
    }),
    teamCount > 0 ? format(tb.pluginsUninstallTeamsNote, { teams: teamCount }) : '',
    isApp ? tb.pluginsUninstallAppNote : '',
  ].filter((part) => part !== '').join('');

  // Uninstall is not idempotent — the second call for a key finds the package
  // directory already deleted and rejects, so a succeeded uninstall would end
  // in an error toast. The dialog closes on confirm while the row survives
  // until the store updates, which leaves exactly enough time for a fast
  // `···` → 卸载 → 确认 on the same plugin again.
  //
  // The ref is the authority: a second confirm can land before React has
  // re-rendered with the new state. The state copy exists only to grey out the
  // confirm button, so the block is visible rather than a silent no-op.
  const inFlight = useRef<Set<string>>(new Set());
  const [inFlightKeys, setInFlightKeys] = useState<readonly string[]>([]);
  const syncInFlight = () => setInFlightKeys([...inFlight.current]);

  const handleConfirm = async () => {
    if (!target || inFlight.current.has(target.key)) return;
    const { key } = target;
    inFlight.current.add(key);
    syncInFlight();
    // Close first: the row that opened this dialog disappears on success, and
    // an open dialog anchored to a removed record has nothing left to name.
    onClose();
    try {
      await uninstall(home, key);
    } catch (err) {
      addToast({
        type: 'error',
        title: tb.pluginsUninstallFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Released either way: a failed uninstall is exactly the case where the
      // user should be able to try again.
      inFlight.current.delete(key);
      syncInFlight();
    }
  };

  return (
    <ConfirmDialog
      open={target !== null}
      title={tb.pluginsUninstallTitle}
      message={message}
      confirmText={tb.pluginsUninstall}
      cancelText={t.common.cancel}
      variant="danger"
      confirmDisabled={target !== null && inFlightKeys.includes(target.key)}
      onConfirm={() => void handleConfirm()}
      onCancel={onClose}
    />
  );
}
