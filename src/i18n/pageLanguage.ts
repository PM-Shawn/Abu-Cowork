import { getResolvedLocale, subscribeLanguage } from './index';

// Keeps `lang` on <html> equal to the resolved interface locale (`zh-CN` or `en-US`, both BCP 47
// tags), so assistive technology and the browser's own text handling read the page in the
// language its words are written in. Each window's entry point calls it before it renders.

/** Sets the attribute now, follows every change of the language setting, and returns the function that stops following. */
export function followPageLanguage(root: HTMLElement = document.documentElement): () => void {
  const apply = () => { root.setAttribute('lang', getResolvedLocale()); };
  apply();
  return subscribeLanguage(apply);
}
