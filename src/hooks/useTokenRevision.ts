import { useEffect, useState } from 'react';
import { APPEARANCE_ATTRIBUTES } from '@/styles/appearance';

// For third-party components that only take concrete color values (xterm): the number
// goes up by one each time the appearance changes, which tells the caller to read the
// `--ds-*` variables again. tokens.css switches the variables themselves.
//
// The appearance lives on <html>: the `dark` class, increased contrast, reduced
// transparency, and the window material written by src/styles/windowMaterial.ts.
const WATCHED_ATTRIBUTES = [
  'class',
  APPEARANCE_ATTRIBUTES.contrast[0],
  APPEARANCE_ATTRIBUTES.transparency[0],
  'data-window-material',
];

export function useTokenRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setRevision((n) => n + 1);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: WATCHED_ATTRIBUTES });
    return () => observer.disconnect();
  }, []);

  return revision;
}
