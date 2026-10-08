import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link2, ChevronDown, Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { AppDefinition, AppMode, AppScene } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useAppAddFlowStore } from '@/stores/appAddFlowStore';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { usePluginStore } from '@/stores/pluginStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';
import { mergeDraftPrefill } from '@/utils/inputCommand';
import { agentRegistry } from '@/core/agent/registry';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { expertIdentity, teamIdentity } from '@/core/team/expertContact';
import { appHomeTitle } from '@/core/app/appRegistry';
import { buildAppBinding, effectiveRun, pickMode, resolveText } from '@/core/app/appBinding';
import { liveRefCatalog, refCatalogFrom, resolveRun, runTargets, targetDisplayName, type ResolvedRun } from '@/core/app/appRefs';
import { describeSceneRun } from '@/components/app/runLabel';
import AppLogo from '@/components/app/AppLogo';
import AgentAvatar from '@/components/common/AgentAvatar';
import TeamAvatar from '@/components/team/TeamAvatar';
import { Button } from '@/components/ui/button';
import { PROMPT_GRID_CLASS, PROMPT_ITEM_CLASS } from './promptGrid';

/**
 * The welcome page inside an app (product spec §5.4), in two pieces so the
 * composer can sit between them the way it does on the general welcome page:
 * `AppHome` is the header (logo, title, slogan, connector hint) and owns the
 * effect that keeps the composer's placeholder, pinned team and the pending
 * app binding in step with the chosen mode and scene; `AppHomeScenes` is the
 * mode bar, the scene cards and the expanded scene's templates. Picking a
 * template fills the composer and pins whoever the scene's `run` names — the
 * same entry a team or expert detail uses — and the conversation created from
 * the next send carries the app binding.
 */
function useAppHomeState(app: AppDefinition): { mode: AppMode; expandedScene: AppScene | undefined } {
  const selectedModeId = useAppStore((s) => s.selectedModeIdByApp[app.appId]);
  const expandedSceneId = useAppStore((s) => s.expandedSceneIdByApp[app.appId]);
  const mode = pickMode(app, selectedModeId);
  return { mode, expandedScene: mode.scenes.find((scene) => scene.id === expandedSceneId) };
}

/**
 * Who each run of the app resolves to right now. Recomputed whenever the
 * teams, the experts or the plugins change, so a plugin removed or an expert
 * deleted since the app was added shows on the card at once.
 */
function useResolvedRuns(app: AppDefinition): (scene: AppScene | undefined) => ResolvedRun | undefined {
  const teams = useTeamStore((s) => s.teams);
  const managedTeamSources = useTeamStore((s) => s.managedTeamSources);
  const agents = useDiscoveryStore((s) => s.agents);
  const skills = useDiscoveryStore((s) => s.skills);
  const installed = usePluginStore((s) => s.installed);
  const activations = usePluginStore((s) => s.activationByKey);
  const catalog = useMemo(() => refCatalogFrom({ installed, activations, teams, managedTeamSources, agents, skills }), [teams, managedTeamSources, agents, skills, installed, activations]);
  return (scene) => {
    const run = effectiveRun(app, scene);
    return run ? resolveRun(app, run, catalog) : undefined;
  };
}

/** The team a run resolves to, for pinning the composer to it. */
function resolvedTeamId(resolved: ResolvedRun | undefined): string | undefined {
  const owner = resolved?.owner;
  return owner?.status === 'ok' && owner.kind === 'team' ? owner.team.id : undefined;
}

