import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { BUSY } from '@/components/ds/styles';
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
        <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} icon={app.icon} size="xl" className="mx-auto mb-4 rounded-window" />
        <h1 className="mb-2 text-title-lg text-label" data-testid="app-home-title">{appHomeTitle(app, locale)}</h1>
        {app.config.home.header?.slogan && <p className="text-ui text-label-secondary">{resolveText(app.config.home.header.slogan)}</p>}
      </div>

      {missingConnectors.length > 0 && !dismissed && (
        <div data-testid="app-connector-hint" className="mb-5 flex items-center gap-3 rounded-panel border border-separator bg-surface px-4 py-3">
          <Icon icon={AppIcons.link} className="shrink-0 text-label-tertiary" />
          <div className="min-w-0 flex-1">
            <p className="text-ui text-label">{format(t.appHome.connectorHintTitle, { names: missingConnectors.join('、') })}</p>
            <p className="text-caption text-label-tertiary">{t.appHome.connectorHintBody}</p>
          </div>
          <Button size="sm" variant="plain" onClick={() => dismissConnectorHint(app.appId)}>{t.appHome.connectorHintLater}</Button>
          <Button size="sm" variant="primary" onClick={() => openExtensions('mcp', 'mine')}>{t.appHome.connectorHintConnect}</Button>
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
  // The scenes whose template is being handed over: one start per scene at a time.
  const startingRef = useRef(new Set<string>());

  const describeRun = (scene: AppScene): { label: string; avatar: ReactNode; unavailable: boolean } => {
    const resolved = resolvedRun(scene);
    const { label, unavailable } = describeSceneRun(app, scene, resolved, t, format, locale);
    const owner = resolved?.owner;
    const avatar = !resolved
      ? <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} icon={app.icon} size="sm" />
      : owner?.status === 'ok' && owner.kind === 'team' ? <TeamAvatar avatar={owner.team.avatar} size="xs" round />
        : owner?.status === 'ok' && owner.kind === 'expert' ? <AgentAvatar agent={owner.agent} size="sm" />
          : owner ? <TeamAvatar size="xs" round />
            : <span className="inline-flex h-4 w-4 items-center justify-center rounded-control bg-fill text-caption text-label-tertiary">/</span>;
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
  const start = (scene: AppScene, prompt: string) => {
    if (startingRef.current.has(scene.id)) return;
    startingRef.current.add(scene.id);
    void startFromTemplate(scene, prompt).finally(() => { startingRef.current.delete(scene.id); });
  };

  if (!visible) return null;
  return (
    <div className="mt-4 w-full">
      {app.config.home.modes.items.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center justify-center gap-2" role="tablist" aria-label={t.appHome.modes} data-testid="app-home-modes">
          {app.config.home.modes.items.map((item) => (
            <Pressable
              key={item.modeId}
              role="tab"
              aria-selected={item.modeId === mode.modeId}
              data-testid={`app-home-mode-${item.modeId}`}
              onClick={() => { selectMode(app.appId, item.modeId); setExpandedScene(app.appId, null); }}
              className={cn('h-6 rounded-control px-3 text-ui-sm transition-colors duration-fast', item.modeId === mode.modeId ? 'bg-fill-selected text-label' : 'bg-fill text-label-secondary hover:bg-fill-hover')}
            >
              {resolveText(item.title)}
            </Pressable>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" data-testid="app-home-scenes">
        {mode.scenes.map((scene) => {
          const run = describeRun(scene);
          const expanded = scene.id === expandedScene?.id;
          return (
            <Pressable
              key={scene.id}
              aria-expanded={expanded}
              data-testid={`app-home-scene-${scene.id}`}
              data-unavailable={run.unavailable ? 'true' : undefined}
              onClick={() => setExpandedScene(app.appId, expanded ? null : scene.id)}
              className={cn(PROMPT_ITEM_CLASS, 'flex items-center gap-2', expanded && 'border-control-border bg-fill-selected')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-label">{resolveText(scene.title)}</span>
                <span className={cn('mt-1 flex items-center gap-1 text-caption', run.unavailable ? 'text-warning' : 'text-label-tertiary')}>{run.avatar}<span className="truncate">{run.label}</span></span>
              </span>
              <span className={cn('inline-flex shrink-0 text-label-tertiary', expanded && 'rotate-180')}>
                <Icon icon={AppIcons.expand} />
              </span>
            </Pressable>
          );
        })}
      </div>
      {expandedScene && (() => {
        const unavailable = describeRun(expandedScene).unavailable;
        const preparing = preparation[expandedScene.id];
        const working = preparing?.state === 'busy';
        return (
          <div className="mt-4" data-testid="app-home-templates">
            <p className="mb-2 text-center text-caption text-label-tertiary">{t.appHome.templates}</p>
            {preparing && (
              <p data-testid="app-home-preparing" data-state={preparing.state} role="status" className={cn('mb-2 flex items-center justify-center gap-2 text-caption', preparing.state === 'failed' ? 'text-danger' : 'text-label-tertiary')}>
                {working && <span data-ds-spinner className="inline-flex animate-spin"><Icon icon={AppIcons.loading} size="sm" /></span>}
                {format(working ? t.appHome.scenePreparing : t.appHome.scenePrepareFailed, { name: preparing.name })}
                {preparing.reason && <span className="text-label-tertiary">{preparing.reason}</span>}
              </p>
            )}
            <div className={PROMPT_GRID_CLASS}>
              {expandedScene.templates.map((template) => (
                // A template whose scene is being set up keeps the focus it was pressed with.
                <Pressable
                  key={template.id}
                  data-testid={`app-home-template-${template.id}`}
                  className={cn(PROMPT_ITEM_CLASS, 'not-aria-disabled:hover:bg-fill-hover', BUSY)}
                  title={resolveText(template.prompt)}
                  disabled={unavailable}
                  aria-disabled={working || undefined}
                  onClick={() => start(expandedScene, resolveText(template.prompt))}
                >
                  {resolveText(template.title)}
                </Pressable>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
