import { describe, expect, it } from 'vitest';
import { redactInlineMediaPayloads, redactSensitiveMediaText } from './redaction';

describe('redactInlineMediaPayloads', () => {
  it('redacts base64 data URL payloads without redacting ordinary paths', () => {
    const dataUrls = [
      'data:image/png;base64,QQ==',
      'data:image/png;charset=utf-8;base64,QUJDRA==',
      'data:application/pdf;name=secret.pdf;base64,JVBERi0=',
      'data:;base64,QQ==',
    ];
    const plainPath = '/Users/shawn/proj/src/index.ts';
    const glob = 'glob **/*.ts';
    const sanitized = redactInlineMediaPayloads(`${plainPath} ${glob} ${dataUrls.join(' ')}`);

    expect(sanitized).toContain(plainPath);
    expect(sanitized).toContain(glob);
    for (const dataUrl of dataUrls) {
      expect(sanitized).not.toContain(dataUrl);
    }
    expect(sanitized).not.toMatch(/QQ==|QUJDRA==|JVBERi0=/);
    expect(sanitized).not.toContain('[REDACTED:path]');
    expect(sanitized.match(/\[REDACTED:base64\]/g)).toHaveLength(4);
  });
});

describe('redactSensitiveMediaText', () => {
  it('redacts parameterized and empty-MIME data URLs plus angle-bracketed local paths without breaking https', () => {
    const dataUrls = [
      'data:image/png;charset=utf-8;base64,QUJDRA==',
      'data:application/pdf;name=secret.pdf;base64,JVBERi0=',
      'data:;base64,QQ==',
    ];
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = redactSensitiveMediaText(
      `${dataUrls.join(' ')} </Users/alice/secret.png> ${httpsUrl}`,
    );

    for (const dataUrl of dataUrls) {
      expect(sanitized).not.toContain(dataUrl);
    }
    expect(sanitized).not.toContain('/Users/alice/secret.png');
    expect(sanitized).toContain('<[REDACTED:path]>');
    expect(sanitized).toContain(httpsUrl);
    expect(sanitized).toContain('[REDACTED:base64]');
  });

  it('preserves simple HTML closing tags while redacting angle-bracketed absolute paths', () => {
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = redactSensitiveMediaText(`</div> </Users/alice/secret.png> ${httpsUrl}`);

    expect(sanitized).toContain('</div>');
    expect(sanitized).not.toContain('/Users/alice/secret.png');
    expect(sanitized).toContain('<[REDACTED:path]>');
    expect(sanitized).toContain(httpsUrl);
  });

  it('redacts angle-wrapped POSIX, Windows, and UNC paths containing spaces', () => {
    const secrets = [
      '</Users/Alice Smith/private image.png>',
      '<C:\\Users\\Alice Smith\\private image.png>',
      '<\\\\server\\Alice Smith\\private image.png>',
    ];
    const sanitized = redactSensitiveMediaText(secrets.join(' | '));

    for (const secret of secrets) expect(sanitized).not.toContain(secret.slice(1, -1));
    expect(sanitized.match(/<\[REDACTED:path\]>/g)).toHaveLength(3);
  });

  it('redacts wrapped, URL-safe, and quoted-parameter base64 data URLs without leaving payload tails', () => {
    const inputs = [
      'data:image/png;base64,QUJD\nRA==',
      'data:image/png;base64,QUJD-RA__',
      'data:image/png;name="secret file.png";base64,QUJDRA==',
    ];
    const sanitized = redactSensitiveMediaText(inputs.join(' | '));

    expect(sanitized).not.toMatch(/QUJD|RA==|RA__|secret file\.png/);
    expect(sanitized.match(/\[REDACTED:base64\]/g)).toHaveLength(3);
  });
});
