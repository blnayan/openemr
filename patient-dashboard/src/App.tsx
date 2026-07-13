/**
 * SPA shell.
 *
 * Layout (top → bottom):
 *
 *   1. Identity strip — full-width, persistent, pinned below the OpenEMR
 *      top bar.
 *   2. <main> card grid — empty in this slice; subsequent issues mount
 *      Allergies / Problems / Medications / Prescriptions / Care Team / Labs
 *      cards into it.
 *
 * Auth + patient binding live one level up: `useAuth()` runs here and the
 * resulting `accessToken` feeds the `FhirClientProvider`. Card hooks read
 * the same access token via `usePatient(...)`-style queries.
 */

import React, { useCallback, useState } from 'react';

import { useAuth, readBootstrapConfigSafe } from './auth/useAuth';
import { FhirClientProvider } from './fhir/FhirClientProvider';
import { usePatient } from './fhir/hooks/usePatient';
import { IdentityStrip } from './components/IdentityStrip';
import { TabBar } from './components/TabBar';
import { AllergiesCard } from './components/AllergiesCard';
import { ProblemsCard } from './components/ProblemsCard';
import { MedicationsCard } from './components/MedicationsCard';
import { PrescriptionsCard } from './components/PrescriptionsCard';
import { CareTeamCard } from './components/CareTeamCard';
import { LabResultsCard } from './components/LabResultsCard';
import { CoPilotLauncher } from './components/CoPilotLauncher';
import { CoPilotDock } from './components/CoPilotDock';

function App(): React.JSX.Element {
  const { accessToken, patient, userId, error } = useAuth();

  if (error !== null) {
    return <ShellMessage tone="error">Auth error: {error.message}</ShellMessage>;
  }

  if (accessToken === null || patient === null) {
    return <ShellMessage>Loading…</ShellMessage>;
  }

  return (
    <FhirClientProvider accessToken={accessToken}>
      <Dashboard
        patientId={patient}
        accessToken={accessToken}
        userId={userId}
      />
    </FhirClientProvider>
  );
}

interface DashboardProps {
  patientId: string;
  accessToken: string;
  /**
   * Logged-in OpenEMR user id (id_token `sub`). May be null when the
   * id_token wasn't returned or couldn't be decoded; the card collapse
   * hook then falls back to a non-user-scoped key.
   */
  userId: string | null;
}

function Dashboard({
  patientId,
  accessToken,
  userId,
}: DashboardProps): React.JSX.Element {
  // All hooks run on every render — never gate them behind early returns,
  // or React throws #310 ("Rendered more hooks than during the previous
  // render"). Conditionals operate on the resulting state below.
  const patientQuery = usePatient(patientId, accessToken);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const onOpenCopilot = useCallback(() => setCopilotOpen(true), []);
  const onCloseCopilot = useCallback(() => setCopilotOpen(false), []);

  if (patientQuery.isError) {
    return (
      <ShellMessage tone="error">
        Failed to load patient. Please reload from the patient menu.
      </ShellMessage>
    );
  }

  if (patientQuery.data === undefined) {
    return <ShellMessage>Loading patient…</ShellMessage>;
  }

  // Shared props for every card — the collapse hook needs both userId
  // and pid, and threading them through here keeps the cards from each
  // re-deriving the same auth context.
  const cardScope = { userId, pid: patientId };

  const patient = patientQuery.data;

  // Resolve the patient menu from the PHP-injected bootstrap. If it's
  // missing (dev / test harness) we render no tab bar — the SPA still
  // works, the user just doesn't see the cross-page nav. The legacy
  // demographics.php had this same pre-flight in PatientMenuRole.
  const bootstrap = readBootstrapConfigSafe();
  const menuItems = bootstrap?.menu ?? [];
  const webroot = bootstrap?.webroot ?? '';
  const menuPid = bootstrap?.pid ?? '';

  return (
    <>
      <IdentityStrip patient={patient} />
      {menuItems.length > 0 && (
        <TabBar
          items={menuItems}
          activeId="dashboard"
          webroot={webroot}
          pid={menuPid}
        />
      )}
      <main className="p-4">
        <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3 items-start">
          <AllergiesCard
            patientId={patientId}
            accessToken={accessToken}
            {...cardScope}
          />
          <ProblemsCard
            patientId={patientId}
            accessToken={accessToken}
            {...cardScope}
          />
          <MedicationsCard
            patientId={patientId}
            accessToken={accessToken}
            {...cardScope}
          />
          <div className="col-span-full">
            <PrescriptionsCard
              patientId={patientId}
              accessToken={accessToken}
              {...cardScope}
            />
          </div>
          <div className="col-span-full">
            <CareTeamCard
              patientId={patientId}
              accessToken={accessToken}
              {...cardScope}
            />
          </div>
          <div className="col-span-full">
            <LabResultsCard
              patientId={patientId}
              accessToken={accessToken}
              {...cardScope}
            />
          </div>
          {/* Future cards plug into this same 3-col grid. */}
        </div>
      </main>
      <CoPilotLauncher isOpen={copilotOpen} onOpen={onOpenCopilot} />
      <CoPilotDock
        isOpen={copilotOpen}
        onClose={onCloseCopilot}
        patientId={patientId}
        patientName={patient.name}
        patientFirstName={patient.given}
      />
    </>
  );
}

interface ShellMessageProps {
  tone?: 'info' | 'error';
  children: React.ReactNode;
}

function ShellMessage({
  tone = 'info',
  children,
}: ShellMessageProps): React.JSX.Element {
  const colorClass = tone === 'error' ? 'text-severe' : 'text-ink-muted';
  return (
    <div className="p-6">
      <p className={`m-0 ${colorClass}`}>{children}</p>
    </div>
  );
}

export default App;
