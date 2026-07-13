/**
 * Provides a memoized `FhirClient` instance to the app, wired to the live
 * access token from `useAuth()`.
 *
 * Why a provider rather than constructing the client inside each hook? The
 * client is the single seam where tests substitute `fetchImpl` and where
 * future cross-cutting concerns (request logging, retry policy) will land.
 * Keeping it singleton-per-tree avoids re-creating closures and gives tests
 * a single override point.
 */

import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { createFhirClient, type FhirClient } from './client';

const FhirClientContext = createContext<FhirClient | null>(null);

interface FhirClientProviderProps {
  /** OAuth access token. `null` while auth is still in flight. */
  accessToken: string | null;
  /** Optional override — tests pass in a fixture client. */
  client?: FhirClient;
  /** FHIR base URL. Defaults to the OpenEMR same-origin base. */
  baseUrl?: string;
  children: ReactNode;
}

const DEFAULT_BASE_URL = '/apis/default/fhir';

export function FhirClientProvider({
  accessToken,
  client,
  baseUrl = DEFAULT_BASE_URL,
  children,
}: FhirClientProviderProps): React.JSX.Element {
  // Keep a ref to the latest token so the client closure always reads the
  // current value without being re-created on every token rotation.
  const tokenRef = useRef<string | null>(accessToken);
  tokenRef.current = accessToken;

  const value = useMemo<FhirClient>(() => {
    if (client !== undefined) {
      return client;
    }
    return createFhirClient({
      baseUrl,
      getAccessToken: () => tokenRef.current,
    });
  }, [client, baseUrl]);

  return (
    <FhirClientContext.Provider value={value}>
      {children}
    </FhirClientContext.Provider>
  );
}

export function useFhirClient(): FhirClient {
  const ctx = useContext(FhirClientContext);
  if (ctx === null) {
    throw new Error('useFhirClient must be used inside <FhirClientProvider>');
  }
  return ctx;
}
