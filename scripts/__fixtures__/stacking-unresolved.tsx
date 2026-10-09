// Read as text by scripts/designTokens.test.ts: a stacking value given through a constant of
// another file, which the test reports as a value it cannot resolve. Nothing imports this file.
import { IMPORTED_LEVEL } from './stacking-level';

export function StackingUnresolved() {
  return <div style={{ zIndex: IMPORTED_LEVEL }} />;
}
