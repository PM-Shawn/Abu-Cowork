// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import SystemSettingsView from './SystemSettingsModal';

// Each page is replaced by its name, so the tests read which page the content area shows.
vi.mock('./sections', () => ({
  AccountSection: () => <div>page:account</div>,
  AIServicesSection: () => <div>page:ai-services</div>,
  AboutSection: () => <div>page:about</div>,
  SandboxSection: () => <div>page:sandbox</div>,
  GeneralSection: () => <div>page:general</div>,
  CapabilitiesSection: () => <div>page:capabilities</div>,
  IMChannelSection: () => <div>page:im-channels</div>,
}));
vi.mock('./sections/FeedbackSection', () => ({ default: () => <div>page:feedback</div> }));
vi.mock('./sections/AuthorSection', () => ({ default: () => <div>page:author</div> }));
vi.mock('./sections/PersonalMemorySection', () => ({ default: () => <div>page:personal-memory</div> }));
vi.mock('./sections/SoulSection', () => ({ default: () => <div>page:soul</div> }));
vi.mock('./sections/DiagnosticSection', () => ({ default: () => <div>page:diagnostic</div> }));
vi.mock('./sections/UsageSection', () => ({ default: () => <div>page:usage</div> }));
vi.mock('./sections/EnterpriseSection', () => ({ default: () => <div>page:enterprise</div> }));
vi.mock('./sections/LabsSection', () => ({ default: () => <div>page:labs</div> }));
vi.mock('./sections/PetSection', () => ({ default: () => <div>page:pet</div> }));

function renderView() {
  return render(<SystemSettingsView />, { wrapper: DesignSystemProvider });
}

const navigation = () => screen.getByRole('navigation', { name: getI18n().settings.title });
const navButton = (name: string) => within(navigation()).getByRole('button', { name });
// The rows of each group, group by group, in the order they are drawn.
const groups = () => Array.from(navigation().children)
  .map((group) => within(group as HTMLElement).getAllByRole('button').map((button) => button.textContent));

describe('SystemSettingsView navigation', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({ activeSystemTab: 'general', labs: { pet: false }, petOpen: false });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ activeSystemTab: 'usage', labs: {}, petOpen: false });
  });

  it('lists the pages in five groups, in the same order and with the same names', () => {
    const t = getI18n();
    renderView();
    expect(groups()).toEqual([
      [t.account.title, t.settings.general, t.settings.capabilityOverview, t.settings.sandbox, t.settings.labs],
      [t.settings.aiServices, t.usage.title],
      [t.sidebar.personalMemory, t.soul.title],
      [t.imChannel.title],
      [t.diagnostic.title, t.about.feedback, t.common.version, t.author.title],
    ]);
  });

  // The glyph of every row, read from the drawn icon (lucide names each icon in its class).
  it('keeps the glyph each page had before the migration', () => {
    const t = getI18n();
    useSettingsStore.setState({ labs: { pet: true } });
    renderView();
    const glyphs = Object.fromEntries(within(navigation()).getAllByRole('button').map((button) => [
      button.textContent,
      Array.from(button.querySelector('svg')?.classList ?? []).filter((name) => name.startsWith('lucide-')).at(-1),
    ]));
    expect(glyphs).toEqual({
      [t.account.title]: 'lucide-user-round',
      [t.settings.general]: 'lucide-sliders-horizontal',
      [t.settings.capabilityOverview]: 'lucide-zap',
      [t.settings.sandbox]: 'lucide-shield',
      [t.settings.labs]: 'lucide-flask-conical',
      [t.settings.aiServices]: 'lucide-settings-2',
      [t.usage.title]: 'lucide-chart-column',
      [t.sidebar.personalMemory]: 'lucide-brain',
      [t.soul.title]: 'lucide-heart',
      [t.settings.petEnable]: 'lucide-paw-print',
      [t.imChannel.title]: 'lucide-radio',
      [t.diagnostic.title]: 'lucide-activity',
      [t.about.feedback]: 'lucide-message-circle',
      [t.common.version]: 'lucide-info',
      [t.author.title]: 'lucide-user-round',
    });
  });

  it('marks the page in view and follows a click to another page', async () => {
    const t = getI18n();
    const user = userEvent.setup();
    renderView();
    expect(screen.getByText('page:general')).toBeInTheDocument();
    expect(navButton(t.settings.general)).toHaveAttribute('aria-current', 'page');
    expect(within(navigation()).getAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toHaveLength(1);

    await user.click(navButton(t.settings.sandbox));

    expect(screen.getByText('page:sandbox')).toBeInTheDocument();
    expect(screen.queryByText('page:general')).toBeNull();
    expect(navButton(t.settings.sandbox)).toHaveAttribute('aria-current', 'page');
    expect(navButton(t.settings.general)).not.toHaveAttribute('aria-current');
    expect(useSettingsStore.getState().activeSystemTab).toBe('sandbox');
  });

  it('shows the desktop pet page after the personality page only once it is turned on in Labs', () => {
    const t = getI18n();
    renderView();
    expect(within(navigation()).queryByRole('button', { name: t.settings.petEnable })).toBeNull();

    act(() => useSettingsStore.setState({ labs: { pet: true } }));

    expect(groups()[2]).toEqual([t.sidebar.personalMemory, t.soul.title, t.settings.petEnable]);
  });

  it('goes back to the Labs page when the desktop pet is turned off while its page is in view', () => {
    useSettingsStore.setState({ activeSystemTab: 'pet', labs: { pet: true } });
    renderView();
    expect(screen.getByText('page:pet')).toBeInTheDocument();

    act(() => useSettingsStore.setState({ labs: { pet: false } }));

    expect(useSettingsStore.getState().activeSystemTab).toBe('labs');
    expect(screen.getByText('page:labs')).toBeInTheDocument();
    expect(screen.queryByText('page:pet')).toBeNull();
  });

  it('has no enterprise page in the open-source build', () => {
    renderView();
    expect(within(navigation()).queryByRole('button', { name: getI18n().settings.enterpriseMode })).toBeNull();
  });
});
