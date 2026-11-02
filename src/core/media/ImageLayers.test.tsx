// @vitest-environment happy-dom
import { render, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ImageLayers } from './ImageLayers';
import type { ImageMarkup } from '@/types/media';

afterEach(cleanup);

it('renders the selected region, marks and numbered comments in image coordinates', () => {
  const markup: ImageMarkup[] = [
    { id: 'pen', kind: 'pen', color: 'red', width: 0.02, points: [{ x: 0.2, y: 0.3 }] },
    { id: 'text', kind: 'text', color: 'blue', width: 0.02, point: { x: 0.5, y: 0.4 }, text: 'Label' },
    { id: 'rectangle', kind: 'rectangle', color: 'red', width: 0.02, start: { x: 0.8, y: 0.7 }, end: { x: 0.2, y: 0.3 } },
    { id: 'arrow', kind: 'arrow', color: 'red', width: 0.02, start: { x: 0.1, y: 0.2 }, end: { x: 0.9, y: 0.8 } },
  ];
  const region = [{ id: 'region', erase: false, width: 0.1, points: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.6 }] }];
  const comments = [{ id: 'comment', point: { x: 0.5, y: 0.5 }, text: 'Keep' }];
  const { container, rerender } = render(<svg><ImageLayers width={100} height={100} markup={markup} comments={comments} region={region} mode="preview" maskId="selection" /></svg>);
  expect(container.querySelector('mask path')?.getAttribute('d')).toBe('M20,30 L50,60');
  expect(container.querySelector('text')?.textContent).toBe('Label');
  expect(container.querySelector('g text')?.textContent).toBe('1');
  expect(container.querySelectorAll('path')).toHaveLength(3);
  expect(container.querySelector('rect[width="60"]')).not.toBeNull();
  rerender(<svg><ImageLayers width={100} height={100} markup={markup} comments={comments} region={region} mode="mask" maskId="selection" /></svg>);
  expect(container.querySelector('mask rect')?.getAttribute('fill')).toBe('white');
  expect(container.querySelector('mask path')?.getAttribute('stroke')).toBe('black');
  expect(container.querySelector('text')).toBeNull();
});
