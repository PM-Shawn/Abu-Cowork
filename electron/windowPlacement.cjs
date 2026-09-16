/**
 * Window position helpers for the Tauri-shaped window contract
 * (`plugin:window|outer_position` / `set_position`, the `tauri://move` event).
 *
 * Units. Tauri's contract is PHYSICAL pixels for outer_position and the move
 * payload; Electron's BrowserWindow/Display geometry is device-independent
 * (DIP). outer_position has always scaled DIP by the scale factor of the
 * display the window's bounds match (`screen.getDisplayMatching`), so every
 * helper here uses that same rule in both directions. That is what makes a
 * persisted position round-trip exactly: onMoved/outer_position → persist →
 * set_position lands the window back on the same DIP spot, including on a
 * scale-2 (Retina) or scale-1.5 display. Logical positions are DIP as-is.
 *
 * Everything here is pure over an injected `screen` so it runs under plain
 * Node in electron/windowPlacement.test.cjs.
 */
'use strict';

/** At least this much of a restored window (per axis, DIP) must stay on a display. */
const MIN_VISIBLE_DIP = 32;
/** Far beyond any real desktop; rejects absurd values before they reach the OS. */
const MAX_ABS_COORD = 1_000_000;

function isFiniteCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_ABS_COORD;
}

/**
 * Parse a `plugin:window|set_position` `value` into `{ unit, x, y }`.
 *
 * Accepts Tauri's wire form (`{ Physical: {x,y} }` / `{ Logical: {x,y} }`) and
 * the form a `Position` instance actually arrives in over Electron IPC: the
 * page's contextBridge call drops class prototypes, so `Position`'s
 * serializer method never runs and its own fields survive instead —
 * `{ position: { type: 'Physical' | 'Logical', x, y } }` (a bare
 * `{ type, x, y }` PhysicalPosition/LogicalPosition is accepted too).
 * @param {unknown} value
 * @returns {{ unit: 'Physical' | 'Logical', x: number, y: number }}
 */
function parsePositionValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('set_position: value must be a position object');
  }
  let unit = null;
  let point = null;
  if (value.Physical && typeof value.Physical === 'object') {
    unit = 'Physical';
    point = value.Physical;
  } else if (value.Logical && typeof value.Logical === 'object') {
    unit = 'Logical';
    point = value.Logical;
  } else {
    const inner = value.position && typeof value.position === 'object' ? value.position : value;
    if (inner.type === 'Physical' || inner.type === 'Logical') {
      unit = inner.type;
      point = inner;
    }
  }
  if (!unit) throw new Error('set_position: value must be a Physical or Logical position');
  if (!isFiniteCoord(point.x) || !isFiniteCoord(point.y)) {
    throw new Error('set_position: x and y must be finite numbers');
  }
  return { unit, x: point.x, y: point.y };
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w, h };
}

/**
 * The window's position in physical pixels — the outer_position / tauri://move
 * value. DIP scaled by the scale factor of the display its bounds match.
 * @param {import('electron').Screen} screen
 * @param {import('electron').BrowserWindow} win
 */
function physicalPositionOf(screen, win) {
  const [x, y] = win.getPosition();
  const sf = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  return { x: Math.round(x * sf), y: Math.round(y * sf) };
}

/**
 * Inverse of physicalPositionOf: the DIP point `p` came from. For a display d,
 * `p / d.scaleFactor` is a candidate; it is consistent only if a window of
 * `size` there would match d again (so physicalPositionOf gives back `p`).
 *
 * With every display at one scale factor all consistent candidates coincide.
 * With mixed scale factors a physical point can be consistent on two displays
 * (the per-display scaling is not a global coordinate space — Tauri's isn't
 * either), so `preferred` breaks the tie: the display the window is on now,
 * which is exactly Tauri's rule (set_position converts with the window's
 * current scale factor). Otherwise the consistent candidate most on its
 * display wins; if none is consistent (a monitor that is gone) the primary
 * scale factor is used and the caller clamps the result on-screen.
 * @param {import('electron').Screen} screen
 * @param {{ x: number, y: number }} p
 * @param {{ width: number, height: number }} size
 * @param {{ id: number, scaleFactor: number } | null} [preferred]
 */
