import { computed } from 'vue';
import type { DepartmentExperience } from '@sh/shared';
import { api } from './api';
import { useAsync } from './useAsync';

export interface Department {
  id: string;
  code: string;
  name: string;
  timezone: string;
  experience: DepartmentExperience;
  teams: { id: string; name: string }[];
  member_count: number;
}
export interface AdminUser {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: 'employee' | 'manager' | 'admin';
  department_id: string | null;
  department_name: string | null;
  team_id: string | null;
  team_name: string | null;
  is_active: boolean;
  pseudonym: string;
  created_at: string;
  /** Shown on schedules, e.g. "Staff nurse". Optional and free text. */
  job_title?: string | null;
  /** ready: can sign in. invited: has not chosen a password yet. expired: the invitation stopped working. */
  sign_in: 'ready' | 'invited' | 'expired';
  /** The open invitation or reset link, if any. */
  invitation: { purpose: 'invite' | 'reset'; sent_at: string | null; expires_at: string; send_status: 'sent' | 'simulated' | 'failed' | null; send_error: string | null } | null;
}

/** What the server returns after sending an invitation or reset link. */
export interface InviteResult {
  purpose: 'invite' | 'reset';
  status: 'sent' | 'simulated' | 'failed';
  to: string;
  expires_at: string;
  error: string | null;
  /** Only when the email did not go out: the administrator passes it on another way. */
  link: string | null;
}

/** Departments and users, loaded once per admin page for selects and labels. */
export function useAdminRefs() {
  const departments = useAsync(() => api.get<Department[]>('/admin/departments'));
  const users = useAsync(() => api.get<AdminUser[]>('/admin/users'));
  const teamsFor = (deptId: string | null) => departments.data.value?.find((d) => d.id === deptId)?.teams ?? [];
  const managersFor = (deptId: string | null) => (users.data.value ?? []).filter((u) => u.role === 'manager' && u.is_active && u.department_id === deptId);
  const employeesFor = (deptId: string | null) => (users.data.value ?? []).filter((u) => u.role === 'employee' && u.is_active && u.department_id === deptId);
  return { departments, users, teamsFor, managersFor, employeesFor, ready: computed(() => Boolean(departments.data.value && users.data.value)) };
}
