// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

describe('Popover', () => {
  it('opens from its trigger with visible focus and reduced-motion fallbacks', async () => {
    const user = userEvent.setup();

    render(
      <Popover>
        <PopoverTrigger>Open breakdown</PopoverTrigger>
        <PopoverContent>Context breakdown</PopoverContent>
      </Popover>,
    );

    expect(screen.queryByText('Context breakdown')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open breakdown' }));

    const content = screen.getByText('Context breakdown');
    expect(content).toBeInTheDocument();
    expect(content).not.toHaveClass('outline-none');
    expect(content).toHaveClass('focus-visible:ring-2');
    expect(content).toHaveClass('motion-reduce:animate-none');
  });
});
