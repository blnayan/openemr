import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App.tsx';
import './styles/app.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root not found in document');
}

// Single QueryClient for the SPA. Defaults are intentionally conservative;
// per-resource tuning (refetch intervals, etc.) lives on individual hooks.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // FHIR resources don't usually mutate from under us during a visit;
      // suppress refetch-on-window-focus so a pinned tab doesn't thrash
      // the auth + FHIR servers.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
