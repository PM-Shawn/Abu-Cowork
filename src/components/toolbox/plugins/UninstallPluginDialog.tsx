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
 * install is pending. It renders nothing itself: the question is the
 * design-system confirmation.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n, format } from '@/i18n';
import { useConfirm } from '@/components/ds/confirm-context';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

interface UninstallPluginDialogProps {
  home: string;
  /** The install awaiting confirmation; `null` means nothing is being asked. */
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
  const confirm = useConfirm();
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
  // in an error toast. The question closes on confirm while the row survives
  // until the store updates, which leaves exactly enough time for a fast
  // `···` → 卸载 → 确认 on the same plugin again.
  //
  // The ref is the authority: a second confirm for a key that is in flight
  // closes the question and calls nothing.
  const inFlight = useRef<Set<string>>(new Set());

  // What the answer acts on is read when the answer arrives, not when the question was asked.
  const latest = useRef({ home, onClose, uninstall, addToast, message, tb });
  useLayoutEffect(() => { latest.current = { home, onClose, uninstall, addToast, message, tb }; });

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The key whose question is on screen. One question per target: an effect that runs again
  // for the same install (StrictMode, a new object for the same record) asks nothing.
  const asked = useRef<string | null>(null);
  const key = target?.key ?? null;
  useEffect(() => {
    if (key === null) {
      asked.current = null;
      return;
    }
    if (asked.current === key) return;
    asked.current = key;
    const handleConfirm = async () => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      const now = latest.current;
      // Close first: the row that opened this question disappears on success, and
      // an owner anchored to a removed record has nothing left to name.
      now.onClose();
      try {
        await now.uninstall(now.home, key);
      } catch (err) {
        latest.current.addToast({
          type: 'error',
          title: now.tb.pluginsUninstallFailed,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Released either way: a failed uninstall is exactly the case where the
        // user should be able to try again.
        inFlight.current.delete(key);
      }
    };
    const { message: text, tb: copy } = latest.current;
    void confirm({ title: copy.pluginsUninstallTitle, message: text, confirmLabel: copy.pluginsUninstall, tone: 'danger' }).then((confirmed) => {
      // The page that asked has gone, or the owner moved on (to nothing, or to another install
      // whose own question replaced this one): this answer is for nobody.
      if (!mounted.current || asked.current !== key) return;
      asked.current = null;
      if (!confirmed) {
        latest.current.onClose();
        return;
      }
      // Uninstalled from somewhere else while the question was on screen, or still being uninstalled.
      const installedNow = usePluginStore.getState().installed.some((plugin) => plugin.key === key);
      if (!installedNow || inFlight.current.has(key)) {
        latest.current.onClose();
        return;
      }
      void handleConfirm();
    });
  }, [key, confirm]);

  return null;
}
