import { describe, it, expect } from 'vitest';
import {
  WIDGET_THEME_VARS,
  WIDGET_UTILITY_CLASSES,
  WIDGET_THEME_VAR_ALIASES,
  buildWidgetDesignCss,
  getDesignSystemGuideText,
} from './designSystem';

describe('buildWidgetDesignCss', () => {
  const css = buildWidgetDesignCss();

  it('declares every theme variable', () => {
    for (const v of WIDGET_THEME_VARS) {
      expect(css).toContain(`${v.name}:`);
    }
  });

  it('defines every utility class', () => {
    for (const c of WIDGET_UTILITY_CLASSES) {
      expect(css).toContain(`.${c.name} {`);
    }
  });

  it('has a light :root default block', () => {
    expect(css).toMatch(/:root\s*\{/);
    // Light default is the FIRST occurrence of a var declaration (before any dark override).
    const rootIdx = css.indexOf(':root {');
    const bgIdx = css.indexOf('--w-bg:');
    expect(bgIdx).toBeGreaterThan(-1);
    expect(bgIdx).toBeGreaterThan(rootIdx);
  });

  it('does NOT use an OS prefers-color-scheme trigger (P2 defaults to light; P3 wires host theme via .dark)', () => {
    // The srcdoc iframe can't see Abu's in-app theme, so an OS-scheme media
    // query would make the widget follow the OS rather than the chat — a
    // regression from pre-P2's always-light widget. Must be absent.
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('keeps the .dark class override block (dormant P3 hook)', () => {
    expect(css).toMatch(/\.dark\s*\{/);
    // Each var must carry its dark value in that block, ready for P3 to toggle.
    for (const v of WIDGET_THEME_VARS) {
      expect(css).toContain(`${v.name}: ${v.dark};`);
    }
  });

  it('does not use light-dark() (browser/webview support risk)', () => {
    expect(css).not.toContain('light-dark(');
  });

  it('scope-check: the only bare-tag selector is body, and it only sets theme colors', () => {
    // Find `body { ... }` blocks in the assembled CSS and assert they never
    // redeclare padding/margin/font-family/display — those are BASE_STYLES'
    // job; a design-system body rule fighting them would break existing layout.
    const bodyBlocks = [...css.matchAll(/(?:^|\s)body\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(bodyBlocks.length).toBeGreaterThan(0);
    for (const block of bodyBlocks) {
      expect(block).not.toMatch(/padding|margin|font-family|display/);
    }
    // No accidental `html { ... }` or universal `* { ... }` reset introduced
    // by this module (BASE_STYLES already owns those).
    expect(css).not.toMatch(/(?:^|\s)html\s*\{/);
    expect(css).not.toMatch(/(?:^|\s)\*\s*\{/);
  });

  it('has no backtick or template-literal interpolation markers (embedded in a JS template literal)', () => {
    expect(css).not.toContain('`');
    expect(css).not.toContain('${');
  });
});

describe('getDesignSystemGuideText', () => {
  const guide = getDesignSystemGuideText();

  it('mentions every theme variable by name (anti-drift guarantee)', () => {
    for (const v of WIDGET_THEME_VARS) {
      expect(guide).toContain(v.name);
    }
  });

  it('mentions every utility class by name (anti-drift guarantee)', () => {
    for (const c of WIDGET_UTILITY_CLASSES) {
      expect(guide).toContain(`.${c.name}`);
    }
  });

  it('includes usage examples', () => {
    expect(guide).toContain('```html');
  });

  it('prints literal series hex for canvas (derived from the same array, single source)', () => {
    // Canvas can't resolve var() — the guide must give literal hex. Each must
    // be the actual .light value from WIDGET_THEME_VARS, not a hand-typed copy.
    for (const name of ['--w-primary', '--w-series-2', '--w-series-3', '--w-series-4']) {
      const hex = WIDGET_THEME_VARS.find((v) => v.name === name)?.light;
      expect(hex).toBeTruthy();
      expect(guide).toContain(hex as string);
    }
  });

  it('warns against using near-black --w-fg for canvas text (legibility on dark hosts)', () => {
    expect(guide).toContain('--w-fg');
    expect(guide.toLowerCase()).toContain('legible');
  });

  it('is reasonably sized (a few KB, not a sprawling doc)', () => {
    expect(guide.length).toBeLessThan(6000);
  });
});

describe('WIDGET_THEME_VAR_ALIASES (forgiving safety net for conventional names)', () => {
  const css = buildWidgetDesignCss();

  it('every alias resolves to a canonical var that exists in WIDGET_THEME_VARS', () => {
    const canonicalNames = new Set(WIDGET_THEME_VARS.map((v) => v.name));
    for (const alias of WIDGET_THEME_VAR_ALIASES) {
      expect(canonicalNames.has(alias.canonical)).toBe(true);
    }
  });

  it('no alias name collides with a canonical theme variable name', () => {
    const canonicalNames = new Set(WIDGET_THEME_VARS.map((v) => v.name));
    for (const alias of WIDGET_THEME_VAR_ALIASES) {
      expect(canonicalNames.has(alias.name)).toBe(false);
    }
  });

  it('every alias name appears in buildWidgetDesignCss() output as a var() reference to its canonical', () => {
    for (const alias of WIDGET_THEME_VAR_ALIASES) {
      expect(css).toContain(`${alias.name}: var(${alias.canonical});`);
    }
  });

  it('emits the alias block once (theme-agnostic — not duplicated in .dark)', () => {
    for (const alias of WIDGET_THEME_VAR_ALIASES) {
      const occurrences = css.split(`${alias.name}: var(`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it('covers the exact conventional names guessed in the live-test bug (glm-5.2, no read_me)', () => {
    for (const name of ['--w-text-primary', '--w-text-secondary', '--w-bg-primary', '--w-bg-tertiary']) {
      expect(css).toContain(`${name}: var(`);
    }
  });

  it('is NOT documented in the guide text (aliases are a safety net, not the contract)', () => {
    const guide = getDesignSystemGuideText();
    for (const alias of WIDGET_THEME_VAR_ALIASES) {
      expect(guide).not.toContain(alias.name);
    }
  });
});

describe('anti-drift: CSS and guide text describe the exact same vocabulary', () => {
  it('every var/class documented in the guide is present in the shipped CSS, and vice versa', () => {
    const css = buildWidgetDesignCss();
    const guide = getDesignSystemGuideText();

    for (const v of WIDGET_THEME_VARS) {
      expect(css).toContain(v.name);
      expect(guide).toContain(v.name);
    }
    for (const c of WIDGET_UTILITY_CLASSES) {
      expect(css).toContain(`.${c.name}`);
      expect(guide).toContain(`.${c.name}`);
    }
  });
});
