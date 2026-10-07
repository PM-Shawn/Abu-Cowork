// Read as text by scripts/designTokens.test.ts: a stacking value given through a numeric
// constant of the same file. Nothing imports this file.
const MENU_Z_INDEX = 10001;

export function StackingConstant() {
  return <div style={{ zIndex: MENU_Z_INDEX }} />;
}
