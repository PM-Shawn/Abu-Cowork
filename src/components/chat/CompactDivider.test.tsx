// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import CompactDivider from './CompactDivider';
import type { Message } from '@/types';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      chat: {
        compactDivider: {
          compacted: '上下文已压缩',
          compactedManual: '上下文已压缩（手动）',
        },
      },
    },
  }),
}));

function makeMarker(source: 'auto' | 'manual'): Message {
  return {
    id: 'compact-boundary-test',
    role: 'system',
    content: '',
    timestamp: 0,
    compactBoundary: {
      summaryText: 'summary',
      summarizedFromId: 'm1',
      summarizedToId: 'm2',
      createdAt: 0,
      source,
    },
  };
}

describe('CompactDivider', () => {
  afterEach(() => cleanup());

  it('renders "上下文已压缩" for an auto marker', () => {
    render(<CompactDivider message={makeMarker('auto')} />);
    expect(screen.getByText('上下文已压缩')).toBeInTheDocument();
  });

  it('renders "上下文已压缩（手动）" for a manual marker', () => {
    render(<CompactDivider message={makeMarker('manual')} />);
    expect(screen.getByText('上下文已压缩（手动）')).toBeInTheDocument();
  });

  it('draws separator lines and a tertiary UI-size label', () => {
    const { container } = render(<CompactDivider message={makeMarker('auto')} />);
    const label = screen.getByText('上下文已压缩');
    expect(label).toHaveClass('text-ui-sm');
    expect(label.parentElement).toHaveClass('text-label-tertiary');
    expect(container.querySelectorAll('.bg-separator')).toHaveLength(2);
  });
});
