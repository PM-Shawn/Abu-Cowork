import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { PluginConfigurationFields, PluginDisclosureSections } from '@/components/toolbox/plugins/InstallDisclosureDialog';
import { DETAIL_WINDOW_CONTENT_HEIGHT } from '@/components/toolbox/windowHeight';
import AppLogo from '@/components/app/AppLogo';
import { useAppAddFlowStore, type AppAddFlow, type AppAddFlowPlace } from '@/stores/appAddFlowStore';
import { pluginConfigFields } from '@/core/plugin/configuration';
import { resolveText } from '@/core/app/appBinding';
import { liveRefCatalog, resolveRun } from '@/core/app/appRefs';
import type { AppPluginStep } from '@/core/app/appInstaller';
import type { AppDefinition } from '@/types/app';
import { describeSceneRun } from './runLabel';

const HEADING = 'flex items-center gap-2 text-ui font-medium text-label';
// One listed item: a filled row inside its section's list.
const ITEM = 'rounded-control bg-fill px-2 py-1';

function StepGroup({ title, steps, values, onChange }: {
  title: string;
  steps: AppPluginStep[];
  values: Record<string, Record<string, string>>;
  onChange: (key: string, next: (current: Record<string, string>) => Record<string, string>) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="space-y-3" data-testid="app-add-plugins">
      <h3 className={HEADING}>{title}</h3>
      {steps.map((step) => (
        <div key={step.disclosure.key} data-testid="app-add-plugin" data-plugin={step.entry.name} className="space-y-3 rounded-panel border border-separator p-3">
          <p className="flex items-center gap-2 text-ui font-medium text-label">
            <Icon icon={AppIcons.bundle} size="sm" className="text-label-tertiary" />
            {step.entry.displayName ?? step.entry.name}
            {step.disclosure.version && <span className="text-ui-sm font-normal text-label-tertiary">v{step.disclosure.version}</span>}
          </p>
          <PluginConfigurationFields
            fields={pluginConfigFields(step.disclosure.manifest.mcpServers)}
            values={values[step.disclosure.key] ?? {}}
            onChange={(next) => onChange(step.disclosure.key, next)}
          />
          <PluginDisclosureSections disclosure={step.disclosure} />
        </div>
      ))}
    </section>
  );
}

function ScenePreview({ app }: { app: AppDefinition }) {
  const { t, format, locale } = useI18n();
  const catalog = useMemo(() => liveRefCatalog(), []);
  return (
    <section className="space-y-2" data-testid="app-add-scenes">
      <h3 className={HEADING}><Icon icon={AppIcons.appMarket} size="sm" className="text-label-tertiary" />{t.appMarket.scenesTitle}</h3>
      <ul className="space-y-1">
        {app.config.home.modes.items.flatMap((mode) => mode.scenes.map((scene) => {
          const run = scene.run ?? app.config.defaultRun;
          const { label } = describeSceneRun(app, scene, run ? resolveRun(app, run, catalog) : undefined, t, format, locale);
          return (
            <li key={`${mode.modeId}/${scene.id}`} className={cn(ITEM, 'flex items-baseline justify-between gap-3')}>
              <span className="truncate text-ui text-label-secondary">{resolveText(mode.title)} · {resolveText(scene.title)}</span>
              <span className="shrink-0 text-ui-sm text-label-tertiary">{label}</span>
            </li>
          );
        }))}
      </ul>
    </section>
  );
}

/**
 * The page between 「使用」 / 「更新」 / 「从文件夹添加」 and the app (product
 * brief feature 5, 37): the plugins that come with it — split into 需要一起安装
 * and 需要一起更新, each shown exactly as the plugin install dialog would show
 * it — and the websites it opens inside Abu. A folder preview also shows the
 * home's scenes and who handles each. 「取消」 writes nothing.
 *
 * It is mounted twice, and a flow shows in the one the store names
 * (`shownIn`): inside the app market for a flow started there, so 「取消」
 * returns to the list; on the page (`within="page"`) for a flow started
 * anywhere else. The market's instance leaves the page with the market's
 * window; a flow it still shows then goes on in the page's instance.
 */
