/**
 * Minimal ambient FHIR R4 type stubs used by the agent service.
 * Replaces @types/fhir until that dependency is added.
 */

declare namespace fhir4 {
  interface Resource {
    resourceType: string;
    id?: string;
  }

  interface HumanName {
    use?: string;
    text?: string;
    family?: string;
    given?: string[];
  }

  interface Address {
    use?: string;
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }

  interface ContactPoint {
    system?: 'phone' | 'fax' | 'email' | 'pager' | 'url' | 'sms' | 'other';
    value?: string;
    use?: string;
  }

  interface Identifier {
    system?: string;
    value?: string;
    type?: { text?: string; coding?: Coding[] };
  }

  interface Patient extends Resource {
    resourceType: 'Patient';
    name?: HumanName[];
    gender?: string;
    birthDate?: string;
    address?: Address[];
    telecom?: ContactPoint[];
    identifier?: Identifier[];
  }

  interface Condition extends Resource {
    resourceType: 'Condition';
    code?: { text?: string; coding?: Coding[] };
    clinicalStatus?: { coding?: Coding[] };
    onsetDateTime?: string;
  }

  interface MedicationRequest extends Resource {
    resourceType: 'MedicationRequest';
    status?: string;
    medicationCodeableConcept?: { text?: string; coding?: Coding[] };
    dispenseRequest?: { validityPeriod?: { start?: string; end?: string } };
    dosageInstruction?: Array<{
      text?: string;
      doseAndRate?: Array<{ doseQuantity?: { value?: number; unit?: string } }>;
    }>;
  }

  interface Observation extends Resource {
    resourceType: 'Observation';
    code?: { text?: string; coding?: Coding[] };
    effectiveDateTime?: string;
    issued?: string;
    valueQuantity?: { value?: number; unit?: string };
    valueString?: string;
    component?: Array<{ code?: { text?: string }; valueQuantity?: { value?: number; unit?: string } }>;
  }

  interface AllergyIntolerance extends Resource {
    resourceType: 'AllergyIntolerance';
    code?: { text?: string; coding?: Coding[] };
    reaction?: Array<{ manifestation?: Array<{ text?: string }> }>;
    criticality?: string;
  }

  interface Encounter extends Resource {
    resourceType: 'Encounter';
    status?: string;
    class?: { code?: string; display?: string };
    type?: Array<{ text?: string; coding?: Coding[] }>;
    period?: { start?: string; end?: string };
    reasonCode?: Array<{ text?: string }>;
  }

  interface Coding {
    system?: string;
    code?: string;
    display?: string;
  }

  interface Bundle<T extends Resource = Resource> extends Resource {
    resourceType: 'Bundle';
    type?: string;
    entry?: Array<{ resource?: T }>;
  }
}
