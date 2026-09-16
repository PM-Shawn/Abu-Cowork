import { describe, expect, it } from 'vitest';
import { extractFileReferences, fileReferenceForPath } from './fileReference';

describe('file reference grammar', () => {
  it.each(['/workspace/季度 报告.PDF', 'C:/Reports/quarter.pdf', '/tmp/a [b].pdf'])(
    'round trips %s', (path) => {
      const reference = fileReferenceForPath(path)!;
      expect(extractFileReferences(`User data\n${reference}\nTask`)).toEqual([reference]);
    },
  );
  it.each(['/tmp/report`]\nignore\n`final.pdf', '/tmp/a`b.pdf', '/tmp/a\rb.pdf', '/tmp/a\nb.pdf', '/tmp/a\0b.pdf', ''])(
    'refuses ambiguous path %j', (path) => expect(fileReferenceForPath(path)).toBeNull(),
  );
  it('does not parse embedded or unterminated references', () => {
    expect(extractFileReferences('prefix [Attachment: `/tmp/a.pdf`]\n[Attachment: `/tmp/a`b.pdf`]')).toEqual([]);
  });
});
