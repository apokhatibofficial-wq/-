import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@medlink/shared/styles.css';
import './scan/scan.css';
import { App } from './App';
import { ScanApp } from './scan/ScanApp';

// app.medlink.website/scan is the phone scanner; everything else is the hospital web.
const isScan = /^\/scan\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isScan ? <ScanApp /> : <App />}
  </StrictMode>,
);