function physicalToDip(screen, p, size, preferred) {
  const candidate = (d) => {
    const sf = d.scaleFactor || 1;
    const rect = { x: p.x / sf, y: p.y / sf, width: size.width, height: size.height };
    return screen.getDisplayMatching(rect).id === d.id ? rect : null;
  };
  const onPreferred = preferred ? candidate(preferred) : null;
  if (onPreferred) return { x: onPreferred.x, y: onPreferred.y };
  let best = null;
  for (const d of screen.getAllDisplays()) {
    const rect = candidate(d);
    if (!rect) continue;
    const o = overlap(rect, d.bounds);
    const area = Math.max(0, o.w) * Math.max(0, o.h);
    if (!best || area > best.area) best = { x: rect.x, y: rect.y, area };
  }
  if (best) return { x: best.x, y: best.y };
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  return { x: p.x / sf, y: p.y / sf };
}

/**
 * Keep a restored window reachable. A rect that already shows at least
 * MIN_VISIBLE_DIP on both axes of some display's work area is left exactly
 * where it is — the pet's edge-snap deliberately parks 40% of it off-screen.
 * Anything else (typically a position saved on a monitor that has since been
 * unplugged) is moved fully into the work area of the display nearest its
 * centre.
 * @param {import('electron').Screen} screen
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
function clampOntoDisplays(screen, rect) {
  const minW = Math.min(MIN_VISIBLE_DIP, rect.width);
  const minH = Math.min(MIN_VISIBLE_DIP, rect.height);
  for (const d of screen.getAllDisplays()) {
    const o = overlap(rect, d.workArea);
    if (o.w >= minW && o.h >= minH) return { x: rect.x, y: rect.y };
  }
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  }).workArea;
  return {
    x: Math.max(wa.x, Math.min(rect.x, wa.x + wa.width - rect.width)),
    y: Math.max(wa.y, Math.min(rect.y, wa.y + wa.height - rect.height)),
  };
}

/**
 * `plugin:window|set_position`'s value → the integer DIP point to hand to
 * BrowserWindow.setPosition for a window of `size` (DIP).
 * @param {import('electron').Screen} screen
 * @param {unknown} value
 * @param {{ width: number, height: number }} size
 * @param {{ id: number, scaleFactor: number } | null} [preferred] the display
 *   the window is on now (physicalToDip's mixed-DPI tie-break)
 */
function resolveWindowPosition(screen, value, size, preferred) {
  const p = parsePositionValue(value);
  const dip = p.unit === 'Logical' ? { x: p.x, y: p.y } : physicalToDip(screen, p, size, preferred);
  const placed = clampOntoDisplays(screen, { x: dip.x, y: dip.y, width: size.width, height: size.height });
  return { x: Math.round(placed.x), y: Math.round(placed.y) };
}

/**
 * Emit Tauri's `tauri://move` (payload: physical `{x, y}`, as outer_position)
 * to `win`'s own renderer whenever the window moves — by the user, by the pet's
 * drag stand-in (start_dragging's per-tick setPosition), or by set_position.
 * `emitWindowEvent(win, event, payload)` delivers only to subscriptions that
 * renderer registered, which already passed the per-window listen allowlist
 * in securityBoundary.cjs; the renderer debounces the burst itself.
 * @param {import('electron').BrowserWindow} win
 * @param {{ screen: import('electron').Screen, emitWindowEvent: (win: any, event: string, payload: unknown) => unknown }} deps
 */
function wireWindowMoveEvent(win, { screen, emitWindowEvent }) {
  win.on('move', () => {
    if (win.isDestroyed()) return;
    emitWindowEvent(win, 'tauri://move', physicalPositionOf(screen, win));
  });
}

module.exports = {
  MIN_VISIBLE_DIP,
  parsePositionValue,
  physicalPositionOf,
  physicalToDip,
  clampOntoDisplays,
  resolveWindowPosition,
  wireWindowMoveEvent,
};
