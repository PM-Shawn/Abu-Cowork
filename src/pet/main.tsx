import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { installAppearanceAttributes } from '../styles/appearance';
import { followSystemColorScheme } from '../styles/colorScheme';
import { followPageLanguage } from '../i18n/pageLanguage';
import { DesignSystemProvider } from '@/components/ds/provider';
import PetApp from './PetApp';

// The pet window is an entry point of its own: nothing of the main window's root is above it,
// so what its design-system components need is mounted here.
//
// Appearance: the pet has no setting of its own. The main window's setting sets the color
// scheme of the whole application, so following the media query here shows what the main window
// shows (styles/colorScheme.ts). Both run before anything is rendered; pet.html itself paints
// nothing (a transparent, empty page), so no earlier script is needed there.
const stopFollowingColorScheme = followSystemColorScheme();
const stopAppearanceAttributes = installAppearanceAttributes();
// Language: <html lang> carries the interface language this window's own i18n module resolves.
const stopFollowingPageLanguage = followPageLanguage();
window.addEventListener('pagehide', () => {
  stopFollowingColorScheme();
  stopAppearanceAttributes();
  stopFollowingPageLanguage();
}, { once: true });

createRoot(document.getElementById('pet-root')!).render(
  <StrictMode>
    <DesignSystemProvider>
      <PetApp />
    </DesignSystemProvider>
  </StrictMode>,
);
