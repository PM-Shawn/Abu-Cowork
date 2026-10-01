// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DocxPreview from './DocxPreview';

const { renderAsync } = vi.hoisted(() => ({ renderAsync: vi.fn(async () => undefined) }));
vi.mock('docx-preview', () => ({ renderAsync }));

describe('DocxPreview', () => {
  // The marker switches selected text and the reference mark to the page selection color.
  it('marks the Word page as white paper', async () => {
    render(<DocxPreview filePath="/work/report.docx" />);
    await waitFor(() => expect(renderAsync).toHaveBeenCalled());
    const page = document.querySelector('.docx-preview-container');
    expect(page).not.toBeNull();
    expect(page).toHaveAttribute('data-page-canvas');
  });

  it('takes the page background from the page canvas token', async () => {
    render(<DocxPreview filePath="/work/token.docx" />);
    await waitFor(() => expect(renderAsync).toHaveBeenCalled());
    const page = document.querySelector('.docx-preview-container') as HTMLElement;
    expect(page.style.background).toContain('--ds-page-canvas');
  });
});
