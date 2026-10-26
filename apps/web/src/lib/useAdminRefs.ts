import { computed } from 'vue';
import { api } from './api';
import { useAsync } from './useAsync';

export interface Department {
  id: string;
  code: string;
  name: string;
  timezone: string;
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
