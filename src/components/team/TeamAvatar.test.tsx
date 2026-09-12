// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TeamAvatar from './TeamAvatar';

describe('TeamAvatar', () => {
  it.each([
    [undefined, 'default'],
    ['📊', 'emoji'],
    ['icon:code/purple', 'icon'],
    ['icon:code/missing', 'default'],
    ['icon:constructor/blue', 'default'],
  ])('renders %s as %s', (avatar, kind) => {
    render(<TeamAvatar avatar={avatar} />);
    expect(screen.getByTestId('team-avatar')).toHaveAttribute('data-avatar-kind', kind);
    expect(screen.getByTestId('team-avatar').textContent).not.toContain('icon:');
  });
});
