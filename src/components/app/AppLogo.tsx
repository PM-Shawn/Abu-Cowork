import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { loadLocalImage } from '@/utils/pathUtils';
import { useEffectiveThemeIsDark } from '@/hooks/useEffectiveThemeIsDark';
import abuAvatar from '@/assets/abu-avatar.png';

const SIZE = { sm: 'h-5 w-5 text-caption', md: 'h-7 w-7 text-ui-sm', lg: 'h-10 w-10 text-title', xl: 'h-20 w-20 text-title-lg' } as const;

/**
 * An app's logo: the package image (light or dark variant by theme) loaded
 * through the scoped file bridge, the app's first letter while it loads or
 * when the package ships none, and Abu's own avatar for the general shell.
 */
export default function AppLogo({ name, logo, logoDark, general = false, size = 'md', className }: {
  name: string;
  logo?: string;
  logoDark?: string;
  /** The general shell: Abu's avatar instead of a package image. */
  general?: boolean;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const dark = useEffectiveThemeIsDark();
  const path = (dark ? logoDark : undefined) ?? logo ?? logoDark;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path) { setSrc(null); return; }
    let url: string | null = null;
    let cancelled = false;
    void loadLocalImage(path).then((loaded) => {
      if (cancelled) { URL.revokeObjectURL(loaded); return; }
      url = loaded;
      setSrc(loaded);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  // The letter mark takes its size from SIZE; font-medium also overrides the weight a title size brings.
  const box = cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-control bg-fill font-medium text-label select-none', SIZE[size], className);
  if (general) return <span className={box} data-testid="app-logo" data-app-logo="general"><img src={abuAvatar} alt="" className="h-full w-full object-cover" /></span>;
  if (src) return <span className={box} data-testid="app-logo" data-app-logo="image"><img src={src} alt="" className="h-full w-full object-cover" /></span>;
  return <span className={box} data-testid="app-logo" data-app-logo="letter" aria-hidden="true">{name.trim().charAt(0)}</span>;
}
