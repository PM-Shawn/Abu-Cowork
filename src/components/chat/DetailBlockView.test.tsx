// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';
import type { DetailBlock } from '@/types/execution';
import DetailBlockView from './DetailBlockView';

const mockResolveOutputRefSource = vi.hoisted(() => vi.fn());
const mockLoadLocalImage = vi.hoisted(() => vi.fn());

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveOutputRefSource: (...args: unknown[]) => mockResolveOutputRefSource(...args),
}));

vi.mock('@/utils/pathUtils', async () => {
  const actual = await vi.importActual<typeof import('@/utils/pathUtils')>('@/utils/pathUtils');
  return {
    ...actual,
    loadLocalImage: (...args: unknown[]) => mockLoadLocalImage(...args),
  };
});

const conversation: Conversation = {
  id: 'conv-1',
  title: 'Test',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  status: 'idle',
};

function outputRefImageBlock(overrides: Partial<DetailBlock> = {}): DetailBlock {
  return {
    id: 'block-image',
    stepId: 'step-1',
    type: 'image',
    label: 'Image',
    content: 'Image: /tmp/line_chart.png (37KB, image/png)',
    isTruncated: false,
    isExpanded: true,
    imageData: {
      mediaType: 'image/png',
      outputRef: {
        relPath: 'files/hash/result.png',
        basename: 'result.png',
        sizeBytes: 1234,
      },
    },
    ...overrides,
  };
}

describe('DetailBlockView outputRef image loading', () => {
  beforeEach(() => {
    initLanguage('en-US');
    mockResolveOutputRefSource.mockReset();
    mockLoadLocalImage.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:result'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    useChatStore.setState({
      activeConversationId: 'conv-1',
      conversations: { 'conv-1': conversation },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads an outputRef image into the fixed image frame', async () => {
    mockResolveOutputRefSource.mockResolvedValue({ status: 'available', path: '/snapshot/result.png', isFromSnapshot: true });
    mockLoadLocalImage.mockResolvedValue('blob:result');

    render(<DetailBlockView block={outputRefImageBlock()} onToggle={() => {}} />);

    expect(screen.getByText('Loading image...')).toBeInTheDocument();
    expect(screen.queryByText('Image unavailable')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    const image = await screen.findByRole('img', { name: /line_chart/ });
    expect(image).toHaveAttribute('src', 'blob:result');
    expect(screen.getByText('result.png · 1.2 KB')).toBeInTheDocument();
    expect(screen.queryByText('Image: /tmp/line_chart.png (37KB, image/png)')).not.toBeInTheDocument();
    expect(mockResolveOutputRefSource).toHaveBeenCalledWith('conv-1', 'files/hash/result.png');
    expect(mockLoadLocalImage).toHaveBeenCalledWith('/snapshot/result.png');
  });

  it('shows an unavailable placeholder with retry when outputRef cannot be resolved', async () => {
    mockResolveOutputRefSource.mockResolvedValue({ status: 'missing', basename: 'result.png', originalPath: 'files/hash/result.png' });

    render(<DetailBlockView block={outputRefImageBlock()} onToggle={() => {}} />);

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    expect(screen.getByText('result.png · 1.2 KB')).toBeInTheDocument();
    expect(screen.queryByText('Image: /tmp/line_chart.png (37KB, image/png)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockResolveOutputRefSource).toHaveBeenCalledTimes(2));
  });

  it('names its loading spinner while the saved image is read', () => {
    mockResolveOutputRefSource.mockReturnValue(new Promise(() => {}));

    render(<DetailBlockView block={outputRefImageBlock()} onToggle={() => {}} />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading image...');
    expect(status.querySelector('[data-ds-spinner]')).not.toBeNull();
  });

  it('opens the enlarged view from the image button', async () => {
    mockResolveOutputRefSource.mockResolvedValue({ status: 'available', path: '/snapshot/result.png', isFromSnapshot: true });
    mockLoadLocalImage.mockResolvedValue('blob:result');

    render(<DetailBlockView block={outputRefImageBlock()} onToggle={() => {}} />);

    const image = await screen.findByRole('img', { name: /line_chart/ });
    const button = image.closest('button')!;
    expect(button).not.toBeNull();
    fireEvent.click(button);
    expect(screen.getAllByRole('img', { name: /line_chart/ })).toHaveLength(2);
  });
});

function textBlock(overrides: Partial<DetailBlock>): DetailBlock {
  return {
    id: 'block-text',
    stepId: 'step-1',
    type: 'script',
    label: 'Details',
    content: 'echo hi',
    isTruncated: false,
    isExpanded: true,
    ...overrides,
  };
}

describe('DetailBlockView neutral surfaces', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  it('draws every block kind in neutral grey on the code surface', () => {
    render(<DetailBlockView block={textBlock({ type: 'json', content: '{"a":1}' })} onToggle={() => {}} />);

    const chip = screen.getByRole('button', { name: /Details/ });
    expect(chip).toHaveClass('bg-fill');
    expect(chip).toHaveClass('text-label-secondary');
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const pre = screen.getByText(/"a": 1/);
    expect(pre).toHaveClass('font-code');
    expect(pre.closest('.bg-code')).not.toBeNull();
    expect(document.body.innerHTML).not.toMatch(/purple/);
  });

  it('marks an error block with the danger status icon', () => {
    render(<DetailBlockView block={textBlock({ type: 'error', content: 'boom' })} onToggle={() => {}} />);

    const chip = screen.getByRole('button', { name: /Details/ });
    expect(chip.querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(screen.getByText('boom')).toHaveClass('text-danger');
  });

  it('opens list results as links in the browser', () => {
    render(
      <DetailBlockView
        block={textBlock({ type: 'list', parsedItems: [{ title: 'Result page', url: 'https://example.com/a' }] })}
        onToggle={() => {}}
      />,
    );

    const link = screen.getByRole('link', { name: /Result page/ });
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveClass('text-link');
  });
});
