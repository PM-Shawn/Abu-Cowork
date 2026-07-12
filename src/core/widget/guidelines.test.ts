import { describe, it, expect } from 'vitest';
import { getWidgetGuidelines, WIDGET_GUIDELINE_MODULES } from './guidelines';
import { WIDGET_THEME_VARS, WIDGET_UTILITY_CLASSES, getDesignSystemGuideText } from './designSystem';

describe('getWidgetGuidelines', () => {
  it('includes the hard rules in every call', () => {
    const text = getWidgetGuidelines();
    expect(text).toContain('Hard rules');
    expect(text).toContain('Fragment only');
    expect(text).toContain('position: fixed');
    expect(text).toContain('localStorage');
    expect(text).toContain('sessionStorage');
    expect(text).toContain('<form>');
    expect(text).toContain('100vh');
    expect(text).toContain('cdn.jsdelivr.net');
    expect(text).toContain('cdnjs.cloudflare.com');
    expect(text).toContain('unpkg.com');
  });

  it('C1: the fragment-only detail is scoped to the inline widget and points at the opposite saved-page rule', () => {
    const text = getWidgetGuidelines();
    // Scoped so read_me does not contradict the save-as-webpage section (which needs a full document).
    expect(text).toContain('Fragment only (inline widget)');
    expect(text).toContain('A page saved via write_file is the opposite');
  });

  it('C1/C2: the save-as-webpage section is present and its preview claim is non-absolute', () => {
    const text = getWidgetGuidelines();
    expect(text).toContain('Saving a visualization as a real webpage file');
    expect(text).toContain('COMPLETE self-contained HTML document');
    // Non-absolute: auto-open only fires for the LAST non-image deliverable of the turn.
    expect(text).toContain('can be opened in the side preview panel');
    expect(text).not.toContain('opens automatically');
  });

  it('includes every module section when no filter is given', () => {
    const text = getWidgetGuidelines();
    expect(text).toContain('## Diagrams');
    expect(text).toContain('## Charts');
    expect(text).toContain('## Interactive widgets');
    expect(text).toContain('## UI mockups');
    expect(text).toContain('## Data posters (infographics)');
  });

  it('includes every module section when an empty array is given (treated as "all")', () => {
    const text = getWidgetGuidelines([]);
    expect(text).toContain('## Diagrams');
    expect(text).toContain('## Charts');
  });

  it('the diagram module prefers ```mermaid for static structure, positioning inline SVG as the exception', () => {
    const text = getWidgetGuidelines(['diagram']);
    // Prefers mermaid for static structure diagrams (kept consistent with the
    // capability-prompt carve-out in agentLoop.ts — single mental model).
    expect(text).toContain('```mermaid');
    expect(text).toContain('Static structure diagrams');
    expect(text).toContain('prefer that over drawing one here');
    // Inline SVG is now the exception (custom layout / annotations / interactivity),
    // not the default recommendation.
    expect(text).toContain('only when you need custom spatial layout, annotations, or interactivity');
    expect(text).not.toContain('Prefer inline SVG for flowcharts');
  });

  it('the chart module requires a fixed-height container for Chart.js (prevents the responsive growth loop → blank render)', () => {
    const text = getWidgetGuidelines(['chart']);
    // The canonical Chart.js contract: a bounded, positioned container + no
    // aspect-ratio lock, otherwise a responsive chart grows unbounded in the
    // auto-sized widget frame and renders blank.
    expect(text).toContain('position:relative;height:360px');
    expect(text).toContain('maintainAspectRatio:false');
    expect(text).toContain('grows unbounded and renders blank');
  });

  it('filters to a single requested module', () => {
    const text = getWidgetGuidelines(['diagram']);
    expect(text).toContain('## Diagrams');
    expect(text).not.toContain('## Charts');
    expect(text).not.toContain('## Interactive widgets');
    expect(text).not.toContain('## UI mockups');
    // Hard rules always present regardless of module filter
    expect(text).toContain('Hard rules');
  });

  it('filters to multiple requested modules, preserving canonical order', () => {
    const text = getWidgetGuidelines(['mockup', 'chart']);
    const chartIdx = text.indexOf('## Charts');
    const mockupIdx = text.indexOf('## UI mockups');
    expect(chartIdx).toBeGreaterThan(-1);
    expect(mockupIdx).toBeGreaterThan(-1);
    expect(chartIdx).toBeLessThan(mockupIdx); // canonical WIDGET_GUIDELINE_MODULES order, not request order
    expect(text).not.toContain('## Diagrams');
  });

  it('ignores unknown module names', () => {
    const text = getWidgetGuidelines(['not-a-real-module']);
    // Falls back to "all" behavior — filter matched nothing, canonical list wins... actually
    // an unknown-only filter yields an empty requested list, not "all". Assert that shape instead.
    expect(text).toContain('Hard rules');
    expect(text).not.toContain('## Diagrams');
    expect(text).not.toContain('## Charts');
  });

  it('canonical module list has exactly the five documented modules', () => {
    expect(WIDGET_GUIDELINE_MODULES).toEqual(['diagram', 'chart', 'interactive', 'mockup', 'poster']);
  });

  it('the poster module carries the infographic layout recipes folded in from the (now non-auto-invoking) infographic builtin skill', () => {
    const text = getWidgetGuidelines(['poster']);
    expect(text).toContain('## Data posters (infographics)');
    for (const recipe of ['Timeline', 'Process steps', 'Card grid', 'Stat row', 'Ranked list', 'Pyramid / funnel']) {
      expect(text).toContain(recipe);
    }
    // References the existing design-system vocabulary rather than inventing new classes.
    expect(text).toContain('.w-card');
    expect(text).toContain('.w-stat');
  });

  it('the diagram module carries the canvas-sizing/arrow-marker tips folded in from the svg-diagram builtin skill', () => {
    const text = getWidgetGuidelines(['diagram']);
    expect(text).toContain('viewBox');
    expect(text).toContain('marker-end');
  });

  it('the mockup module carries the device-frame/icon/multi-screen tips folded in from the html-widget builtin skill', () => {
    const text = getWidgetGuidelines(['mockup']);
    expect(text).toContain('375px');
    expect(text).toContain('Unicode glyphs');
  });

  it('includes the design-system section (vars + classes), regardless of module filter', () => {
    // Every module-filter shape (default/empty/single/unknown) must still carry the
    // design-system section — it's a hard-rules-adjacent, always-present section.
    for (const text of [getWidgetGuidelines(), getWidgetGuidelines([]), getWidgetGuidelines(['diagram']), getWidgetGuidelines(['not-a-real-module'])]) {
      expect(text).toContain('## Design system');
      for (const v of WIDGET_THEME_VARS) expect(text).toContain(v.name);
      for (const c of WIDGET_UTILITY_CLASSES) expect(text).toContain(`.${c.name}`);
    }
  });

  it('single source: the design-system section is exactly designSystem.ts\'s guide text (no separate copy that could drift)', () => {
    const text = getWidgetGuidelines();
    expect(text).toContain(getDesignSystemGuideText());
  });
});
