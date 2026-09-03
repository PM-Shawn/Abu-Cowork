/**
 * The install disclosure — the one screen in the plugin flow that has to be
 * right.
 *
 * Installing a plugin registers skills the model will read and MCP servers
 * that are *arbitrary local executables*. The user is the only party who can
 * judge whether they trust that, and they can only judge it if they see the
 * literal command line. So `command + args` is rendered verbatim, joined the
 * way a shell would show it, never summarised as "1 connector" — a count is
 * not consent.
 *
 * The dialog is purely presentational: it renders a plan state and reports the
 * two decisions. Nothing here touches the filesystem, which is what lets the
 * caller guarantee `installPlugin` cannot run before `onConfirm` fires.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, Sparkles, Server, ShieldCheck } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { InstallDisclosure } from '@/core/plugin/installer';
import type { PluginSource } from '@/core/plugin/marketplace';
import { formatServerCommand } from './serverCommand';

export type InstallPlanState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      disclosure: InstallDisclosure;
      /**
       * The artifact's authorship could not be verified — it carried no
       * signature Abu could check. Optional and defaulting to "not shown": the
       * personal / marketplace path has no signing concept at all, and a
       * screen that warned about it there would be noise.
       *
       * Set it on the organization path whenever verification was skipped
       * (e.g. the bound console advertises no signing key), so the user reads
       * that BEFORE confirming rather than after the code is on disk.
       */
      unsigned?: boolean;
    }
  /** `planInstall` threw `UnsupportedSourceError` — a real, expected outcome
   *  for ~82% of the official marketplace, not a crash. */
  | { kind: 'unsupported'; sourceKind: PluginSource['kind'] }
  /** A refusal, not always a corrupt package: the caller may supply its own
   *  heading (e.g. an organization policy denial) so an administrator's block
   *  does not read as "could not read the plugin package". */
  | { kind: 'error'; message: string; title?: string };

interface InstallDisclosureDialogProps {
  open: boolean;
  /** Name from the marketplace listing — available before the plan resolves. */
  entryName: string;
  state: InstallPlanState;
  installing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-h-xs text-[var(--abu-text-primary)]">
        <Icon className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
        {title}
      </h4>
      {children}
    </section>
  );
}

