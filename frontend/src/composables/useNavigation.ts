import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth } from '@/stores/auth';

/**
 * The app's navigation, defined once and used everywhere: the side menu on wide screens, the
 * slide-out drawer and the bottom bar on phones, and the full "More" page (/menu). Web and Android
 * show the same pages for the same person; only the layout differs by screen size.
 * Every page is still protected by the router guard, the API and the database.
 */
export type NavItem = { to: string; label: string; exact?: boolean; group?: string; count?: 'review' | 'leave' };

const NAV = {
  employee: [
    { to: '/', label: 'Today', exact: true },
    { to: '/attendance', label: 'Attendance' },
    { to: '/schedule', label: 'My schedule' },
    { to: '/leave', label: 'Leave' },
    { to: '/assistant', label: 'Mica assistant' },
    { to: '/handover', label: 'Incoming endorsement' },
    { to: '/tasks', label: 'Open concerns' },
    { to: '/reports', label: 'My endorsements' },
    { to: '/my-dtr', label: 'My DTR' },
    { to: '/payslips', label: 'Payslips' },
  ],
  // Department heads have the most screens: daily duties first, records after.
  manager: [
    { to: '/manager/shifts', label: 'Today', group: 'Daily duties' },
    { to: '/manager/attendance', label: 'Attendance', group: 'Daily duties' },
    { to: '/manager', label: 'For approval', exact: true, group: 'Daily duties', count: 'review' },
    { to: '/manager/schedule', label: 'Duty schedule', group: 'Daily duties' },
    { to: '/manager/team', label: 'Unit staff', group: 'Daily duties' },
    { to: '/manager/leave', label: 'Leave requests', group: 'Daily duties', count: 'leave' },
    { to: '/manager/issues', label: 'Concerns', group: 'Daily duties' },
    { to: '/manager/reports', label: 'Endorsement history', exact: true, group: 'Records' },
    { to: '/manager/records', label: 'Unit records', group: 'Records' },
    { to: '/manager/dtr', label: 'DTR certification', group: 'Records' },
    { to: '/manager/audit', label: 'Audit log', group: 'Records' },
    { to: '/leave', label: 'My leave', group: 'Records' },
    { to: '/my-dtr', label: 'My DTR', group: 'Records' },
    { to: '/payslips', label: 'My payslips', group: 'Records' },
  ],
  // System administration: accounts and the hospital's units first, then the system settings.
  admin: [
    { to: '/admin/users', label: 'User accounts', group: 'Organization' },
    { to: '/admin/departments', label: 'Departments and units', group: 'Organization' },
    { to: '/admin', label: 'Integrations', exact: true, group: 'System' },
    { to: '/admin/ai-pipeline', label: 'Mica AI pipeline', group: 'System' },
    { to: '/admin/settings', label: 'System rules', group: 'System' },
    { to: '/admin/audit', label: 'Audit log', group: 'Records' },
  ],
} as const satisfies Record<string, readonly NavItem[]>;

export function useNavigation() {
  const auth = useAuth();
  const route = useRoute();

  // HR, payroll and finance are duties on top of a role, so their workspaces are added per person.
  const workforceNav = computed<NavItem[]>(() => (auth.role === 'admin' ? [] : [
    ...(auth.can('timekeeper', 'hr_admin') ? [{ to: '/hr', label: 'HR timekeeping', group: 'Workforce' }] : []),
    ...(auth.can('payroll_preparer', 'finance_approver', 'hr_admin')
      ? [{ to: '/payroll', label: auth.can('finance_approver') && !auth.can('payroll_preparer', 'hr_admin') ? 'Payroll approval' : 'Payroll', group: 'Workforce' }]
      : []),
  ]));

  // Concerns and endorsements follow the department's own words.
  const nav = computed<readonly NavItem[]>(() => [...(auth.role ? NAV[auth.role] : []), ...workforceNav.value].map((item) => ({
    ...item,
    label: item.to === '/reports' ? `My ${auth.terms.reports.toLowerCase()}` : item.to === '/tasks' ? `Open ${auth.terms.issues.toLowerCase()}` : item.to === '/manager/issues' ? auth.terms.issues : item.label,
  })));

  /** The menu in its sections (a single unnamed section for roles without groups). */
  const navGroups = computed(() => {
    const groups: { name: string | null; items: NavItem[] }[] = [];
    for (const item of nav.value) {
      const name = item.group ?? null;
      const last = groups.at(-1);
      if (last && last.name === name) last.items.push(item);
      else groups.push({ name, items: [item] });
    }
    return groups;
  });

  /**
   * Phone bottom bar: the four most-used pages and "More", which opens every page of the menu
   * (/menu). Nothing is reachable only from the wide-screen menu.
   */
  const mobileNav = computed<readonly { to: string; label: string; exact?: boolean }[]>(() => [
    // HR, payroll and finance staff get their workspace in the bar in place of the ward pages (still in More).
    ...(auth.role === 'employee'
      ? [{ to: '/', label: 'Today', exact: true }, { to: '/attendance', label: 'Attendance' }, ...(workforceNav.value.length
        ? workforceNav.value.map((w) => ({ to: w.to, label: w.to === '/hr' ? 'Timekeeping' : w.label === 'Payroll approval' ? 'Approval' : 'Payroll' })).concat(workforceNav.value.length === 1 ? [{ to: '/leave', label: 'Leave' }] : [])
        : [{ to: '/handover', label: 'Incoming' }, { to: '/reports', label: 'Endorsements' }])]
      : auth.role === 'manager'
        ? [{ to: '/manager/shifts', label: 'Today' }, { to: '/manager', label: 'Approval', exact: true }, { to: '/manager/attendance', label: 'Attendance' }, { to: '/manager/schedule', label: 'Schedule' }]
        : auth.role === 'admin'
          ? [{ to: '/admin/users', label: 'Accounts' }, { to: '/admin', label: 'System', exact: true }, { to: '/admin/ai-pipeline', label: 'Mica AI' }, { to: '/admin/settings', label: 'Rules' }]
          : []),
    // Nobody signed in (or no role yet): no pages at all, never the administrator's.
    ...(auth.role ? [{ to: '/menu', label: 'More' }] : []),
  ]);

  const isActive = (item: { to: string; exact?: boolean }) => {
    // An endorsement under review belongs to the approval list.
    if (item.to === '/manager' && route.path.startsWith('/manager/reports/')) return true;
    return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`);
  };

  return { nav, navGroups, mobileNav, isActive };
}
