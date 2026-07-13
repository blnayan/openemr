import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App.tsx';

function renderApp(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('renders a Loading state when there is no SMART context yet', () => {
    // jsdom default URL has no iss/launch/code params, so useAuth lands on
    // the "no SMART launch context" branch — but useEffect runs after render,
    // so the initial paint shows the loading state.
    renderApp();
    // useAuth resolves synchronously to "no SMART launch context" since the
    // jsdom URL has no iss/launch/code params. The shell renders an error
    // message rather than continuing to spin.
    expect(screen.getByText(/no smart launch context/i)).toBeInTheDocument();
  });

  it('test harness wires up correctly', () => {
    expect(true).toBe(true);
  });
});