export default function AppHome({ app, onPlaceholderChange }: {
  app: AppDefinition;
  onPlaceholderChange: (placeholder: string | null) => void;
}) {
  const { t, format, locale } = useI18n();
  const { mode, expandedScene } = useAppHomeState(app);
  const dismissed = useAppStore((s) => s.dismissedConnectorHintByApp[app.appId] === true);
  const dismissConnectorHint = useAppStore((s) => s.dismissConnectorHint);
  const openExtensions = useSettingsStore((s) => s.openExtensions);
  const servers = useMCPStore((s) => s.servers);
  const installed = usePluginStore((s) => s.installed);
  const resolved = useResolvedRuns(app);
  const defaultTeamId = resolvedTeamId(resolved(undefined));

  // The mode and the expanded scene decide the placeholder and the binding the
  // next conversation is created with. Text the user writes themselves goes to
  // the app's default team (product spec §5.4): the pin is restored whenever
  // the home changes mode or scene, and a template replaces it with whoever
  // that scene names.
  useEffect(() => {
    const placeholder = expandedScene?.placeholder ?? app.config.composer?.placeholder;
    onPlaceholderChange(placeholder === undefined ? null : resolveText(placeholder));
    const chat = useChatStore.getState();
    chat.setPendingAppBinding(buildAppBinding(app, mode, expandedScene));
    chat.setPendingTeamId(defaultTeamId);
    return () => onPlaceholderChange(null);
  }, [app, mode, expandedScene, onPlaceholderChange, defaultTeamId]);

  // `requiredConnectors` names `<plugin>/<connector>`; the connector the user
  // sees is the one that plugin's install registered under that name.
  const missingConnectors = useMemo(() => (app.config.requiredConnectors ?? []).flatMap((value) => {
    const [plugin, name] = [value.slice(0, value.indexOf('/')), value.slice(value.indexOf('/') + 1)];
    const record = installed.find((item) => item.name === plugin && item.contributed.mcpServers.includes(name));
    return record && servers[name]?.status === 'connected' ? [] : [name];
  }), [app.config.requiredConnectors, servers, installed]);

  return (
    <div data-testid="app-home" data-app-id={app.appId} className="w-full">
      <div className="text-center mb-6">
        <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} icon={app.icon} size="xl" className="mx-auto mb-4 rounded-2xl" />
        <h1 className="text-h-xl font-semibold text-[var(--abu-text-primary)] leading-tight mb-2" data-testid="app-home-title">{appHomeTitle(app, locale)}</h1>
        {app.config.home.header?.slogan && <p className="text-body text-[var(--abu-text-tertiary)]">{resolveText(app.config.home.header.slogan)}</p>}
      </div>

      {missingConnectors.length > 0 && !dismissed && (
        <div data-testid="app-connector-hint" className="mb-5 flex items-center gap-3 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-4 py-3">
          <Link2 className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
          <div className="min-w-0 flex-1">
            <p className="text-body text-[var(--abu-text-primary)]">{format(t.appHome.connectorHintTitle, { names: missingConnectors.join('、') })}</p>
            <p className="text-caption text-[var(--abu-text-tertiary)]">{t.appHome.connectorHintBody}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => dismissConnectorHint(app.appId)}>{t.appHome.connectorHintLater}</Button>
          <Button size="sm" onClick={() => openExtensions('mcp', 'mine')}>{t.appHome.connectorHintConnect}</Button>
        </div>
      )}
    </div>
  );
}

