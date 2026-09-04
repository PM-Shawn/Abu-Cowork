/**
 * The uninstall confirmation, owned in one place.
 *
 * Four surfaces can now remove a plugin — a market row's `···` menu, an
 * orphaned install's menu, the manage dialog, and the 「我的」 list. Uninstall
 * deletes a package directory and withdraws its skills and MCP servers, so the
 * confirmation has to name that collateral every time; leaving four copies of
 * the dialog around is how one of them ends up quietly skipping the count, or
 * the toast, or the confirmation itself.
 *
 * So this component owns the whole step: the second confirmation, the store
 * call, and the failure toast. Callers only say *which* install is pending.
 */

import { useI18n, format } from '@/i18n';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
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

  const handleConfirm = async () => {
    if (!target) return;
    // Close first: the row that opened this dialog disappears on success, and
    // an open dialog anchored to a removed record has nothing left to name.
    onClose();
    try {
      await uninstall(home, target.key);
    } catch (err) {
      addToast({
        type: 'error',
        title: tb.pluginsUninstallFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <ConfirmDialog
      open={target !== null}
      title={tb.pluginsUninstallTitle}
      message={format(tb.pluginsUninstallMessage, {
        name: target?.name ?? '',
        skills: target?.contributed.skills.length ?? 0,
        servers: target?.contributed.mcpServers.length ?? 0,
      })}
      confirmText={tb.pluginsUninstall}
      cancelText={t.common.cancel}
      variant="danger"
      onConfirm={() => void handleConfirm()}
      onCancel={onClose}
    />
  );
}
