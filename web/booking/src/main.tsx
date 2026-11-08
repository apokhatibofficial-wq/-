import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@medlink/shared/styles.css';
import { App } from './App';
import { DoctorPage, doctorSlugFromPath } from './DoctorPage';

// medlink.website/dr/{slug} is a doctor's page; everything else is the booking site.
const doctor = doctorSlugFromPath(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {doctor ? <DoctorPage slug={doctor} /> : <App />}
  </StrictMode>,
);
