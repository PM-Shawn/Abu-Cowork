// Read as text by scripts/designTokens.test.ts: a stacking value written as a number in a style
// object. Nothing imports this file.
export function StackingInlineNumber() {
  return <div style={{ position: 'relative', zIndex: 12 }} />;
}
