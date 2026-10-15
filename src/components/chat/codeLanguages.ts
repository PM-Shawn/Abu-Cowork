import { useEffect, useSyncExternalStore } from 'react';
import { refractor } from 'refractor/core';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';

// Prism grammars are loaded the first time a code block names their language, so
// the first-screen bundle carries only the grammars MarkdownRenderer registers
// up front. The table of the 297 loaders is itself loaded with the first such
// language. Each loader registers into the same refractor instance PrismLight
// highlights with.

const PLAIN_TEXT = 'text';

// Language names models write that are neither a loader key nor reachable before
// the grammar is loaded: the aliases each refractor grammar declares for itself,
// the kebab-case names of the grammars whose loader key is camelCase, and a few
// common spellings Prism does not know.
export const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  // Aliases declared by the refractor grammars.
  g4: 'antlr4', ino: 'arduino', 'arm-asm': 'armasm', art: 'arturo', adoc: 'asciidoc',
  avs: 'avisynth', avdl: 'avroIdl', gawk: 'awk', sh: 'bash', shell: 'bash',
  shortcode: 'bbcode', rbnf: 'bnf', oscript: 'bsl', cfc: 'cfscript', 'cilk-c': 'cilkc',
  cilk: 'cilkcpp', 'cilk-cpp': 'cilkcpp', coffee: 'coffeescript', conc: 'concurnas',
  cs: 'csharp', dotnet: 'csharp', razor: 'cshtml', jinja2: 'django', 'dns-zone': 'dnsZoneFile',
  dockerfile: 'docker', gv: 'dot', eta: 'ejs', xls: 'excelFormula', xlsx: 'excelFormula',
  po: 'gettext', gamemakerlanguage: 'gml', gni: 'gn', 'go-mod': 'goModule',
  hbs: 'handlebars', mustache: 'handlebars', hs: 'haskell', idr: 'idris',
  gitignore: 'ignore', hgignore: 'ignore', npmignore: 'ignore', js: 'javascript',
  webmanifest: 'json', kt: 'kotlin', kts: 'kotlin', kum: 'kumir', context: 'latex', tex: 'latex',
  ly: 'lilypond', ld: 'linkerScript', elisp: 'lisp', emacs: 'lisp', 'emacs-lisp': 'lisp',
  md: 'markdown', atom: 'markup', html: 'markup', mathml: 'markup', rss: 'markup',
  ssml: 'markup', svg: 'markup', xml: 'markup', moon: 'moonscript', n4jsd: 'n4js',
  nani: 'naniscript', objc: 'objectivec', qasm: 'openqasm', objectpascal: 'pascal',
  px: 'pcaxis', pcode: 'peoplecode', plantuml: 'plantUml', mscript: 'powerquery',
  pq: 'powerquery', pbfasm: 'purebasic', purs: 'purescript', py: 'python', qs: 'qsharp',
  rkt: 'racket', rpy: 'renpy', res: 'rescript', robot: 'robotframework', rb: 'ruby',
  'sh-session': 'shellSession', shellsession: 'shellSession', smlnj: 'sml', sol: 'solidity',
  sln: 'solutionFile', rq: 'sparql', sclang: 'supercollider', t4: 't4Cs', trickle: 'tremor',
  troy: 'tremor', trig: 'turtle', ts: 'typescript', tsconfig: 'typoscript', uc: 'unrealscript',
  uscript: 'unrealscript', url: 'uri', vb: 'visualBasic', vba: 'visualBasic', webidl: 'webIdl',
  mathematica: 'wolfram', nb: 'wolfram', wl: 'wolfram', xeoracube: 'xeora', yml: 'yaml',
  // Kebab-case names of the grammars whose loader key is camelCase.
  'avro-idl': 'avroIdl', 'css-extras': 'cssExtras', 'dns-zone-file': 'dnsZoneFile',
  'excel-formula': 'excelFormula', 'firestore-security-rules': 'firestoreSecurityRules',
  'icu-message-format': 'icuMessageFormat', 'js-extras': 'jsExtras', 'js-templates': 'jsTemplates',
  'linker-script': 'linkerScript', 'markup-templating': 'markupTemplating',
  'nand2tetris-hdl': 'nand2tetrisHdl', 'php-extras': 'phpExtras', 'plant-uml': 'plantUml',
  'shell-session': 'shellSession', 'solution-file': 'solutionFile', 'splunk-spl': 'splunkSpl',
  't4-cs': 't4Cs', 't4-templating': 't4Templating', 't4-vb': 't4Vb', 'visual-basic': 'visualBasic',
  'web-idl': 'webIdl', 'xml-doc': 'xmlDoc', false: 'falselang',
  // Common spellings outside Prism's own vocabulary.
  'c++': 'cpp', 'c#': 'csharp', golang: 'go', zsh: 'bash', shellscript: 'bash',
  console: 'shellSession', jsonc: 'json', vue: 'markup', rs: 'rust', ps1: 'powershell',
  tf: 'hcl', terraform: 'hcl', make: 'makefile', mjs: 'javascript', cjs: 'javascript',
};

type LoaderTable = typeof import('react-syntax-highlighter/dist/esm/async-languages/prism').default;

// One import for the module's lifetime (TESTING.md §3, concurrent imports of one module).
let loaderTable: Promise<LoaderTable> | null = null;
function loadLoaderTable(): Promise<LoaderTable> {
  loaderTable ??= import('react-syntax-highlighter/dist/esm/async-languages/prism').then((module) => module.default);
  return loaderTable;
}

// Grammar name to highlight with, per hint, once the hint's grammar has loaded.
const loadedNames = new Map<string, string>();
// Hints whose lookup has started, so each is looked up once.
const requestedHints = new Set<string>();
// Grammar name per loader key, once per grammar however many hints name it.
const grammarLoads = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();

function loadGrammar(table: LoaderTable, key: string): Promise<string> {
  let load = grammarLoads.get(key);
  if (!load) {
    load = new Promise<string>((resolve) => {
      void table[key]((name, language) => {
        SyntaxHighlighter.registerLanguage(name, language);
        resolve(language.displayName);
      });
    });
    grammarLoads.set(key, load);
  }
  return load;
}

/**
 * The language name to hand PrismLight for a code block's language hint: plain
 * text while the hint's grammar is not registered, and for a hint no Prism
 * grammar answers to.
 */
export function codeLanguageName(hint: string | null): string {
  if (!hint) return PLAIN_TEXT;
  const name = hint.toLowerCase();
  if (refractor.registered(name)) return name;
  return loadedNames.get(name) ?? PLAIN_TEXT;
}

/** Starts loading the grammar a hint names, once; does nothing for a registered or unknown one. */
export function loadCodeLanguage(hint: string | null): void {
  if (!hint) return;
  const name = hint.toLowerCase();
  if (refractor.registered(name) || requestedHints.has(name)) return;
  requestedHints.add(name);
  void loadLoaderTable().then(async (table) => {
    const key = Object.keys(table).find((candidate) => candidate.toLowerCase() === name) ?? LANGUAGE_ALIASES[name];
    if (!key) return;
    loadedNames.set(name, await loadGrammar(table, key));
    for (const listener of listeners) listener();
  });
}

export function subscribeCodeLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * {@link codeLanguageName}, loading the grammar and re-rendering the caller once
 * it is registered; a grammar that loads for another language re-renders nothing.
 */
export function useCodeLanguage(hint: string | null): string {
  const name = useSyncExternalStore(subscribeCodeLanguages, () => codeLanguageName(hint), () => codeLanguageName(hint));
  useEffect(() => loadCodeLanguage(hint), [hint]);
  return name;
}
