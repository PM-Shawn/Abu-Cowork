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

import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react';
import { useI18n, format } from '@/i18n';
import { resolveText } from '@/core/app/appBinding';
import { roleIdAgentName } from '@/core/team/roleIdentity';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { PLUGIN_CONFIG_VALUE_LIMIT, pluginConfigFields } from '@/core/plugin/configuration';
import { cn } from '@/lib/utils';
import type { InstallDisclosure, PluginAgentDisclosure } from '@/core/plugin/installer';
import type { PluginSource } from '@/core/plugin/marketplace';
import { formatServerCommand } from './serverCommand';
import { DETAIL_WINDOW_CONTENT_HEIGHT } from '../windowHeight';

export type InstallPlanState =
  | { kind: 'loading' }
  | { kind: 'unchanged' }
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
  authoring?: boolean;
  updating?: boolean;
  /** Name from the marketplace listing — available before the plan resolves. */
  entryName: string;
  state: InstallPlanState;
  installing: boolean;
  onConfirm: (configuration: Record<string, string>) => void;
  onCancel: () => void;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

function Section({
  icon,
  title,
  children,
}: {
  /** A design-system icon: callers pass `AppIcons.*`. */
  icon: ComponentProps<typeof Icon>['icon'];
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-2 text-ui font-medium text-label">
        <Icon icon={icon} size="sm" className="text-label-tertiary" />
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * The one short tag a skipped agent carries. `undefined` means the agent
 * installs — no tag, no grey.
 */
function skipReason(
  conflict: PluginAgentDisclosure['conflict'],
  tb: { pluginsDisclosureAgentExists: string; pluginsDisclosureAgentUnsafeName: string; pluginsDisclosureAgentEmptyPrompt: string },
): string | undefined {
  switch (conflict) {
    case 'exists':
      return tb.pluginsDisclosureAgentExists;
    case 'unsafe-name':
      return tb.pluginsDisclosureAgentUnsafeName;
    case 'empty-prompt':
      return tb.pluginsDisclosureAgentEmptyPrompt;
    case undefined:
      // No conflict: the agent installs, so no tag and no grey.
      return undefined;
    default: {
      // Exhaustiveness guard — a new `conflict` kind must bring its own copy
      // here. Falling through to `undefined` would render an agent that will be
      // SKIPPED as one that installs, which is the one thing this dialog exists
      // to prevent. The assignment makes that a compile error first; at runtime
      // the raw kind still greys the row rather than hiding the skip.
      const _exhaustive: never = conflict;
      return _exhaustive;
    }
  }
}

// One disclosed item: a filled row inside its section's list.
const ITEM = 'rounded-control bg-fill px-2 py-1';

export default function InstallDisclosureDialog({
  open,
  authoring = false,
  updating: updatingNow = false,
  entryName: entryNameNow,
  state: stateNow,
  installing,
  onConfirm,
  onCancel,
  onCloseAutoFocus,
}: InstallDisclosureDialogProps) {
  // The window stays on the page while it fades out: it keeps showing what it showed when it closed.
  const [held, setHeld] = useState({ state: stateNow, entryName: entryNameNow, updating: updatingNow });
  if (open && (held.state !== stateNow || held.entryName !== entryNameNow || held.updating !== updatingNow)) {
    setHeld({ state: stateNow, entryName: entryNameNow, updating: updatingNow });
  }
  const { state, entryName, updating } = open ? { state: stateNow, entryName: entryNameNow, updating: updatingNow } : held;

  const [configuration, setConfiguration] = useState<Record<string, string>>({});
  const preparation = state.kind === 'ready' ? state.disclosure.preparedToken : undefined;
  // What was typed is forgotten when the window closes and when another package is previewed.
  useEffect(() => { setConfiguration({}); }, [open, preparation]);
  const fields = state.kind === 'ready' ? pluginConfigFields(state.disclosure.manifest.mcpServers) : [];
  const { t } = useI18n();

  const tb = t.toolbox;
  const isReady = state.kind === 'ready';

  const title = state.kind === 'unsupported' ? tb.pluginsUnsupportedTitle : updating ? tb.pluginsUpdateDisclosureTitle : tb.pluginsDisclosureTitle;

  const body = (() => {
    switch (state.kind) {
      case 'unchanged':
        return <p role="status" className="text-ui text-label-secondary">{tb.pluginsUnchanged}</p>;

      case 'loading':
        return <Spinner label={tb.pluginsDisclosureLoading} />;

      case 'unsupported':
        return (
          <div data-testid="plugin-unsupported-notice">
            <InlineMessage tone="info">{format(tb.pluginsUnsupportedRemote, { name: entryName })}</InlineMessage>
          </div>
        );

      case 'error':
        return (
          <InlineMessage tone="danger">
            <p className="font-medium">{state.title ?? tb.pluginsPlanFailed}</p>
            <p className="break-words text-ui-sm text-label-secondary">{state.message}</p>
          </InlineMessage>
        );

      case 'ready': {
        const d = state.disclosure;
        return (
          <div className="space-y-4">
            <p className="text-ui text-label-tertiary">
              {format(updating ? tb.pluginsUpdateDisclosureSubtitle : tb.pluginsDisclosureSubtitle, { name: d.name })}
              {authoring && !updating && <span role="status" className="mt-2 block text-label-secondary">{tb.pluginsValidationPassed}</span>}
            </p>

            {/* Above every payload section on purpose: the dialog scrolls, and
                "we cannot confirm who built this" is what decides whether to
                read the rest at all. */}
            {state.unsigned && (
              <div data-testid="plugin-disclosure-unsigned">
                <InlineMessage tone="warning">{tb.pluginsDisclosureUnsigned}</InlineMessage>
              </div>
            )}

            <PluginConfigurationFields fields={fields} values={configuration} onChange={setConfiguration} />
            <PluginDisclosureSections disclosure={d} />
          </div>
        );
      }
    }
  })();

  const footer = isReady ? (
    <>
      <Button variant="plain" onClick={onCancel} disabled={installing}>
        {t.common.cancel}
      </Button>
      <Button
        variant="primary"
        data-testid="plugin-install-confirm"
        busy={installing}
        disabled={fields.some(field => !configuration[field]?.trim())}
        // The window stays on the page while it fades out; a key press there confirms nothing.
        onClick={() => { if (open) onConfirm(configuration); }}
      >
        {installing ? (updating ? tb.pluginsUpdating : tb.pluginsInstalling) : updating ? tb.pluginsUpdate : tb.pluginsInstall}
      </Button>
    </>
  ) : (
    <Button variant="plain" onClick={onCancel}>
      {t.common.close}
    </Button>
  );

  return (
    <Dialog
      open={open}
      // Escape, a press outside and the close button ask to close; an installation that is running is never left.
      onOpenChange={(next) => { if (!next && !installing) onCancel(); }}
      // For an approval the window steps aside while it installs, and comes back.
      busy={installing}
      // The confirming button is painted when the package has been read, later than the press that
      // opened the window; another package shown in the same window is read anew.
      settles
      settleKey={`${state.kind}:${preparation ?? ''}`}
      // A draft's preview takes the place of the draft's detail window: same width, a title row as
      // tall as that window's header and the same content height, so the window does not jump
      // when one replaces the other. The title is the window's one heading in both forms.
      title={authoring ? <span className="flex h-11 items-center">{title}</span> : title}
      size="lg"
      // Without a plan the footer's one button is Close, so the corner button would be a second control of that name.
      closeButton={isReady && !installing}
      contentProps={{ 'data-testid': 'plugin-install-disclosure' }}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={footer}
    >
      {authoring ? <div className={DETAIL_WINDOW_CONTENT_HEIGHT}>{body}</div> : body}
    </Dialog>
  );
}

/**
 * The values a plugin's connectors ask for (`${config.…}`), one masked field
 * each. Shown before anything is installed; the confirm button stays disabled
 * until every field has a value. The value goes to the caller on confirm and
 * is shown nowhere.
 */
export function PluginConfigurationFields({ fields, values, onChange }: {
  fields: string[];
  values: Record<string, string>;
  onChange: (next: (current: Record<string, string>) => Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const fieldId = useId();
  if (fields.length === 0) return null;
  return (
    <Section icon={AppIcons.connector} title={tb.pluginsConfiguration}>
      <p className="text-ui-sm text-label-tertiary">{tb.pluginsConfigurationHint}</p>
      {fields.map(field => (
        <div key={field}>
          <label htmlFor={`${fieldId}-${field}`} className="mb-1 block text-ui-sm font-medium text-label-secondary">{field}</label>
          <TextField
            id={`${fieldId}-${field}`}
            type="password"
            maxLength={PLUGIN_CONFIG_VALUE_LIMIT}
            autoComplete="new-password"
            value={values[field] ?? ''}
            onChange={event => onChange(current => ({ ...current, [field]: event.target.value }))}
          />
        </div>
      ))}
    </Section>
  );
}

/**
 * Everything one plugin brings, as the user must see it before installing:
 * where it comes from, its skills, the literal command line of every
 * connector, its experts (with the ones that will be skipped), its teams, what
 * it says it can do, and what it ships that Abu will not use. The plugin
 * install dialog and the app confirmation page both render this.
 */
export function PluginDisclosureSections({ disclosure: d }: { disclosure: InstallDisclosure }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  return (
    <>
      <Section icon={AppIcons.capability} title={tb.pluginsDisclosureSource}>
        <p className="text-ui text-label-secondary">
          {d.marketplace.startsWith('author-') ? tb.pluginsAuthoredSource : d.marketplace}
          {d.version ? ` · v${d.version}` : ''}
        </p>
        <p className="break-all font-code text-ui-sm text-label-tertiary">
          {d.sourceDir}
        </p>
      </Section>

      {d.skills.length > 0 && (
        <Section icon={AppIcons.sparkles} title={tb.pluginsDisclosureSkills}>
          <ul className="space-y-1">
            {d.skills.map((skill) => (
              <li key={skill} className={cn(ITEM, 'text-ui text-label-secondary')}>
                {skill}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d.mcpServers.length > 0 && (
        <Section icon={AppIcons.connector} title={tb.pluginsDisclosureServers}>
          {/* The whole point of this screen: the literal command line,
              not a count. Never truncate it — wrap instead. */}
          <ul className="space-y-2">
            {d.mcpServers.map((server) => (
              <li
                key={server.name}
                data-testid="plugin-disclosure-server"
                className="rounded-control bg-fill px-2 py-2"
              >
                <p className="text-ui font-medium text-label">
                  {server.name}
                </p>
                <p className="mt-1 break-all font-code text-ui-sm text-label-secondary">
                  {formatServerCommand(server)}
                </p>
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-2 text-ui-sm text-label-secondary">
            <Icon icon={AppIcons.warning} size="sm" className="mt-0.5 text-warning" />
            {tb.pluginsDisclosureServersHint}
          </p>
        </Section>
      )}

      {d.agents.length > 0 && (
        <Section icon={AppIcons.agent} title={tb.pluginsDisclosureAgents}>
          <ul className="space-y-1">
            {d.agents.map((agent) => {
              // A conflicting entry is disclosed, not installed: it is
              // greyed and carries the one-line reason, so the user reads
              // "this one will not arrive" before confirming rather than
              // wondering afterwards where it went.
              const reason = skipReason(agent.conflict, tb);
              return (
                <li
                  key={`${agent.name}:${agent.conflict ?? ''}`}
                  data-testid="plugin-disclosure-agent"
                  aria-disabled={reason ? true : undefined}
                  className={cn(ITEM, reason ? 'text-label-tertiary' : 'text-label-secondary')}
                >
                  <p className="text-ui">
                    <span className="font-medium">{agent.name}</span>
                    {reason && (
                      <span className="ml-2 text-ui-sm text-label-tertiary">
                        {reason}
                      </span>
                    )}
                  </p>
                  {agent.description && (
                    <p className="mt-1 text-ui-sm text-label-tertiary">
                      {agent.description}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {(d.teams?.length ?? 0) > 0 && (
        <Section icon={AppIcons.team} title={tb.pluginsDisclosureTeams}>
          <ul className="space-y-1">
            {d.teams!.map((team) => (
              <li key={team.id} data-testid="plugin-disclosure-team" className={cn(ITEM, 'text-label-secondary')}>
                <p className="text-ui"><span className="font-medium">{resolveText(team.name)}</span></p>
                <p className="mt-1 text-ui-sm text-label-tertiary">{resolveText(team.description)}</p>
                <p className="mt-1 text-ui-sm text-label-tertiary">{team.memberRoleIds.map((roleId) => roleIdAgentName(roleId) ?? roleId).join('、')}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d.capabilities && d.capabilities.length > 0 && (
        <Section icon={AppIcons.capability} title={tb.pluginsDisclosureCapabilities}>
          <div className="flex flex-wrap gap-2">
            {d.capabilities.map((cap) => <Tag key={cap}>{cap}</Tag>)}
          </div>
        </Section>
      )}

      {(d.skippedSymlinks?.length ?? 0) > 0 && (
        <Section icon={AppIcons.warning} title={tb.pluginsDisclosureSymlinkTitle}>
          <p
            data-testid="plugin-disclosure-symlinks"
            className="text-ui-sm text-label-tertiary"
          >
            {format(tb.pluginsDisclosureSymlinkHint, {
              paths: (d.skippedSymlinks ?? []).join(tb.pluginsDisclosureSymlinkSeparator),
            })}
          </p>
        </Section>
      )}

      {d.ignoredPayloads.length > 0 && (
        <Section icon={AppIcons.warning} title={tb.pluginsDisclosureIgnoredTitle}>
          <p
            data-testid="plugin-disclosure-ignored"
            className="text-ui-sm text-label-tertiary"
          >
            {format(tb.pluginsDisclosureIgnoredHint, {
              payloads: d.ignoredPayloads.join('、'),
            })}
          </p>
        </Section>
      )}
    </>
  );
}