export default function InstallDisclosureDialog({
  open,
  entryName,
  state,
  installing,
  onConfirm,
  onCancel,
}: InstallDisclosureDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !installing) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, installing, onCancel]);

  const { t } = useI18n();
  if (!open) return null;

  const tb = t.toolbox;
  const isReady = state.kind === 'ready';

  const title = state.kind === 'unsupported' ? tb.pluginsUnsupportedTitle : tb.pluginsDisclosureTitle;

  const body = (() => {
    switch (state.kind) {
      case 'loading':
        return (
          <p className="flex items-center gap-2 text-body text-[var(--abu-text-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {tb.pluginsDisclosureLoading}
          </p>
        );

      case 'unsupported':
        return (
          <div
            data-testid="plugin-unsupported-notice"
            className="flex items-start gap-2.5 rounded-lg bg-[var(--abu-warning-bg)] p-3"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-warning)]" />
            <p className="text-body leading-relaxed text-[var(--abu-text-primary)]">
              {format(tb.pluginsUnsupportedRemote, { name: entryName })}
            </p>
          </div>
        );

      case 'error':
        return (
          <div className="flex items-start gap-2.5 rounded-lg bg-[var(--abu-danger-bg)] p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-danger)]" />
            <div className="min-w-0">
              <p className="text-h-xs text-[var(--abu-text-primary)]">
                {state.title ?? tb.pluginsPlanFailed}
              </p>
              <p className="mt-1 break-words text-minor text-[var(--abu-text-tertiary)]">
                {state.message}
              </p>
            </div>
          </div>
        );

      case 'ready': {
        const d = state.disclosure;
        return (
          <div className="space-y-4">
            <p className="text-body text-[var(--abu-text-tertiary)]">
              {format(tb.pluginsDisclosureSubtitle, { name: d.name })}
            </p>

            {/* Above every payload section on purpose: the dialog scrolls, and
                "we cannot confirm who built this" is what decides whether to
                read the rest at all. */}
            {state.unsigned && (
              <div
                data-testid="plugin-disclosure-unsigned"
                className="flex items-start gap-2.5 rounded-lg bg-[var(--abu-warning-bg)] p-3"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-warning)]" />
                <p className="text-body leading-relaxed text-[var(--abu-text-primary)]">
                  {tb.pluginsDisclosureUnsigned}
                </p>
              </div>
            )}

            <Section icon={ShieldCheck} title={tb.pluginsDisclosureSource}>
              <p className="text-body text-[var(--abu-text-secondary)]">
                {d.marketplace}
                {d.version ? ` · v${d.version}` : ''}
              </p>
              <p className="break-all font-mono text-minor text-[var(--abu-text-muted)]">
                {d.sourceDir}
              </p>
            </Section>

            <Section icon={Sparkles} title={tb.pluginsDisclosureSkills}>
              {d.skills.length === 0 ? (
                <p className="text-body text-[var(--abu-text-muted)]">{tb.pluginsDisclosureNone}</p>
              ) : (
                <ul className="space-y-1">
                  {d.skills.map((skill) => (
                    <li
                      key={skill}
                      className="rounded bg-[var(--abu-bg-muted)] px-2 py-1 text-body text-[var(--abu-text-secondary)]"
                    >
                      {skill}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section icon={Server} title={tb.pluginsDisclosureServers}>
              {d.mcpServers.length === 0 ? (
                <p className="text-body text-[var(--abu-text-muted)]">{tb.pluginsDisclosureNone}</p>
              ) : (
                <>
                  {/* The whole point of this screen: the literal command line,
                      not a count. Never truncate it — wrap instead. */}
                  <ul className="space-y-1.5">
                    {d.mcpServers.map((server) => (
                      <li
                        key={server.name}
                        data-testid="plugin-disclosure-server"
                        className="rounded-lg bg-[var(--abu-bg-muted)] px-2.5 py-2"
                      >
                        <p className="text-body font-medium text-[var(--abu-text-primary)]">
                          {server.name}
                        </p>
                        <p className="mt-0.5 break-all font-mono text-minor text-[var(--abu-text-secondary)]">
                          {formatServerCommand(server)}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="flex items-start gap-1.5 text-minor text-[var(--abu-warning)]">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {tb.pluginsDisclosureServersHint}
                  </p>
                </>
              )}
            </Section>

            {d.capabilities && d.capabilities.length > 0 && (
              <Section icon={ShieldCheck} title={tb.pluginsDisclosureCapabilities}>
                <div className="flex flex-wrap gap-1.5">
                  {d.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="rounded-full bg-[var(--abu-info-bg)] px-2 py-0.5 text-caption text-[var(--abu-info)]"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {(d.skippedSymlinks?.length ?? 0) > 0 && (
              <Section icon={AlertTriangle} title={tb.pluginsDisclosureSymlinkTitle}>
                <p
                  data-testid="plugin-disclosure-symlinks"
                  className="text-minor text-[var(--abu-text-muted)]"
                >
                  {format(tb.pluginsDisclosureSymlinkHint, {
                    paths: (d.skippedSymlinks ?? []).join('、'),
                  })}
                </p>
              </Section>
            )}

            {d.ignoredPayloads.length > 0 && (
              <Section icon={AlertTriangle} title={tb.pluginsDisclosureIgnoredTitle}>
                <p
                  data-testid="plugin-disclosure-ignored"
                  className="text-minor text-[var(--abu-text-muted)]"
                >
                  {format(tb.pluginsDisclosureIgnoredHint, {
                    payloads: d.ignoredPayloads.join('、'),
                  })}
                </p>
              </Section>
            )}
          </div>
        );
      }
    }
  })();

  return createPortal(
    <div
      data-electron-no-drag
      data-testid="plugin-install-disclosure"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-6 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !installing) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[80vh] w-[520px] flex-col rounded-2xl bg-[var(--abu-bg-base)] shadow-xl animate-in zoom-in-95 duration-150"
      >
        <h3 className="shrink-0 px-6 pt-6 text-h-sm text-[var(--abu-text-primary)]">{title}</h3>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{body}</div>

        <div className="flex shrink-0 items-center justify-end gap-3 px-6 pb-6">
          {isReady ? (
            <>
              <Button variant="ghost" onClick={onCancel} disabled={installing}>
                {t.common.cancel}
              </Button>
              <Button data-testid="plugin-install-confirm" onClick={onConfirm} disabled={installing}>
                {installing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {installing ? tb.pluginsInstalling : tb.pluginsInstall}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onCancel}>
              {t.common.close}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
