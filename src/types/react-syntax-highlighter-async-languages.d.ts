// The package's types declare its deep ESM paths; nothing imports the package root,
// which is what would otherwise load them.
/// <reference types="react-syntax-highlighter" />

// react-syntax-highlighter ships its per-language Prism loaders without types.
declare module 'react-syntax-highlighter/dist/esm/async-languages/prism' {
  type RegisterLanguage = (name: string, language: { displayName: string }) => void;
  const loaders: Record<string, (registerLanguage: RegisterLanguage) => Promise<void>>;
  export default loaders;
}
