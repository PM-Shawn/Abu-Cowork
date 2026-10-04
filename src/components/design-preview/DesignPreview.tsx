import { useEffect, useState } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Switch } from '@/components/ds/switch';
import { currentAppearanceFlags, resetAppearanceOverrides, setAppearanceOverride, type AppearanceFlag } from '@/styles/appearance';
import { BasicsSection } from './sections/BasicsSection';
import { ContainerSection } from './sections/ContainerSection';
import { FeedbackSection } from './sections/FeedbackSection';
import { FormSection } from './sections/FormSection';
import { MotionSection } from './sections/MotionSection';
import { OverlaySection } from './sections/OverlaySection';
import { TokenSection } from './sections/TokenSection';

const FLAG_LABELS: Record<AppearanceFlag, string> = {
  contrast: 'Increase contrast',
  transparency: 'Reduce transparency',
  motion: 'Reduce motion',
};
const FLAGS = Object.keys(FLAG_LABELS) as AppearanceFlag[];

// Developer-only page. Built only when VITE_ABU_DESIGN_PREVIEW=1 (electron:dev and the
// Electron E2E build), so it never ships in a release bundle.
export function DesignPreview({ portalContainer }: { portalContainer?: HTMLElement | null }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [flags, setFlags] = useState(currentAppearanceFlags);

  useEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains('dark');
    return () => {
      root.classList.toggle('dark', wasDark);
      resetAppearanceOverrides();
    };
  }, []);

  const chooseAppearance = (value: string) => {
    const next = value === 'dark';
    document.documentElement.classList.toggle('dark', next);
    setDark(next);
  };
  const toggleFlag = (flag: AppearanceFlag, on: boolean) => {
    setAppearanceOverride(flag, on);
    setFlags(currentAppearanceFlags());
  };

  return (
    <DesignSystemProvider container={portalContainer}>
      <div data-design-preview-root data-electron-no-drag className="h-full overflow-auto bg-surface p-8 text-label">
        <header className="mb-6 flex flex-wrap items-center gap-6">
          <h1 className="text-title-lg">Design system preview</h1>
          <SegmentedControl
            label="Appearance"
            value={dark ? 'dark' : 'light'}
            onValueChange={chooseAppearance}
            options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
          />
          {FLAGS.map((flag) => (
            <Switch key={flag} label={FLAG_LABELS[flag]} checked={flags[flag]} onCheckedChange={(on) => toggleFlag(flag, on)} />
          ))}
        </header>
        <TokenSection />
        <BasicsSection />
        <FormSection />
        <OverlaySection />
        <ContainerSection />
        <FeedbackSection />
        <MotionSection />
      </div>
    </DesignSystemProvider>
  );
}
