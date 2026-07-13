/**
 * PhiSet — readonly value object holding the per-request PHI strings that
 * must be redacted before any payload leaves the process. Built once at
 * request entry from the FHIR Patient resource (or as `empty()` for
 * non-PHI requests like guideline-only chats).
 *
 * Why a Set per category instead of a flat string list:
 *   - Stable membership checks (O(1)) when the redactor walks payloads.
 *   - Per-category typed redaction tokens carry the *kind* of leak that
 *     would have happened, which makes after-the-fact audit possible.
 *
 * Multi-form name expansion: a Patient resource carrying `given=['Maria']`
 * and `family='González'` produces the variants:
 *   - "Maria González"      (given + family)
 *   - "González, Maria"     (family, given — chart-style)
 *   - "Maria"               (given alone)
 *   - "González"            (family alone)
 *   - lowercase variants of all of the above
 * This catches the common LLM rephrasings ("the patient González…",
 * "Maria reports…", "González, Maria — DOB 1968…") without needing the
 * regex fallbacks to fire.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

export interface PhiSetData {
  readonly names: ReadonlySet<string>;
  readonly dobs: ReadonlySet<string>;
  readonly pubpids: ReadonlySet<string>;
  readonly addresses: ReadonlySet<string>;
  readonly phones: ReadonlySet<string>;
  readonly emails: ReadonlySet<string>;
}

export class PhiSet implements PhiSetData {
  public readonly names: ReadonlySet<string>;
  public readonly dobs: ReadonlySet<string>;
  public readonly pubpids: ReadonlySet<string>;
  public readonly addresses: ReadonlySet<string>;
  public readonly phones: ReadonlySet<string>;
  public readonly emails: ReadonlySet<string>;

  private constructor(data: PhiSetData) {
    this.names = data.names;
    this.dobs = data.dobs;
    this.pubpids = data.pubpids;
    this.addresses = data.addresses;
    this.phones = data.phones;
    this.emails = data.emails;
  }

  static empty(): PhiSet {
    return new PhiSet({
      names: new Set(),
      dobs: new Set(),
      pubpids: new Set(),
      addresses: new Set(),
      phones: new Set(),
      emails: new Set(),
    });
  }

  /**
   * Build a PhiSet from a FHIR R4 Patient resource. Values are
   * normalized (trim + lowercase variants added) so the redactor catches
   * "González" and "gonzález" alike.
   */
  static fromPatientResource(
    patient: fhir4.Patient,
    options: { readonly pubpid?: string | null } = {},
  ): PhiSet {
    const names = new Set<string>();
    for (const human of patient.name ?? []) {
      addNameVariants(names, human);
    }

    const dobs = new Set<string>();
    if (typeof patient.birthDate === 'string' && patient.birthDate.length > 0) {
      addCaseVariants(dobs, patient.birthDate);
      // Common chart formats: 04/15/1968, 4/15/1968, 1968-04-15, 19680415
      const iso = patient.birthDate;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      if (m && m[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
        const [, y, mo, d] = m;
        dobs.add(`${mo}/${d}/${y}`);
        dobs.add(`${Number(mo)}/${Number(d)}/${y}`);
        dobs.add(`${y}${mo}${d}`);
      }
    }

    const pubpids = new Set<string>();
    if (options.pubpid !== undefined && options.pubpid !== null && options.pubpid !== '') {
      addCaseVariants(pubpids, options.pubpid);
    }
    for (const ident of patient.identifier ?? []) {
      if (typeof ident.value === 'string' && ident.value.length > 0) {
        addCaseVariants(pubpids, ident.value);
      }
    }

    const addresses = new Set<string>();
    for (const addr of patient.address ?? []) {
      for (const line of addr.line ?? []) {
        if (typeof line === 'string' && line.length > 0) addCaseVariants(addresses, line);
      }
      if (typeof addr.city === 'string' && addr.city.length > 0) addCaseVariants(addresses, addr.city);
      if (typeof addr.state === 'string' && addr.state.length > 0) addCaseVariants(addresses, addr.state);
      if (typeof addr.postalCode === 'string' && addr.postalCode.length > 0) {
        addCaseVariants(addresses, addr.postalCode);
      }
    }

    const phones = new Set<string>();
    const emails = new Set<string>();
    for (const tel of patient.telecom ?? []) {
      if (typeof tel.value !== 'string' || tel.value.length === 0) continue;
      if (tel.system === 'phone' || tel.system === 'sms' || tel.system === 'fax') {
        addCaseVariants(phones, tel.value);
        // Normalized digit-only form (lets the redactor catch
        // (512) 555-1234 ↔ 5125551234).
        const digits = tel.value.replace(/\D/g, '');
        if (digits.length >= 7) phones.add(digits);
      } else if (tel.system === 'email') {
        addCaseVariants(emails, tel.value);
      }
    }

    return new PhiSet({ names, dobs, pubpids, addresses, phones, emails });
  }

  /** Useful for tests + the integration suite. */
  static fromExplicit(data: {
    readonly names?: Iterable<string>;
    readonly dobs?: Iterable<string>;
    readonly pubpids?: Iterable<string>;
    readonly addresses?: Iterable<string>;
    readonly phones?: Iterable<string>;
    readonly emails?: Iterable<string>;
  }): PhiSet {
    return new PhiSet({
      names: new Set(data.names ?? []),
      dobs: new Set(data.dobs ?? []),
      pubpids: new Set(data.pubpids ?? []),
      addresses: new Set(data.addresses ?? []),
      phones: new Set(data.phones ?? []),
      emails: new Set(data.emails ?? []),
    });
  }

  /** Shallow merge — useful when augmenting a base set with explicit values. */
  withAdditional(extra: {
    readonly names?: Iterable<string>;
    readonly dobs?: Iterable<string>;
    readonly pubpids?: Iterable<string>;
    readonly addresses?: Iterable<string>;
    readonly phones?: Iterable<string>;
    readonly emails?: Iterable<string>;
  }): PhiSet {
    return new PhiSet({
      names: union(this.names, extra.names),
      dobs: union(this.dobs, extra.dobs),
      pubpids: union(this.pubpids, extra.pubpids),
      addresses: union(this.addresses, extra.addresses),
      phones: union(this.phones, extra.phones),
      emails: union(this.emails, extra.emails),
    });
  }
}

function addCaseVariants(target: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  target.add(trimmed);
  const lower = trimmed.toLowerCase();
  if (lower !== trimmed) target.add(lower);
}

function addNameVariants(target: Set<string>, human: fhir4.HumanName): void {
  const family = typeof human.family === 'string' ? human.family.trim() : '';
  const given = (human.given ?? []).map(g => (typeof g === 'string' ? g.trim() : '')).filter(g => g.length > 0);
  const text = typeof human.text === 'string' ? human.text.trim() : '';

  if (text.length > 0) addCaseVariants(target, text);
  if (family.length > 0) addCaseVariants(target, family);
  for (const g of given) {
    addCaseVariants(target, g);
  }
  if (given.length > 0 && family.length > 0) {
    addCaseVariants(target, `${given.join(' ')} ${family}`);
    addCaseVariants(target, `${family}, ${given.join(' ')}`);
    if (given[0] !== undefined) {
      addCaseVariants(target, `${given[0]} ${family}`);
      addCaseVariants(target, `${family}, ${given[0]}`);
    }
  }
}

function union(base: ReadonlySet<string>, extra: Iterable<string> | undefined): Set<string> {
  const out = new Set(base);
  if (extra) {
    for (const v of extra) out.add(v);
  }
  return out;
}
