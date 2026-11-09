import { z } from 'zod';
import { PROBLEM_CATEGORIES } from './report';
import { RECORD_TYPES } from './statuses';

/**
 * A hospital unit's own wording and guidance. Every hospital is organized differently, so the
 * administrator sets these per department (optionally starting from a unit template below).
 * Permissions never depend on them: they change what people read, not what they may do.
 */
export const DepartmentExperience = z.strictObject({
  organization_name: z.string().trim().max(100).default(''),
  industry: z.string().trim().max(80).default('Hospital unit'),
  staff_label: z.string().trim().min(2).max(40).default('Staff'),
  supervisor_label: z.string().trim().min(2).max(40).default('Department head'),
  report_label: z.string().trim().min(2).max(60).default('Shift endorsement'),
  issue_label: z.string().trim().min(2).max(40).default('Concern'),
  completed_hint: z.string().trim().max(400).default('Summarize rounds, checks, preparations and requests completed this shift. Use reference numbers where available.'),
  unresolved_hint: z.string().trim().max(400).default('Describe concerns that are not yet resolved: where, what you observed and what you already did.'),
  pending_hint: z.string().trim().max(400).default('List the tasks and follow-ups the incoming shift needs to take over, one per line.'),
  concerns_hint: z.string().trim().max(400).default('Note equipment, staffing, supplies, facilities, infection control or safety concerns. Escalate urgent matters through the hospital’s established process.'),
  privacy_hint: z.string().trim().max(400).default('Unit operations only. Do not enter patient names, hospital numbers, diagnoses or treatment details; those belong in the patient’s chart.'),
  categories: z.array(z.enum(PROBLEM_CATEGORIES)).min(1).max(PROBLEM_CATEGORIES.length).default(() => [...PROBLEM_CATEGORIES]),
  record_types: z.array(z.enum(RECORD_TYPES)).min(1).max(RECORD_TYPES.length).default(() => [...RECORD_TYPES]),
});
export type DepartmentExperience = z.infer<typeof DepartmentExperience>;
export const GENERIC_EXPERIENCE = DepartmentExperience.parse({});

const PRIVACY = 'Unit operations only. Do not enter patient names, hospital numbers, dates of birth, diagnoses or treatment details; those belong in the patient’s chart. Use approved reference numbers instead.';
const NURSING = { staff_label: 'Nursing staff', supervisor_label: 'Head Nurse', report_label: 'Shift endorsement', issue_label: 'Concern', privacy_hint: PRIVACY } as const;

/** The demonstration hospital's Nursery (fictional Starlight Community Hospital). */
export const NEWBORN_EXPERIENCE = DepartmentExperience.parse({
  ...NURSING,
  organization_name: 'Starlight Community Hospital', industry: 'Nursery',
  completed_hint: 'Summarize nursery readiness checks, bassinet and warmer preparation, supply checks, linen and requests completed this shift. Keep baby and mother details in the chart.',
  unresolved_hint: 'Describe equipment, supply, staffing or facilities concerns that still need attention. Include the area (e.g. preparation room) and the action already taken.',
  pending_hint: 'List follow-ups for the incoming shift, such as a pending biomedical inspection, a supply request or linen to put away.',
  concerns_hint: 'Note staffing, equipment readiness, infection-control supplies or facilities concerns. Escalate urgent concerns through the hospital’s established process.',
  privacy_hint: 'Unit operations only. Do not enter baby or mother names, hospital numbers, dates of birth, diagnoses or treatment details; those belong in the chart. Use approved reference numbers instead.',
  categories: ['equipment', 'staffing', 'supplies', 'facilities', 'infection_control', 'safety', 'process', 'other'],
  record_types: ['maintenance', 'operations', 'quality', 'staffing', 'policy'],
});

/**
 * Templates for common Philippine hospital units. Not every hospital has every unit, and names
 * differ between facilities: the administrator picks a template only as a starting point and can
 * change any field.
 */
