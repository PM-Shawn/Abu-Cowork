/**
 * Geometry of the desktop pet window's frame changes (`pet_set_frame`).
 *
 * Pure over an injected work-area lookup so it runs under plain Node in
 * electron/guiHost.petFrame.test.cjs and as the window model behind
 * src/pet/PetApp.test.tsx.
 */
'use strict';

/** The bare avatar's side, in DIP — the collapsed pet window is exactly this big. */
const PET_SIZE = 80;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ bounds: Rect, avatarOffset: Point }} PetFrame
 */

/**
 * The pet window's next frame for a `pet_set_frame` request.
 *
 * The avatar's place on screen is the fixed point of every frame change. It is
 * the window's origin plus `avatarOffset`, which the caller keeps between
 * requests; moving the window (a drag, an edge snap) moves it with it.
 * `anchorBottom` / `anchorRight` name the corner of the requested frame the
 * renderer puts the avatar in, so the frame is laid out around the avatar from
 * there. A frame larger than the bare avatar is kept inside the work area, and
 * the distance that pushed it is carried in the returned `avatarOffset`; the
 * bare avatar's frame is the avatar's place itself, so collapsing always comes
 * back to it, including a spot the edge snap parked partly off-screen.
 * @param {PetFrame} current
 * @param {{ width: number, height: number, anchorBottom: boolean, anchorRight: boolean }} request
 * @param {(point: Point) => Rect} workAreaAt work area of the display nearest a point
 * @returns {PetFrame}
 */
function resolvePetFrame(current, request, workAreaAt) {
  const { width, height, anchorBottom, anchorRight } = request;
  const avatar = {
    x: current.bounds.x + current.avatarOffset.x,
    y: current.bounds.y + current.avatarOffset.y,
  };
  let x = avatar.x - (anchorRight ? width - PET_SIZE : 0);
  let y = avatar.y - (anchorBottom ? height - PET_SIZE : 0);
  if (width > PET_SIZE || height > PET_SIZE) {
    const wa = workAreaAt({ x: avatar.x + PET_SIZE / 2, y: avatar.y + PET_SIZE / 2 });
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  }
  return {
    bounds: { x, y, width, height },
    avatarOffset: { x: avatar.x - x, y: avatar.y - y },
  };
}

module.exports = { PET_SIZE, resolvePetFrame };
