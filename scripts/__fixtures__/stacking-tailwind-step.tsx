// Read as text by scripts/designTokens.test.ts: a stacking value written as a Tailwind step. The
// negative step on the second element sits under the page and is not a value the test compares.
// Nothing imports this file.
export function StackingTailwindStep() {
  return (
    <div className="relative z-50">
      <div className="absolute -z-10" />
    </div>
  );
}
