import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Latin subsets only, self-hosted. Japanese and every other script fall through
// to the system stack in the CSS: the point of the typeface here is the tabular
// figures on the readouts, and a webfont request to a third party would be at
// odds with an app whose whole claim is that nothing leaves the device.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { App } from './ui/App';
import './ui/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
