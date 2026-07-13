import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { IdentityStrip, computeAgeYears } from '../../src/components/IdentityStrip';
import type { PatientDTO } from '../../src/fhir/schemas/patient';

const margaret: PatientDTO = {
  id: 'margaret-uuid',
  name: 'Margaret L. Chen',
  given: 'Margaret L.',
  family: 'Chen',
  birthDate: '1962-03-14',
  gender: 'female',
  mrn: '00012847',
  active: true,
};

describe('IdentityStrip', () => {
  it('renders name, DOB+age, sex, MRN, and the Active pill', () => {
    render(<IdentityStrip patient={margaret} now={new Date(2026, 4, 8)} />);

    const strip = screen.getByTestId('identity-strip');
    expect(within(strip).getByText('Margaret L. Chen')).toBeInTheDocument();
    expect(within(strip).getByText('1962-03-14')).toBeInTheDocument();
    expect(within(strip).getByText('(64y)')).toBeInTheDocument();
    expect(within(strip).getByText('Female')).toBeInTheDocument();
    expect(within(strip).getByText('00012847')).toBeInTheDocument();
    expect(within(strip).getByText('Active')).toBeInTheDocument();
  });

  it('omits the Active pill when patient.active is false', () => {
    render(
      <IdentityStrip
        patient={{ ...margaret, active: false }}
        now={new Date(2026, 4, 8)}
      />,
    );
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('renders Unknown sex when gender is null', () => {
    render(
      <IdentityStrip
        patient={{ ...margaret, gender: null }}
        now={new Date(2026, 4, 8)}
      />,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('renders DOB placeholder when birthDate is null', () => {
    render(
      <IdentityStrip
        patient={{ ...margaret, birthDate: null }}
        now={new Date(2026, 4, 8)}
      />,
    );
    const strip = screen.getByTestId('identity-strip');
    expect(within(strip).getByText('—')).toBeInTheDocument();
    expect(within(strip).queryByText(/y\)/)).not.toBeInTheDocument();
  });
});

describe('computeAgeYears', () => {
  // Use local-time date constructors — `new Date('2026-03-14')` parses as
  // UTC midnight and shifts a day backwards in negative-offset timezones.
  it('returns completed years when the birthday has passed this year', () => {
    expect(computeAgeYears('1962-03-14', new Date(2026, 4, 8))).toBe(64);
  });

  it('returns one fewer year when the birthday is later this year', () => {
    expect(computeAgeYears('1962-03-14', new Date(2026, 0, 15))).toBe(63);
  });

  it('returns same age on the birthday itself', () => {
    expect(computeAgeYears('1962-03-14', new Date(2026, 2, 14))).toBe(64);
  });
});
