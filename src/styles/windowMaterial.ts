import { getElectronWindowMaterial } from '@/utils/electronHost';

export type WindowMaterial = 'vibrancy' | 'mica' | 'none';

const MATERIALS: readonly WindowMaterial[] = ['vibrancy', 'mica', 'none'];

// The system material the Electron shell draws behind this window. Written to <html>
// before the first paint so tokens.css can make `desk` opaque when there is none.
// A page outside the shell (web preview, tests) has nothing drawn behind it.
export function installWindowMaterial(root: HTMLElement = document.documentElement): WindowMaterial {
  const reported = getElectronWindowMaterial() ?? 'none';
  if (!MATERIALS.includes(reported as WindowMaterial)) throw new Error(`Unknown window material: ${reported}`);
  const material = reported as WindowMaterial;
  root.setAttribute('data-window-material', material);
  return material;
}
