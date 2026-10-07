import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { DesignSystemProvider } from '@/components/ds/provider';
import PetApp from './PetApp';

// The pet window is an entry point of its own: nothing of the main window's root is above it,
// so what its design-system components need is mounted here.
createRoot(document.getElementById('pet-root')!).render(
  <StrictMode>
    <DesignSystemProvider>
      <PetApp />
    </DesignSystemProvider>
  </StrictMode>,
);
