import { describe, it, expect, beforeAll } from 'vitest';
import { refractor } from 'refractor/core';

type CodeLanguages = typeof import('./codeLanguages');
let languages: CodeLanguages;

beforeAll(async () => {
  languages = await import('./codeLanguages');
});

/** Resolves on the next grammar registration, counting every notification until then. */
function nextRegistration(): { done: Promise<void>; count: () => number } {
  let calls = 0;
  let unsubscribe = () => {};
  const done = new Promise<void>((resolve) => {
    unsubscribe = languages.subscribeCodeLanguages(() => {
      calls += 1;
      resolve();
    });
  });
  void done.then(() => unsubscribe());
  return { done, count: () => calls };
}

describe('codeLanguages', () => {
  describe('codeLanguageName', () => {
    it('is plain text for a missing hint', () => {
      expect(languages.codeLanguageName(null)).toBe('text');
      expect(languages.codeLanguageName('')).toBe('text');
    });

    it('is plain text for a language no Prism grammar answers to', () => {
      expect(languages.codeLanguageName('no-such-language')).toBe('text');
    });
  });

  describe('loadCodeLanguage', () => {
    it('keeps a grammar plain until it loads, then names it', async () => {
      expect(languages.codeLanguageName('rust')).toBe('text');
      const registration = nextRegistration();
      languages.loadCodeLanguage('rust');
      await registration.done;
      expect(languages.codeLanguageName('rust')).toBe('rust');
    });

    it('reads the hint without regard to case', async () => {
      const registration = nextRegistration();
      languages.loadCodeLanguage('Ruby');
      await registration.done;
      expect(languages.codeLanguageName('RUBY')).toBe('ruby');
    });

    it.each([
      ['c++', 'int main() { return 0; }'],
      ['golang', 'func main() { return }'],
      ['yml', 'key: value'],
      ['dockerfile', 'FROM node:22'],
      ['shell-session', '$ ls -la'],
    ])('loads %s through its alias and highlights with the name it returns', async (hint, code) => {
      const registration = nextRegistration();
      languages.loadCodeLanguage(hint);
      await registration.done;
      const name = languages.codeLanguageName(hint);
      expect(name).not.toBe('text');
      expect(refractor.highlight(code, name).children.some((node) => node.type === 'element')).toBe(true);
    });

    it('loads a grammar once when it is asked for twice before it arrives', async () => {
      const registration = nextRegistration();
      languages.loadCodeLanguage('kotlin');
      languages.loadCodeLanguage('kotlin');
      await registration.done;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(registration.count()).toBe(1);
      expect(languages.codeLanguageName('kotlin')).toBe('kotlin');
    });

    it('starts nothing for a language no Prism grammar answers to', async () => {
      const registration = nextRegistration();
      languages.loadCodeLanguage('no-such-language');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(registration.count()).toBe(0);
    });
  });

  describe('the alias table', () => {
    it('points every alias at a grammar it can load', async () => {
      const loaders = (await import('react-syntax-highlighter/dist/esm/async-languages/prism')).default;
      const targets = Object.values(languages.LANGUAGE_ALIASES);
      expect(targets.filter((target) => !(target in loaders))).toEqual([]);
    });
  });
});
