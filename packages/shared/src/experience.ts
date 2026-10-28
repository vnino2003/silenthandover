import { z } from 'zod';
import { PROBLEM_CATEGORIES } from './report';
import { RECORD_TYPES } from './statuses';

export const DepartmentExperience = z.strictObject({
  organization_name: z.string().trim().max(100).default(''),
  industry: z.string().trim().max(80).default('General operations'),
  staff_label: z.string().trim().min(2).max(40).default('Team member'),
  supervisor_label: z.string().trim().min(2).max(40).default('Supervisor'),
  report_label: z.string().trim().min(2).max(60).default('Shift report'),
  issue_label: z.string().trim().min(2).max(40).default('Issue'),
  completed_hint: z.string().trim().max(400).default('Describe completed activities, checks, services or other work. Use recorded references where relevant.'),
  unresolved_hint: z.string().trim().max(400).default('Record unresolved problems, where they occurred and what action was taken.'),
  pending_hint: z.string().trim().max(400).default('List follow-ups and unfinished activities for the next team, one per line.'),
  concerns_hint: z.string().trim().max(400).default('Note equipment, staffing, facilities or safety concerns that need attention.'),
  privacy_hint: z.string().trim().max(400).default('Keep this work-related. Avoid personal or confidential information; use approved record references.'),
  categories: z.array(z.enum(PROBLEM_CATEGORIES)).min(1).max(PROBLEM_CATEGORIES.length).default(() => [...PROBLEM_CATEGORIES]),
  record_types: z.array(z.enum(RECORD_TYPES)).min(1).max(RECORD_TYPES.length).default(() => [...RECORD_TYPES]),
});
export type DepartmentExperience = z.infer<typeof DepartmentExperience>;
export const GENERIC_EXPERIENCE = DepartmentExperience.parse({});
export const NEWBORN_EXPERIENCE = DepartmentExperience.parse({
  organization_name: 'Starlight Community Hospital', industry: 'Newborn care operations',
  staff_label: 'Team member', supervisor_label: 'Supervisor', report_label: 'Handover report', issue_label: 'Concern',
  completed_hint: 'Summarize unit readiness checks, room preparation, supply checks, family-support coordination and completed service requests. Keep patient details in the approved clinical record.',
  unresolved_hint: 'Describe equipment, staffing, facilities or supply concerns that still need attention. Include the unit area and the action already taken.',
  pending_hint: 'List operational follow-ups for the incoming care team, such as a pending equipment inspection or replenishment request.',
  concerns_hint: 'Note staffing cover, equipment readiness, infection-prevention supplies or facilities concerns. Escalate urgent concerns through the hospital’s established process.',
  privacy_hint: 'Operational handover only. Do not enter baby or parent names, dates of birth, diagnoses, treatment details or patient identifiers. Use approved non-identifying service references.',
  categories: ['equipment', 'staffing', 'supplies', 'facilities', 'safety', 'process', 'other'],
  record_types: ['maintenance', 'operations', 'quality', 'staffing', 'policy'],
});
