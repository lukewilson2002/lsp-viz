import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { desktopPlatform } from './api/client';

// Marks the document when this bundle is running inside the Electron shell,
// so the few rules that only make sense there (window-drag regions, clearing
// the macOS traffic lights) can apply without a separate desktop build.
const platform = desktopPlatform();
if (platform !== null) document.documentElement.dataset.desktop = platform;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
