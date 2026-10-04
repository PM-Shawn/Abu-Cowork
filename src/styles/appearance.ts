// Accessibility appearance flags as attributes on <html>. tokens.css keys increased
// contrast, reduced transparency and reduced motion off these attributes only, so the
// signal source lives in this one file and the design preview can force a flag.
export type AppearanceFlag = 'contrast' | 'transparency' | 'motion';
export type AppearanceFlags = Record<AppearanceFlag, boolean>;

const QUERIES: Record<AppearanceFlag, string> = {
  contrast: '(prefers-contrast: more)',
  transparency: '(prefers-reduced-transparency: reduce)',
  motion: '(prefers-reduced-motion: reduce)',
};

export const APPEARANCE_ATTRIBUTES: Record<AppearanceFlag, readonly [name: string, value: string]> = {
  contrast: ['data-contrast', 'more'],
  transparency: ['data-transparency', 'reduced'],
  motion: ['data-motion', 'reduced'],
};

const FLAGS = Object.keys(QUERIES) as AppearanceFlag[];

let system: AppearanceFlags = { contrast: false, transparency: false, motion: false };
let overrides: Partial<AppearanceFlags> = {};
let target: HTMLElement | null = null;

function effective(flag: AppearanceFlag): boolean {
  return overrides[flag] ?? system[flag];
}

function apply(): void {
  if (!target) throw new Error('installAppearanceAttributes() must run before appearance flags change');
  for (const flag of FLAGS) {
    const [name, value] = APPEARANCE_ATTRIBUTES[flag];
    if (effective(flag)) target.setAttribute(name, value);
    else target.removeAttribute(name);
  }
}

export function installAppearanceAttributes(root: HTMLElement = document.documentElement): () => void {
  target = root;
  const lists = FLAGS.map((flag) => [flag, window.matchMedia(QUERIES[flag])] as const);
  const sync = () => {
    const next: AppearanceFlags = { contrast: false, transparency: false, motion: false };
    for (const [flag, list] of lists) next[flag] = list.matches;
    system = next;
    apply();
  };
  sync();
  for (const [, list] of lists) list.addEventListener('change', sync);
  return () => {
    for (const [, list] of lists) list.removeEventListener('change', sync);
  };
}

// Design preview only: force a flag on or off; null hands it back to the system setting.
export function setAppearanceOverride(flag: AppearanceFlag, value: boolean | null): void {
  if (value === null) delete overrides[flag];
  else overrides[flag] = value;
  apply();
}

export function resetAppearanceOverrides(): void {
  if (Object.keys(overrides).length === 0) return;
  overrides = {};
  apply();
}

export function currentAppearanceFlags(): AppearanceFlags {
  return { contrast: effective('contrast'), transparency: effective('transparency'), motion: effective('motion') };
}
