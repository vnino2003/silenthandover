/**
 * RA 10173 (Data Privacy Act) data minimization before text leaves for an AI provider.
 *
 * Deterministic, rule-based and conservative. It is not named-entity recognition: names of
 * people who are not on the department roster are only caught when they follow an honorific
 * ("Mang Tony", "Sir Ramos"). The limits are documented in docs/capstone/05-pii-sanitization-matrix.md.
 */

export interface RosterEntry {
  full_name: string;
  pseudonym: string;
}

export type RedactionCategory = 'employee_name' | 'other_person' | 'email' | 'phone' | 'government_id' | 'medical';

export interface SanitizeResult {
  text: string;
  /** Token → original, for names only. Contact details, IDs and medical terms are not kept at all. */
  nameMapping: Record<string, string>;
  counts: Record<RedactionCategory, number>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Philippine mobile numbers (09xx / +63 9xx) and generic international numbers.
const PHONE = /(?:\+?63[\s-]?|\b0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;
// Formatted Philippine government identifiers.
const GOV_ID_FORMATTED = [
  /\b\d{2}-\d{7}-\d\b/g, // SSS
  /\b\d{2}-\d{9}-\d\b/g, // PhilHealth
  /\b\d{3}-\d{3}-\d{3}(?:-\d{3,5})?\b/g, // TIN
  /\b\d{4}-\d{4}-\d{4}\b/g, // Pag-IBIG MID
  /\b\d{4}-\d{7}-\d\b/g, // UMID CRN
];
const GOV_ID_KEYWORD =
  /\b(SSS|TIN|PhilHealth|UMID|CRN|Pag-?IBIG|HDMF|passport|driver'?s licen[cs]e|licen[cs]e)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})/gi;
const MEDICAL_TERMS = [
  'diagnosed with',
  'diagnosis',
  'diabetic',
  'diabetes',
  'hypertension',
  'hypertensive',
  'high blood',
  'asthma',
  'asthmatic',
  'pregnant',
  'pregnancy',
  'buntis',
  'epilepsy',
  'epileptic',
  'seizure',
  'migraine',
  'covid',
  'tested positive',
  'medication',
  'maintenance meds',
  'maintenance medicine',
  'chemotherapy',
  'therapy session',
  'hospitalized',
  'confined in',
  'medical certificate',
  'med cert',
  'sick leave',
  'mental health',
  'depression',
  'anxiety attack',
  'lagnat',
  'fever',
  'flu',
];
const MEDICAL = new RegExp(`\\b(${MEDICAL_TERMS.map(escapeRe).join('|')})\\b`, 'gi');
const HONORIFIC_NAME =
  /\b(Mr|Mrs|Ms|Miss|Sir|Ma'?am|Mang|Aling|Kuya|Ate|Manong|Manang|Engr|Dr|Atty)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;

export function emptyCounts(): Record<RedactionCategory, number> {
  return { employee_name: 0, other_person: 0, email: 0, phone: 0, government_id: 0, medical: 0 };
}

export function sanitize(input: string, roster: RosterEntry[]): SanitizeResult {
  const counts = emptyCounts();
  const nameMapping: Record<string, string> = {};
  let text = input;

  text = text.replace(EMAIL, () => {
    counts.email += 1;
    return '[EMAIL-REDACTED]';
  });
  text = text.replace(GOV_ID_KEYWORD, (_m, label: string) => {
    counts.government_id += 1;
    return `${label} [GOV-ID-REDACTED]`;
  });
  for (const re of GOV_ID_FORMATTED) {
    text = text.replace(re, () => {
      counts.government_id += 1;
      return '[GOV-ID-REDACTED]';
    });
  }
  text = text.replace(PHONE, () => {
    counts.phone += 1;
    return '[PHONE-REDACTED]';
  });
  text = text.replace(MEDICAL, () => {
    counts.medical += 1;
    return '[MEDICAL-REDACTED]';
  });

  // Roster names: full names first (case-insensitive), then distinctive single names
  // (case-sensitive, so "Mark the pallets" is left alone but "Mark said" is not).
  const entries = roster.filter((r) => r.full_name.trim().length >= 2);
  const tokenFor = (r: RosterEntry) => {
    const token = `[${r.pseudonym}]`;
    nameMapping[token] = r.full_name;
    return token;
  };
  for (const r of [...entries].sort((a, b) => b.full_name.length - a.full_name.length)) {
    const re = new RegExp(`\\b${escapeRe(r.full_name.trim()).replace(/\s+/g, '\\s+')}\\b`, 'gi');
    text = text.replace(re, () => {
      counts.employee_name += 1;
      return tokenFor(r);
    });
  }
  const partOwners = new Map<string, RosterEntry[]>();
  for (const r of entries) {
    for (const part of r.full_name.trim().split(/\s+/)) {
      if (part.length < 3) continue;
      const list = partOwners.get(part) ?? [];
      list.push(r);
      partOwners.set(part, list);
    }
  }
  for (const [part, owners] of partOwners) {
    const re = new RegExp(`\\b${escapeRe(part)}\\b`, 'g');
    text = text.replace(re, () => {
      counts.employee_name += 1;
      // Ambiguous single names (two "Mark"s) become a generic marker rather than a guess.
      return owners.length === 1 ? tokenFor(owners[0]!) : '[EMPLOYEE]';
    });
  }

  let personN = 0;
  const seen = new Map<string, string>();
  text = text.replace(HONORIFIC_NAME, (match: string) => {
    if (match.includes('[')) return match;
    counts.other_person += 1;
    const key = match.toLowerCase();
    let token = seen.get(key);
    if (!token) {
      personN += 1;
      token = `[PERSON-${personN}]`;
      seen.set(key, token);
      nameMapping[token] = match;
    }
    return token;
  });

  return { text, nameMapping, counts };
}

/** Replaces pseudonym tokens with names for authorized reviewers. Redacted contact/ID/medical data stays redacted. */
export function reidentify(text: string, mapping: Record<string, string>): string {
  return text.replace(/\[(EMP-[A-Z0-9]{6}|PERSON-\d+)\]/g, (token) => mapping[token] ?? token);
}

export function reidentifyDeep<T>(value: T, mapping: Record<string, string>): T {
  if (typeof value === 'string') return reidentify(value, mapping) as T;
  if (Array.isArray(value)) return value.map((v) => reidentifyDeep(v, mapping)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reidentifyDeep(v, mapping)])) as T;
  }
  return value;
}

/** True if text still contains contact details after sanitization (used on model output). */
export function containsContactDetails(text: string): boolean {
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  const found = EMAIL.test(text) || PHONE.test(text);
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  return found;
}
