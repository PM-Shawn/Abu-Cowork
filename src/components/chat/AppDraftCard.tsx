import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { AppLocale, AppScene } from '@/types/app';
import { useAppDraftStore } from '@/stores/appDraftStore';
import { useAvailableApps } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { commitAppDraft, draftFor, draftRunLabel, readAppDraft, type AppDraftPreview } from '@/core/app/appDraft';
import { effectiveRun, resolveText } from '@/core/app/appBinding';
import { liveRefCatalog, resolveRun, type RefCatalog } from '@/core/app/appRefs';
import { appHomeTitle } from '@/core/app/appRegistry';
import { describeSceneRun } from '@/components/app/runLabel';
import AppLogo from '@/components/app/AppLogo';
import { Button } from '@/components/ui/button';

type Format = (template: string, values: Record<string, string | number>) => string;

/** Who a draft scene goes to: a new expert or team by its own name, anything else as the app home says it. */
function sceneOwner(preview: AppDraftPreview, scene: AppScene, catalog: RefCatalog, t: TranslationDict, format: Format, locale: AppLocale): string {
  const run = effectiveRun(preview.app, scene);
  const draftName = draftRunLabel(run, preview);
  if (run && draftName !== undefined) return format('team' in run ? t.appHome.sceneRunTeam : t.appHome.sceneRunExpert, { name: draftName });
  return describeSceneRun(preview.app, scene, run ? resolveRun(preview.app, run, catalog) : undefined, t, format, locale).label;
}

/**
 * 「应用预览」 in an app creation conversation (product brief §6.7, feature
 * 13), under the latest successful `app_prepare`: the home, who handles each
 * scene, the experts and expert teams that will be created, 「确认」 and
 * 「修改」. The draft folder is read when the card appears, so it shows what
 * confirming would add; confirming reads it once more.
 */
export default function AppDraftCard({ conversationId, toolCallId }: { conversationId: string; toolCallId: string }) {
  const { t, format, locale } = useI18n();
  const draft = useAppDraftStore((s) => s.draftsByConversation[conversationId]);
  const apps = useAvailableApps();
  const addToast = useToastStore((s) => s.addToast);
  const [loaded, setLoaded] = useState<{ preview: AppDraftPreview; catalog: RefCatalog } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addedAppId = draft?.appId;

  useEffect(() => {
    if (addedAppId !== undefined) return;
    let current = true;
    const catalog = liveRefCatalog();
    Promise.resolve().then(() => readAppDraft(draftFor(conversationId), catalog)).then(
      (preview) => { if (current) { setLoaded({ preview, catalog }); setError(null); } },
      (reason: unknown) => { if (current) setError(String(reason)); },
    );
    return () => { current = false; };
  }, [conversationId, toolCallId, addedAppId]);

  if (addedAppId !== undefined) {
    const app = apps.find((item) => item.appId === addedAppId);
    return (
      <div data-testid="app-draft-card" className="my-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-3 text-body text-[var(--abu-text-secondary)]">
        {format(t.appDraft.added, { name: app?.name ?? addedAppId })}
      </div>
    );
  }
  if (error !== null) {
    return (
      <div data-testid="app-draft-card" className="my-2 rounded-lg border border-[var(--abu-danger)] bg-[var(--abu-danger-bg)] p-3">
        <p className="text-h-xs text-[var(--abu-danger)]">{t.appDraft.previewFailed}</p>
        <p className="mt-1 break-words text-minor text-[var(--abu-text-secondary)]">{error}</p>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div data-testid="app-draft-card" className="my-2 flex items-center gap-2 rounded-lg border border-[var(--abu-border)] p-3 text-minor text-[var(--abu-text-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t.appDraft.title}
      </div>
    );
  }

  const { preview, catalog } = loaded;
  const modes = preview.app.config.home.modes.items;
  const confirm = () => {
    setAdding(true);
    commitAppDraft(conversationId)
      .catch((reason: unknown) => addToast({ type: 'error', title: t.appDraft.failed, message: String(reason) }))
      .finally(() => setAdding(false));
  };
  const modify = () => useChatStore.getState().requestComposerFocus();

  return (
    <div data-testid="app-draft-card" className="my-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-3">
      <div className="text-caption font-medium text-[var(--abu-text-tertiary)]">{t.appDraft.title}</div>
      <div className="mt-2 flex items-start gap-2.5">
        <AppLogo name={preview.app.name} size="md" />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-h-xs text-[var(--abu-text-primary)]">{preview.app.name}</h4>
          <p className="text-minor text-[var(--abu-text-secondary)]">{preview.app.description}</p>
        </div>
      </div>

      <section className="mt-3">
        <h5 className="text-minor font-medium text-[var(--abu-text-secondary)]">{t.appDraft.home} · {appHomeTitle(preview.app, locale)}</h5>
        {modes.map((mode) => (
          <div key={mode.modeId} className="mt-1.5">
            {modes.length > 1 && <div className="text-caption text-[var(--abu-text-tertiary)]">{resolveText(mode.title)}</div>}
            <ul className="mt-0.5 space-y-0.5">
              {mode.scenes.map((scene) => (
                <li key={scene.id} data-testid={`app-draft-scene-${scene.id}`} className="flex items-baseline gap-2 text-body">
                  <span className="text-[var(--abu-text-primary)]">{resolveText(scene.title)}</span>
                  <span className="min-w-0 truncate text-minor text-[var(--abu-text-tertiary)]">{sceneOwner(preview, scene, catalog, t, format, locale)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {preview.experts.length > 0 && (
        <section className="mt-3" data-testid="app-draft-new-experts">
          <h5 className="text-minor font-medium text-[var(--abu-text-secondary)]">{t.appDraft.newExperts}</h5>
          <ul className="mt-1 space-y-0.5">
            {preview.experts.map((expert) => (
              <li key={expert.name} className="text-body text-[var(--abu-text-primary)]">
                {expert.name}
                {expert.description && <span className="ml-2 text-minor text-[var(--abu-text-tertiary)]">{expert.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.teams.length > 0 && (
        <section className="mt-3" data-testid="app-draft-new-teams">
          <h5 className="text-minor font-medium text-[var(--abu-text-secondary)]">{t.appDraft.newTeams}</h5>
          <ul className="mt-1 space-y-0.5">
            {preview.teams.map((team) => (
              <li key={team.id} className="text-body text-[var(--abu-text-primary)]">
                {resolveText(team.name)}
                <span className="ml-2 text-minor text-[var(--abu-text-tertiary)]">{resolveText(team.description)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" data-testid="app-draft-modify" disabled={adding} onClick={modify}>{t.appDraft.modify}</Button>
        <Button size="sm" data-testid="app-draft-confirm" disabled={adding} onClick={confirm}>
          {adding ? t.appDraft.adding : t.appDraft.confirm}
        </Button>
      </div>
    </div>
  );
}