export function AppHomeScenes({ app, visible }: { app: AppDefinition; visible: boolean }) {
  const { t, format, locale } = useI18n();
  const { mode, expandedScene } = useAppHomeState(app);
  const selectMode = useAppStore((s) => s.selectMode);
  const setExpandedScene = useAppStore((s) => s.setExpandedScene);
  const resolvedRun = useResolvedRuns(app);
  // A scene whose organization expert is being set up, or could not be.
  const [preparation, setPreparation] = useState<Record<string, { state: 'busy' | 'failed'; name: string; reason?: string }>>({});

  const describeRun = (scene: AppScene): { label: string; avatar: ReactNode; unavailable: boolean } => {
    const resolved = resolvedRun(scene);
    const { label, unavailable } = describeSceneRun(app, scene, resolved, t, format, locale);
    const owner = resolved?.owner;
    const avatar = !resolved
      ? <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} icon={app.icon} size="sm" />
      : owner?.status === 'ok' && owner.kind === 'team' ? <TeamAvatar avatar={owner.team.avatar} size="xs" round />
        : owner?.status === 'ok' && owner.kind === 'expert' ? <AgentAvatar agent={owner.agent} size="sm" />
          : owner ? <TeamAvatar size="xs" round />
            : <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-[var(--abu-bg-muted)] text-caption text-[var(--abu-text-muted)]">/</span>;
    return { label, avatar, unavailable };
  };

  /**
   * Hand the prompt to whoever the scene's run resolves to, once everything it
   * needs is there. Resolved against the live catalog: after a repair this
   * runs again from the repair's callback, and the plugin it installed has to
   * count.
   */
  const startFromTemplate = async (scene: AppScene, prompt: string): Promise<void> => {
    const run = effectiveRun(app, scene);
    const resolved = run ? resolveRun(app, run, liveRefCatalog()) : undefined;
    const chat = useChatStore.getState();
    const targets = resolved ? runTargets(resolved) : [];
    if (targets.some((target) => target.status === 'needs-plugin')) {
      // A plugin the scene needs was removed since the app was added: the
      // same confirmation as adding the app, then the scene starts.
      await useAppAddFlowStore.getState().repair(app, () => { void startFromTemplate(scene, prompt); });
      return;
    }
    const unprepared = targets.find((target) => target.status === 'needs-preparation');
    if (unprepared?.status === 'needs-preparation') {
      const name = targetDisplayName(unprepared, locale);
      setPreparation((current) => ({ ...current, [scene.id]: { state: 'busy', name } }));
      try {
        for (const roleId of unprepared.roleIds) await agentRegistry.prepareManagedAgent(roleId);
      } catch (error) {
        setPreparation((current) => ({ ...current, [scene.id]: { state: 'failed', name, reason: error instanceof Error ? error.message : String(error) } }));
        return;
      }
      setPreparation((current) => {
        const next = { ...current };
        delete next[scene.id];
        return next;
      });
      await startFromTemplate(scene, prompt);
      return;
    }
    if (targets.some((target) => target.status === 'unavailable')) return;

    const owner = resolved?.owner;
    const skill = resolved?.skill?.status === 'ok' && resolved.skill.kind === 'skill' ? resolved.skill.name : undefined;
    const draftKey = () => getComposerDraftKey(null, getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode));
    if (owner?.status === 'ok' && owner.kind === 'team') {
      prepareExpertEntry({ identity: teamIdentity(owner.team) }, prompt);
    } else if (owner?.status === 'ok' && owner.kind === 'expert') {
      prepareExpertEntry({ identity: expertIdentity(owner.agent, locale) }, prompt);
    } else if (skill) {
      // The same draft write `prepareExpertEntry` does, with the skill chip in place of an expert.
      const draft = readComposerDraft(draftKey());
      writeComposerDraft(draftKey(), { ...draft, text: mergeDraftPrefill(draft.text, prompt), selectedAgent: null });
      chat.startNewConversation();
      chat.setPendingInput(null);
    } else {
      chat.setPendingInput(prompt);
    }
    // A team or an expert can start with a skill as well: the chip joins the draft the entry just wrote.
    if (skill) writeComposerDraft(draftKey(), { ...readComposerDraft(draftKey()), selectedSkill: { name: skill, description: '' } });
    // Every route above may have reset the pending state; the binding for the
    // scene the template belongs to goes on last.
    useChatStore.getState().setPendingAppBinding(buildAppBinding(app, mode, scene));
  };

  if (!visible) return null;
  return (
    <div className="mt-4 w-full">
      {app.config.home.modes.items.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center justify-center gap-2" role="tablist" aria-label={t.appHome.modes} data-testid="app-home-modes">
          {app.config.home.modes.items.map((item) => (
            <button
              key={item.modeId}
              type="button"
              role="tab"
              aria-selected={item.modeId === mode.modeId}
              data-testid={`app-home-mode-${item.modeId}`}
              onClick={() => { selectMode(app.appId, item.modeId); setExpandedScene(app.appId, null); }}
              className={cn('rounded-full px-3 py-1 text-minor transition-colors', item.modeId === mode.modeId ? 'bg-[var(--abu-clay)] text-white' : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]')}
            >
              {resolveText(item.title)}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" data-testid="app-home-scenes">
        {mode.scenes.map((scene) => {
          const run = describeRun(scene);
          const expanded = scene.id === expandedScene?.id;
          return (
            <button
              key={scene.id}
              type="button"
              aria-expanded={expanded}
              data-testid={`app-home-scene-${scene.id}`}
              data-unavailable={run.unavailable ? 'true' : undefined}
              onClick={() => setExpandedScene(app.appId, expanded ? null : scene.id)}
              className={cn('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors', expanded ? 'border-[var(--abu-clay)] bg-[var(--abu-bg-subtle)]' : 'border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] hover:border-[var(--abu-clay-40)]')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-[var(--abu-text-primary)]">{resolveText(scene.title)}</span>
                <span className={cn('mt-0.5 flex items-center gap-1 text-caption', run.unavailable ? 'text-[var(--abu-warning)]' : 'text-[var(--abu-text-tertiary)]')}>{run.avatar}<span className="truncate">{run.label}</span></span>
              </span>
              <ChevronDown className={cn('h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)] transition-transform', expanded && 'rotate-180')} />
            </button>
          );
        })}
      </div>
      {expandedScene && (() => {
        const unavailable = describeRun(expandedScene).unavailable;
        const preparing = preparation[expandedScene.id];
        return (
          <div className="mt-4" data-testid="app-home-templates">
            <p className="mb-2 text-center text-caption text-[var(--abu-text-tertiary)]">{t.appHome.templates}</p>
            {preparing && (
              <p data-testid="app-home-preparing" data-state={preparing.state} role="status" className={cn('mb-2 flex items-center justify-center gap-1.5 text-caption', preparing.state === 'failed' ? 'text-[var(--abu-danger)]' : 'text-[var(--abu-text-tertiary)]')}>
                {preparing.state === 'busy' && <Loader2 className="h-3 w-3 animate-spin" />}
                {format(preparing.state === 'busy' ? t.appHome.scenePreparing : t.appHome.scenePrepareFailed, { name: preparing.name })}
                {preparing.reason && <span className="text-[var(--abu-text-muted)]">{preparing.reason}</span>}
              </p>
            )}
            <div className={PROMPT_GRID_CLASS}>
              {expandedScene.templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  data-testid={`app-home-template-${template.id}`}
                  className={cn(PROMPT_ITEM_CLASS, unavailable && 'cursor-not-allowed opacity-50')}
                  title={resolveText(template.prompt)}
                  disabled={unavailable || preparing?.state === 'busy'}
                  onClick={() => { void startFromTemplate(expandedScene, resolveText(template.prompt)); }}
                >
                  {resolveText(template.title)}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
