// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  BookOpen, Bot, Calculator, Camera, ChartBar, Code, Compass, Cpu, Database, FlaskConical, Globe, Megaphone,
  Palette, PenLine, Scale, Search, ShieldCheck, Sparkles, UsersRound, Wrench,
} from 'lucide-react';
import { Icon } from './icon';
import { AppIcons, AvatarGlyphs } from './icons';

describe('Icon', () => {
  it('renders 16px with a 1.5 stroke by default', () => {
    const { container } = render(<Icon icon={AppIcons.copy} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  it.each([
    ['sm', '14'],
    ['md', '16'],
    ['lg', '20'],
  ] as const)('renders size %s as %spx', (size, px) => {
    const { container } = render(<Icon icon={AppIcons.add} size={size} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', px);
  });

  it('is hidden from assistive tech when it has no label', () => {
    const { container } = render(<Icon icon={AppIcons.close} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('is announced as an image when it has a label', () => {
    const { getByRole } = render(<Icon icon={AppIcons.warning} label="Warning" />);
    expect(getByRole('img', { name: 'Warning' })).toBeInTheDocument();
  });
});

describe('AppIcons', () => {
  it('maps every standard action to a renderable icon', () => {
    for (const [name, glyph] of Object.entries(AppIcons)) {
      const { container, unmount } = render(<Icon icon={glyph} />);
      expect(container.querySelector('svg'), name).not.toBeNull();
      unmount();
    }
  });

  it('includes the glyphs the component library needs', () => {
    expect(Object.keys(AppIcons)).toEqual(expect.arrayContaining(['loading', 'mixed', 'selectorChevrons']));
  });
});

describe('AvatarGlyphs', () => {
  it('holds the twenty glyphs an avatar can show, each a renderable icon', () => {
    expect(Object.keys(AvatarGlyphs).sort()).toEqual([
      'book', 'bot', 'calculator', 'camera', 'chartBar', 'code', 'compass', 'cpu', 'database', 'flask',
      'globe', 'megaphone', 'palette', 'pen', 'scale', 'search', 'shield', 'sparkles', 'users', 'wrench',
    ]);
    for (const [name, glyph] of Object.entries(AvatarGlyphs)) {
      const { container, unmount } = render(<Icon icon={glyph} />);
      expect(container.querySelector('svg'), name).not.toBeNull();
      unmount();
    }
  });

  it('gives each name the glyph it had before the table moved here', () => {
    expect(AvatarGlyphs).toEqual({
      bot: Bot, chartBar: ChartBar, code: Code, flask: FlaskConical, pen: PenLine, shield: ShieldCheck,
      users: UsersRound, search: Search, database: Database, palette: Palette, compass: Compass,
      wrench: Wrench, book: BookOpen, megaphone: Megaphone, scale: Scale, sparkles: Sparkles, cpu: Cpu,
      globe: Globe, camera: Camera, calculator: Calculator,
    });
  });
});