export default function AppAddConfirmDialog({ within }: { within: AppAddFlowPlace }) {
  const { t, format } = useI18n();
  const flowNow = useAppAddFlowStore((s) => s.flow);
  const running = useAppAddFlowStore((s) => s.running);
  const confirm = useAppAddFlowStore((s) => s.confirm);
  const cancel = useAppAddFlowStore((s) => s.cancel);
  const shownIn = useAppAddFlowStore((s) => s.shownIn);

  const open = flowNow.kind !== 'closed' && shownIn === within;
  useEffect(() => {
    if (within !== 'market') return undefined;
    return () => {
      const { flow: left, shownIn: place } = useAppAddFlowStore.getState();
      if (left.kind !== 'closed' && place === 'market') useAppAddFlowStore.setState({ shownIn: 'page' });
    };
  }, [within]);

  // The window stays on the page while it fades out: it keeps showing what it showed when it closed.
  const [held, setHeld] = useState<AppAddFlow>(flowNow);
  if (open && held !== flowNow) setHeld(flowNow);
  const flow = open ? flowNow : held;

  const [configuration, setConfiguration] = useState<Record<string, Record<string, string>>>({});
  // What was typed is forgotten with every step of the flow, its end included.
  useEffect(() => { setConfiguration({}); }, [flowNow]);
  // The window has gone: the flow it kept showing, with the plan and what resumes after it, is let go.
  const forget = () => { if (useAppAddFlowStore.getState().flow.kind === 'closed') setHeld({ kind: 'closed' }); };

  const steps = flow.kind === 'ready' ? flow.plan.steps : flow.kind === 'repair' ? flow.steps : [];
  const missingValues = steps.some((step) => pluginConfigFields(step.disclosure.manifest.mcpServers).some((field) => !configuration[step.disclosure.key]?.[field]?.trim()));
  const onChange = (key: string, next: (current: Record<string, string>) => Record<string, string>) => setConfiguration((current) => ({ ...current, [key]: next(current[key] ?? {}) }));
  const canConfirm = flow.kind === 'ready' || flow.kind === 'repair';

  const title = flow.kind === 'ready'
    ? format(flow.purpose === 'update' ? t.appMarket.confirmUpdateTitle : flow.purpose === 'preview' ? t.appMarket.previewTitle : t.appMarket.confirmAddTitle, { name: flow.plan.app.name })
    : flow.kind === 'repair' ? t.appMarket.needInstall
      : flow.kind === 'error' ? t.appMarket.addFailed
        : flow.kind === 'planning' ? format(t.appMarket.confirmAddTitle, { name: flow.name })
          : '';

  const body = (() => {
    if (flow.kind === 'closed') return null;
    if (flow.kind === 'planning') return <Spinner label={t.common.loading} />;
    if (flow.kind === 'error') {
      return (
        <div data-testid="app-add-error">
          <InlineMessage tone="danger"><p className="min-w-0 break-words">{flow.message}</p></InlineMessage>
        </div>
      );
    }
    const app = flow.kind === 'ready' ? flow.plan.app : flow.app;
    const sites = flow.kind === 'ready' ? flow.plan.sites : [];
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <AppLogo name={app.name} logo={app.logo} logoDark={app.logoDark} size="lg" />
          <div className="min-w-0">
            <p className="text-title text-label">{app.name}</p>
            {app.description && <p className="text-ui-sm text-label-tertiary">{app.description}</p>}
          </div>
        </div>
        {flow.kind === 'ready' && flow.purpose === 'preview' && <ScenePreview app={app} />}
        <StepGroup title={t.appMarket.needInstall} steps={steps.filter((step) => step.kind === 'install')} values={configuration} onChange={onChange} />
        <StepGroup title={t.appMarket.needUpdate} steps={steps.filter((step) => step.kind === 'update')} values={configuration} onChange={onChange} />
        {sites.length > 0 && (
          <section className="space-y-2" data-testid="app-add-sites">
            <h3 className={HEADING}><Icon icon={AppIcons.webPage} size="sm" className="text-label-tertiary" />{t.appMarket.sitesTitle}</h3>
            <ul className="space-y-1">
              {sites.map((site) => <li key={site} className={cn(ITEM, 'break-all font-code text-ui-sm text-label-secondary')}>{site}</li>)}
            </ul>
          </section>
        )}
      </div>
    );
  })();

  const footer = canConfirm ? (
    <>
      <Button variant="plain" onClick={() => { if (open) void cancel(); }} disabled={running}>{t.common.cancel}</Button>
      <Button
        variant="primary"
        data-testid="app-add-confirm"
        busy={running}
        disabled={missingValues}
        // The window stays on the page while it fades out; a press there confirms nothing.
        onClick={() => { if (open) void confirm(configuration); }}
      >
        {running ? t.appMarket.adding : t.appMarket.confirm}
      </Button>
    </>
  ) : (
    <Button variant="plain" onClick={() => { if (open) void cancel(); }}>{t.common.close}</Button>
  );

  return (
    <Dialog
      open={open}
      // Escape, a press outside and the close button ask to close; an add that is running is never left.
      onOpenChange={(next) => { if (!next && !running) void cancel(); }}
      // For an approval the window steps aside while it adds, and comes back.
      busy={running}
      title={title}
      size="lg"
      // Without a plan the footer's one button is Close, so the corner button would be a second control of that name.
      closeButton={canConfirm && !running}
      contentProps={{ 'data-testid': 'app-add-dialog' }}
      onCloseAutoFocus={forget}
      footer={footer}
    >
      <div className={DETAIL_WINDOW_CONTENT_HEIGHT}>{body}</div>
    </Dialog>
  );
}