export const HOSPITAL_UNIT_TEMPLATES: { name: string; experience: DepartmentExperience }[] = [
  { name: 'Nursery', experience: NEWBORN_EXPERIENCE },
  {
    name: 'OB-GYN Ward and Delivery Room',
    experience: DepartmentExperience.parse({
      ...NURSING, industry: 'OB-GYN Ward and Delivery Room', staff_label: 'Nursing and midwifery staff',
      completed_hint: 'Summarize delivery room and labor room readiness, instrument and supply checks, linen and requests completed this shift. Keep mother and baby details in the chart.',
      pending_hint: 'List follow-ups for the incoming shift, such as instruments for sterilization, supply requests or equipment for inspection.',
      categories: ['equipment', 'staffing', 'supplies', 'facilities', 'infection_control', 'safety', 'process', 'other'],
      record_types: ['maintenance', 'inventory', 'operations', 'quality', 'staffing', 'policy'],
    }),
  },
  {
    name: 'Emergency Room',
    experience: DepartmentExperience.parse({
      ...NURSING, industry: 'Emergency Room',
      completed_hint: 'Summarize crash cart and equipment checks, supply restocking, transfers coordinated and requests completed this shift. Keep patient details in the chart.',
      pending_hint: 'List follow-ups for the incoming shift, such as pending equipment repair, restocking or transport arrangements.',
      categories: ['equipment', 'staffing', 'supplies', 'stock', 'delivery', 'facilities', 'infection_control', 'safety', 'process', 'other'],
    }),
  },
  ...(['Medical Ward', 'Surgical Ward', 'Pediatric Ward'] as const).map((name) => ({
    name,
    experience: DepartmentExperience.parse({
      ...NURSING, industry: name,
      completed_hint: 'Summarize ward rounds support, equipment and supply checks, linen and requests completed this shift. Keep patient details in the chart.',
      categories: ['equipment', 'staffing', 'supplies', 'facilities', 'infection_control', 'safety', 'process', 'other'],
    }),
  })),
  {
    name: 'Operating Room',
    experience: DepartmentExperience.parse({
      ...NURSING, industry: 'Operating Room', staff_label: 'OR staff',
      completed_hint: 'Summarize room turnover, instrument and sterile supply checks, anesthesia machine checks and requests completed this shift. Keep patient details in the chart.',
      pending_hint: 'List follow-ups for the incoming shift, such as instruments for sterilization, equipment for inspection or supplies to replenish.',
      categories: ['equipment', 'staffing', 'supplies', 'stock', 'facilities', 'infection_control', 'safety', 'process', 'other'],
    }),
  },
  {
    name: 'Laboratory',
    experience: DepartmentExperience.parse({
      industry: 'Laboratory', staff_label: 'Medical Technologist', supervisor_label: 'Chief Medical Technologist', report_label: 'Shift endorsement', issue_label: 'Concern', privacy_hint: PRIVACY,
      completed_hint: 'Summarize analyzer quality control, calibration, reagent checks and requests completed this shift. Do not enter patient names or results.',
      unresolved_hint: 'Describe analyzer, reagent, supply or facilities concerns still open, and the action already taken.',
      pending_hint: 'List follow-ups for the incoming shift, such as pending QC runs, reagent requests or analyzer service.',
      concerns_hint: 'Note equipment, reagent and supply levels, staffing, biosafety or facilities concerns.',
      categories: ['equipment', 'stock', 'supplies', 'staffing', 'facilities', 'infection_control', 'safety', 'process', 'other'],
      record_types: ['maintenance', 'inventory', 'quality', 'staffing', 'policy'],
    }),
  },
  {
    name: 'Radiology',
    experience: DepartmentExperience.parse({
      industry: 'Radiology', staff_label: 'Radiologic Technologist', supervisor_label: 'Chief Radiologic Technologist', report_label: 'Shift endorsement', issue_label: 'Concern', privacy_hint: PRIVACY,
      completed_hint: 'Summarize X-ray and ultrasound equipment checks, film or detector checks, radiation safety checks and requests completed this shift. Do not enter patient names or findings.',
      unresolved_hint: 'Describe equipment, supply, radiation safety or facilities concerns still open, and the action already taken.',
      pending_hint: 'List follow-ups for the incoming shift, such as equipment service, supply requests or pending checks.',
      concerns_hint: 'Note equipment, radiation safety, staffing, supplies or facilities concerns.',
      categories: ['equipment', 'supplies', 'staffing', 'facilities', 'safety', 'process', 'other'],
      record_types: ['maintenance', 'quality', 'staffing', 'policy'],
    }),
  },
  {
    name: 'Pharmacy',
    experience: DepartmentExperience.parse({
      industry: 'Pharmacy', staff_label: 'Pharmacist', supervisor_label: 'Chief Pharmacist', report_label: 'Shift endorsement', issue_label: 'Concern', privacy_hint: PRIVACY,
      completed_hint: 'Summarize stock checks, deliveries received, refrigerator temperature checks and requests completed this shift. Do not enter patient names or prescriptions.',
      unresolved_hint: 'Describe stock-outs, near-expiry items, equipment or facilities concerns still open, and the action already taken.',
      pending_hint: 'List follow-ups for the incoming shift, such as pending purchase requests, items to return or stock to put away.',
      concerns_hint: 'Note stock levels, cold-chain, staffing, security or facilities concerns.',
      categories: ['stock', 'supplies', 'equipment', 'staffing', 'facilities', 'safety', 'process', 'other'],
      record_types: ['inventory', 'maintenance', 'quality', 'staffing', 'policy'],
    }),
  },
];

/** A position title inside a sentence: "Head Nurse" stays as written; "Department head" reads "department head". */
function inSentence(label: string): string {
  const words = label.trim().split(/\s+/);
  return words.length > 1 && /^[A-Z]/.test(words[1] ?? '') ? label.trim() : label.trim().toLowerCase();
}
function pluralOf(label: string): string {
  return /(s|staff|personnel)$/i.test(label.trim()) ? label.trim() : `${label.trim()}s`;
}
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/**
 * The department's own words, ready for page text: titles (Head Nurse), in-sentence forms
 * (shift endorsement, concern) and plurals. Pages use these instead of fixed words.
 */
export function departmentTerms(e: DepartmentExperience) {
  const issueLower = e.issue_label.trim().toLowerCase();
  const reportLower = e.report_label.trim().toLowerCase();
  const staffLower = e.staff_label.trim().toLowerCase();
  const staffOne = /(staff|personnel)$/.test(staffLower) ? (staffLower === 'staff' ? 'staff member' : `${staffLower} member`) : inSentence(e.staff_label);
  return {
    issue: e.issue_label,
    issues: pluralOf(e.issue_label),
    issueLower,
    issuesLower: pluralOf(issueLower),
    aIssue: `${article(issueLower)} ${issueLower}`,
    report: e.report_label,
    reports: pluralOf(e.report_label),
    reportLower,
    reportsLower: pluralOf(reportLower),
    aReport: `${article(reportLower)} ${reportLower}`,
    staff: e.staff_label,
    staffPlural: pluralOf(e.staff_label),
    /** One person, in a sentence: "staff member", "medical technologist". */
    staffOne,
    supervisor: e.supervisor_label,
    /** The department head's title in a sentence: "Head Nurse", "department head". */
    head: inSentence(e.supervisor_label),
  };
}
export type DepartmentTerms = ReturnType<typeof departmentTerms>;
