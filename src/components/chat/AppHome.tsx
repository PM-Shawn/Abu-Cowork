import { useEffect, useMemo, type ReactNode } from 'react';
import { Link2, ChevronDown } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { AppDefinition, AppMode, AppScene } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';
import { mergeDraftPrefill } from '@/utils/inputCommand';
import { agentRegistry } from '@/core/agent/registry';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { expertIdentity, teamIdentity } from '@/core/team/expertContact';
import { appHomeTitle } from '@/core/app/appRegistry';
import { buildAppBinding, effectiveRun, pickMode, resolveText, runExpertName, runTeamId } from '@/core/app/appBinding';
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
    chat.setPendingTeamId(runTeamId(app, app.config.defaultRun));
    return () => onPlaceholderChange(null);
  }, [app, mode, expandedScene, onPlaceholderChange]);

  const missingConnectors = useMemo(() => (app.config.requiredConnectors ?? []).filter((name) => servers[name]?.status !== 'connected'), [app.config.requiredConnectors, servers]);

  return (
    <div data-testid="app-home" data-app-id={app.appId} className="w-full">
      <div className="text-center mb-6">
        <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} size="xl" className="mx-auto mb-4 rounded-2xl" />
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
  const teams = useTeamStore((s) => s.teams);
  const discoveredAgents = useDiscoveryStore((s) => s.agents);
  const agentNames = useMemo(() => new Set(discoveredAgents.map((meta) => meta.name)), [discoveredAgents]);

  const describeRun = (scene: AppScene): { label: string; avatar: ReactNode } => {
    const run = effectiveRun(app, scene);
    if (!run) return { label: t.appHome.sceneRunDefault, avatar: <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} size="sm" /> };
    if ('team' in run) {
      const team = teams.find((item) => item.id === runTeamId(app, run));
      return { label: format(t.appHome.sceneRunTeam, { name: team?.name ?? run.team }), avatar: <TeamAvatar avatar={team?.avatar} size="xs" round /> };
    }
    if ('expert' in run) {
      const name = runExpertName(run)!;
      const agent = agentNames.has(name) ? agentRegistry.getAgent(name) : undefined;
      return { label: format(t.appHome.sceneRunExpert, { name: agent?.displayNames?.[locale] ?? name }), avatar: <AgentAvatar agent={agent ?? { name }} size="sm" /> };
    }
    return { label: format(t.appHome.sceneRunSkill, { name: run.skill }), avatar: <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-[var(--abu-bg-muted)] text-caption text-[var(--abu-text-muted)]">/</span> };
  };

  const startFromTemplate = (scene: AppScene, prompt: string) => {
    const run = effectiveRun(app, scene);
    const chat = useChatStore.getState();
    if (run && 'team' in run) {
      const teamId = runTeamId(app, run)!;
      const team = teams.find((item) => item.id === teamId);
      if (!team) throw new Error(`team "${teamId}" is not available`);
      prepareExpertEntry({ identity: teamIdentity(team) }, prompt);
    } else if (run && 'expert' in run) {
      const name = runExpertName(run)!;
      const agent = agentRegistry.getAgent(name);
      if (!agent) throw new Error(`expert "${name}" is not available`);
      prepareExpertEntry({ identity: expertIdentity(agent, locale) }, prompt);
    } else if (run && 'skill' in run) {
      // The same draft write `prepareExpertEntry` does, with the skill chip in place of an expert.
      const key = getComposerDraftKey(null, getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode));
      const draft = readComposerDraft(key);
      writeComposerDraft(key, { ...draft, text: mergeDraftPrefill(draft.text, prompt), selectedAgent: null, selectedSkill: { name: run.skill, description: '' } });
      chat.startNewConversation();
      chat.setPendingInput(null);
    } else {
      chat.setPendingInput(prompt);
    }
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
              onClick={() => setExpandedScene(app.appId, expanded ? null : scene.id)}
              className={cn('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors', expanded ? 'border-[var(--abu-clay)] bg-[var(--abu-bg-subtle)]' : 'border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] hover:border-[var(--abu-clay-40)]')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-[var(--abu-text-primary)]">{resolveText(scene.title)}</span>
                <span className="mt-0.5 flex items-center gap-1 text-caption text-[var(--abu-text-tertiary)]">{run.avatar}<span className="truncate">{run.label}</span></span>
              </span>
              <ChevronDown className={cn('h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)] transition-transform', expanded && 'rotate-180')} />
            </button>
          );
        })}
      </div>
      {expandedScene && (
        <div className="mt-4" data-testid="app-home-templates">
          <p className="mb-2 text-center text-caption text-[var(--abu-text-tertiary)]">{t.appHome.templates}</p>
          <div className={PROMPT_GRID_CLASS}>
            {expandedScene.templates.map((template) => (
              <button
                key={template.id}
                type="button"
                data-testid={`app-home-template-${template.id}`}
                className={PROMPT_ITEM_CLASS}
                title={resolveText(template.prompt)}
                onClick={() => startFromTemplate(expandedScene, resolveText(template.prompt))}
              >
                {resolveText(template.title)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
