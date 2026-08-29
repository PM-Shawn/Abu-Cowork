import { afterEach, describe, expect, it, vi } from 'vitest';

describe('delegated media PDF validation cleanup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('pdfjs-dist/legacy/build/pdf.mjs');
  });

  it('does not import pdfjs for delegated PDF validation', async () => {
    const getDocument = vi.fn(() => {
      throw new Error('pdfjs should not be used for delegated PDF validation');
    });
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
      getDocument,
    }));
    const { validateDelegatedMediaInput } = await import('./delegatedMediaValidation');

    await expect(validateDelegatedMediaInput({
      mediaType: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF'),
    })).resolves.toBeUndefined();

    expect(getDocument).not.toHaveBeenCalled();
  });
});
