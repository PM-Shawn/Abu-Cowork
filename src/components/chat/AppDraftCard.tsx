import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
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
import { Button } from '@/components/ds/button';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { focusComposerAfterPageChange } from './composerFocus';

type Format = (template: string, values: Record<string, string | number>) => string;

const CARD = 'my-2 rounded-panel border border-separator bg-surface p-3';

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
  // One add per draft at a time; `adding` only shows it.
  const addingRef = useRef(false);
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
      <div data-testid="app-draft-card" className={cn(CARD, 'text-ui text-label-secondary')}>
        {format(t.appDraft.added, { name: app?.name ?? addedAppId })}
      </div>
    );
  }
  if (error !== null) {
    return (
      <div data-testid="app-draft-card" className="my-2">
        <InlineMessage tone="danger">
          <p className="font-medium">{t.appDraft.previewFailed}</p>
          <p className="break-words text-ui-sm text-label-secondary">{error}</p>
        </InlineMessage>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div data-testid="app-draft-card" className={CARD}>
        <Spinner size="sm" label={t.appDraft.title} />
      </div>
    );
  }

  const { preview, catalog } = loaded;
  const modes = preview.app.config.home.modes.items;
  const confirm = () => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    commitAppDraft(conversationId)
      // The app is entered and its home replaces this conversation: the message field takes the focus the button had.
      .then(() => focusComposerAfterPageChange())
      .catch((reason: unknown) => addToast({ type: 'error', title: t.appDraft.failed, message: String(reason) }))
      .finally(() => {
        addingRef.current = false;
        setAdding(false);
      });
  };
  const modify = () => useChatStore.getState().requestComposerFocus();

  return (
    <div data-testid="app-draft-card" className={CARD}>
      <div className="text-caption font-medium text-label-tertiary">{t.appDraft.title}</div>
      <div className="mt-2 flex items-start gap-3">
        <AppLogo name={preview.app.name} size="md" />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-ui font-medium text-label">{preview.app.name}</h4>
          <p className="text-ui-sm text-label-secondary">{preview.app.description}</p>
        </div>
      </div>

      <section className="mt-3">
        <h5 className="text-ui-sm font-medium text-label-secondary">{t.appDraft.home} · {appHomeTitle(preview.app, locale)}</h5>
        {modes.map((mode) => (
          <div key={mode.modeId} className="mt-2">
            {modes.length > 1 && <div className="text-caption text-label-tertiary">{resolveText(mode.title)}</div>}
            <ul className="mt-1 space-y-1">
              {mode.scenes.map((scene) => (
                <li key={scene.id} data-testid={`app-draft-scene-${scene.id}`} className="flex items-baseline gap-2 text-ui">
                  <span className="text-label">{resolveText(scene.title)}</span>
                  <span className="min-w-0 truncate text-ui-sm text-label-tertiary">{sceneOwner(preview, scene, catalog, t, format, locale)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {preview.experts.length > 0 && (
        <section className="mt-3" data-testid="app-draft-new-experts">
          <h5 className="text-ui-sm font-medium text-label-secondary">{t.appDraft.newExperts}</h5>
          <ul className="mt-1 space-y-1">
            {preview.experts.map((expert) => (
              <li key={expert.name} className="text-ui text-label">
                {expert.name}
                {expert.description && <span className="ml-2 text-ui-sm text-label-tertiary">{expert.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.teams.length > 0 && (
        <section className="mt-3" data-testid="app-draft-new-teams">
          <h5 className="text-ui-sm font-medium text-label-secondary">{t.appDraft.newTeams}</h5>
          <ul className="mt-1 space-y-1">
            {preview.teams.map((team) => (
              <li key={team.id} className="text-ui text-label">
                {resolveText(team.name)}
                <span className="ml-2 text-ui-sm text-label-tertiary">{resolveText(team.description)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" data-testid="app-draft-modify" disabled={adding} onClick={modify}>{t.appDraft.modify}</Button>
        <Button variant="primary" size="sm" data-testid="app-draft-confirm" busy={adding} onClick={confirm}>
          {adding ? t.appDraft.adding : t.appDraft.confirm}
        </Button>
      </div>
    </div>
  );
}
