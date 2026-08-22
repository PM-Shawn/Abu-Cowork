// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConversationSearchModal from './ConversationSearchModal';

describe('ConversationSearchModal', () => {
  it('closes on Escape even before the search input receives focus', () => {
    const onClose = vi.fn();

    render(<ConversationSearchModal open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
