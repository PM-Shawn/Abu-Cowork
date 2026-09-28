import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Globe, LayoutGrid, Loader2, Package } from 'lucide-react';
import { useI18n } from '@/i18n';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import { Button } from '@/components/ui/button';
import { PluginConfigurationFields, PluginDisclosureSections } from '@/components/toolbox/plugins/InstallDisclosureDialog';
import AppLogo from '@/components/app/AppLogo';
import { useAppAddFlowStore } from '@/stores/appAddFlowStore';
import { pluginConfigFields } from '@/core/plugin/configuration';
import { resolveText } from '@/core/app/appBinding';
import { liveRefCatalog, resolveRun } from '@/core/app/appRefs';
import type { AppPluginStep } from '@/core/app/appInstaller';
import type { AppDefinition } from '@/types/app';
import { describeSceneRun } from './runLabel';

/**
 * The page between 「使用」 / 「更新」 / 「从文件夹添加」 and the app (product
 * brief feature 5, 37): the plugins that come with it — split into 需要一起安装
 * and 需要一起更新, each shown exactly as the plugin install dialog would show
 * it — and the websites it opens inside Abu. A folder preview also shows the
 * home's scenes and who handles each. 「取消」 writes nothing.
 */
function StepGroup({ title, steps, values, onChange }: {
  title: string;
  steps: AppPluginStep[];
  values: Record<string, Record<string, string>>;
  onChange: (key: string, next: (current: Record<string, string>) => Record<string, string>) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="space-y-3" data-testid="app-add-plugins">
      <h3 className="text-h-xs text-[var(--abu-text-primary)]">{title}</h3>
      {steps.map((step) => (
        <div key={step.disclosure.key} data-testid="app-add-plugin" data-plugin={step.entry.name} className="space-y-3 rounded-xl border border-[var(--abu-border)] p-3">
          <p className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)]">
            <Package className="h-4 w-4 text-[var(--abu-text-muted)]" />
            {step.entry.displayName ?? step.entry.name}
            {step.disclosure.version && <span className="text-minor font-normal text-[var(--abu-text-muted)]">v{step.disclosure.version}</span>}
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
      <h3 className="flex items-center gap-1.5 text-h-xs text-[var(--abu-text-primary)]"><LayoutGrid className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />{t.appMarket.scenesTitle}</h3>
      <ul className="space-y-1">
        {app.config.home.modes.items.flatMap((mode) => mode.scenes.map((scene) => {
          const run = scene.run ?? app.config.defaultRun;
          const { label } = describeSceneRun(app, scene, run ? resolveRun(app, run, catalog) : undefined, t, format, locale);
          return (
            <li key={`${mode.modeId}/${scene.id}`} className="flex items-baseline justify-between gap-3 rounded bg-[var(--abu-bg-muted)] px-2 py-1">
              <span className="truncate text-body text-[var(--abu-text-secondary)]">{resolveText(mode.title)} · {resolveText(scene.title)}</span>
              <span className="shrink-0 text-minor text-[var(--abu-text-muted)]">{label}</span>
            </li>
          );
        }))}
      </ul>
    </section>
  );
}

export default function AppAddConfirmDialog() {
  const { t, format } = useI18n();
  const flow = useAppAddFlowStore((s) => s.flow);
  const running = useAppAddFlowStore((s) => s.running);
  const confirm = useAppAddFlowStore((s) => s.confirm);
  const cancel = useAppAddFlowStore((s) => s.cancel);
  const [configuration, setConfiguration] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => { setConfiguration({}); }, [flow]);
  if (flow.kind === 'closed') return null;

  const steps = flow.kind === 'ready' ? flow.plan.steps : flow.kind === 'repair' ? flow.steps : [];
  const missingValues = steps.some((step) => pluginConfigFields(step.disclosure.manifest.mcpServers).some((field) => !configuration[step.disclosure.key]?.[field]?.trim()));
  const onChange = (key: string, next: (current: Record<string, string>) => Record<string, string>) => setConfiguration((current) => ({ ...current, [key]: next(current[key] ?? {}) }));

  const title = flow.kind === 'ready'
    ? format(flow.purpose === 'update' ? t.appMarket.confirmUpdateTitle : flow.purpose === 'preview' ? t.appMarket.previewTitle : t.appMarket.confirmAddTitle, { name: flow.plan.app.name })
    : flow.kind === 'repair' ? t.appMarket.needInstall
      : flow.kind === 'error' ? t.appMarket.addFailed
        : format(t.appMarket.confirmAddTitle, { name: flow.name });

  const body = (() => {
    if (flow.kind === 'planning') {
      return <p role="status" className="flex items-center gap-2 text-body text-[var(--abu-text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin" />{t.common.loading}</p>;
    }
    if (flow.kind === 'error') {
      return (
        <div data-testid="app-add-error" className="flex items-start gap-2.5 rounded-lg bg-[var(--abu-danger-bg)] p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-danger)]" />
          <p className="min-w-0 break-words text-body text-[var(--abu-text-primary)]">{flow.message}</p>
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
            <p className="text-h-sm text-[var(--abu-text-primary)]">{app.name}</p>
            {app.description && <p className="text-minor text-[var(--abu-text-tertiary)]">{app.description}</p>}
          </div>
        </div>
        {flow.kind === 'ready' && flow.purpose === 'preview' && <ScenePreview app={app} />}
        <StepGroup title={t.appMarket.needInstall} steps={steps.filter((step) => step.kind === 'install')} values={configuration} onChange={onChange} />
        <StepGroup title={t.appMarket.needUpdate} steps={steps.filter((step) => step.kind === 'update')} values={configuration} onChange={onChange} />
        {sites.length > 0 && (
          <section className="space-y-2" data-testid="app-add-sites">
            <h3 className="flex items-center gap-1.5 text-h-xs text-[var(--abu-text-primary)]"><Globe className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />{t.appMarket.sitesTitle}</h3>
            <ul className="space-y-1">
              {sites.map((site) => <li key={site} className="break-all rounded bg-[var(--abu-bg-muted)] px-2 py-1 font-mono text-minor text-[var(--abu-text-secondary)]">{site}</li>)}
            </ul>
          </section>
        )}
      </div>
    );
  })();

  const footer = (
    <div className="flex items-center justify-end gap-3">
      {flow.kind === 'ready' || flow.kind === 'repair' ? (
        <>
          <Button variant="ghost" onClick={() => void cancel()} disabled={running}>{t.common.cancel}</Button>
          <Button data-testid="app-add-confirm" onClick={() => void confirm(configuration)} disabled={running || missingValues}>
            {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {running ? t.appMarket.adding : t.appMarket.confirm}
          </Button>
        </>
      ) : (
        <Button variant="ghost" onClick={() => void cancel()} disabled={flow.kind === 'planning' && running}>{t.common.close}</Button>
      )}
    </div>
  );

  return (
    <ToolDetailModal
      open
      onClose={() => { if (!running) void cancel(); }}
      disableEscape={running}
      ariaLabel={title}
      testId="app-add-dialog"
      title={title}
      maxWidth="max-w-2xl"
      panelClassName="h-[min(680px,85vh)]"
      footer={footer}
    >
      {body}
    </ToolDetailModal>
  );
}
