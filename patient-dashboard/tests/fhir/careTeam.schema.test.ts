import { describe, expect, it } from 'vitest';

import { parseCareTeam } from '../../src/fhir/schemas/careTeam';

const TWO_PARTICIPANT_CARE_TEAM = {
  resourceType: 'CareTeam',
  id: 'ct1',
  status: 'active',
  participant: [
    {
      id: 'p1',
      role: [
        {
          coding: [
            {
              system:
                'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
              code: 'PCP',
              display: 'Primary Care Provider',
            },
          ],
        },
      ],
      member: {
        reference: 'Practitioner/dr-smith-uuid',
        display: 'Dr Anita Smith',
      },
    },
    {
      id: 'p2',
      role: [{ text: 'Cardiologist' }],
      member: {
        reference: 'Practitioner/dr-jones-uuid',
        display: 'Dr Marcus Jones',
      },
    },
  ],
};

describe('parseCareTeam', () => {
  it('projects each participant into a CareTeamParticipantDTO row', () => {
    const dtos = parseCareTeam(TWO_PARTICIPANT_CARE_TEAM);
    expect(dtos).toEqual([
      {
        careTeamId: 'ct1',
        participantId: 'ct1:p1',
        status: 'active',
        name: 'Dr Anita Smith',
        role: 'Primary Care Provider',
      },
      {
        careTeamId: 'ct1',
        participantId: 'ct1:p2',
        status: 'active',
        name: 'Dr Marcus Jones',
        role: 'Cardiologist',
      },
    ]);
  });

  it('returns an empty array when participant is omitted', () => {
    const { participant, ...rest } = TWO_PARTICIPANT_CARE_TEAM;
    void participant;
    expect(parseCareTeam(rest)).toEqual([]);
  });

  it('returns an empty array when participant is an empty array', () => {
    expect(
      parseCareTeam({ ...TWO_PARTICIPANT_CARE_TEAM, participant: [] }),
    ).toEqual([]);
  });

  it('falls back to member.reference when member.display is missing', () => {
    const dtos = parseCareTeam({
      ...TWO_PARTICIPANT_CARE_TEAM,
      participant: [
        {
          id: 'p1',
          role: [{ text: 'Nurse' }],
          member: { reference: 'Practitioner/abc-123' },
        },
      ],
    });
    expect(dtos[0]?.name).toBe('Practitioner/abc-123');
  });

  it('uses "(unnamed participant)" when member is entirely missing', () => {
    const dtos = parseCareTeam({
      ...TWO_PARTICIPANT_CARE_TEAM,
      participant: [{ role: [{ text: 'Nurse' }] }],
    });
    expect(dtos[0]?.name).toBe('(unnamed participant)');
  });

  it('uses "(role unspecified)" when role is missing', () => {
    const dtos = parseCareTeam({
      ...TWO_PARTICIPANT_CARE_TEAM,
      participant: [
        {
          id: 'p1',
          member: { display: 'Dr X' },
        },
      ],
    });
    expect(dtos[0]?.role).toBe('(role unspecified)');
  });

  it('uses "(role unspecified)" when role is an empty array', () => {
    const dtos = parseCareTeam({
      ...TWO_PARTICIPANT_CARE_TEAM,
      participant: [
        {
          id: 'p1',
          role: [],
          member: { display: 'Dr X' },
        },
      ],
    });
    expect(dtos[0]?.role).toBe('(role unspecified)');
  });

  it('falls back to role[0].text when no coding[].display is present', () => {
    const dtos = parseCareTeam({
      ...TWO_PARTICIPANT_CARE_TEAM,
      participant: [
        {
          id: 'p1',
          role: [
            {
              coding: [{ system: 'http://x', code: 'y' /* no display */ }],
              text: 'Fallback Role',
            },
          ],
          member: { display: 'Dr X' },
        },
      ],
    });
    expect(dtos[0]?.role).toBe('Fallback Role');
  });

  it('synthesizes participantId from index when participant.id is absent', () => {
    const dtos = parseCareTeam({
      ...TWO_PARTICIPANT_CARE_TEAM,
      participant: [
        { role: [{ text: 'A' }], member: { display: 'Dr A' } },
        { role: [{ text: 'B' }], member: { display: 'Dr B' } },
      ],
    });
    expect(dtos.map((d) => d.participantId)).toEqual(['ct1:0', 'ct1:1']);
  });

  it('returns null status when omitted', () => {
    const { status, ...rest } = TWO_PARTICIPANT_CARE_TEAM;
    void status;
    const dtos = parseCareTeam(rest);
    expect(dtos[0]?.status).toBeNull();
  });

  it('tolerates inactive / entered-in-error statuses (filtering is in the hook)', () => {
    for (const s of ['inactive', 'entered-in-error', 'suspended']) {
      const dtos = parseCareTeam({
        ...TWO_PARTICIPANT_CARE_TEAM,
        status: s,
      });
      expect(dtos.every((d) => d.status === s)).toBe(true);
    }
  });

  it('throws on the wrong resourceType', () => {
    expect(() =>
      parseCareTeam({ ...TWO_PARTICIPANT_CARE_TEAM, resourceType: 'Patient' }),
    ).toThrow();
  });

  it('throws when id is missing', () => {
    const { id, ...rest } = TWO_PARTICIPANT_CARE_TEAM;
    void id;
    expect(() => parseCareTeam(rest)).toThrow();
  });
});
