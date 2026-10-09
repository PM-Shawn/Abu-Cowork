// Read as text by scripts/designTokens.test.ts: a stacking value given through a numeric
// constant of the same file, as a style property and as a prop. Nothing imports this file.
const MENU_Z_INDEX = 10001;

function Layer(props: Record<'zIndex', number>) {
  return <div style={props} />;
}

export function StackingConstant() {
  return (
    <div style={{ zIndex: MENU_Z_INDEX }}>
      <Layer zIndex={MENU_Z_INDEX} />
    </div>
  );
}
