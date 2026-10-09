import type { ComponentProps } from 'react';

// The input behind a "choose files" button. It is never shown: the button clicks it through a ref.
export function HiddenFileInput(props: Omit<ComponentProps<'input'>, 'type' | 'className'>) {
  return <input type="file" tabIndex={-1} className="hidden" {...props} />;
}
