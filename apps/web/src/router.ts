import { createRouter, createWebHistory } from '@ionic/vue-router';
import type { RouteRecordRaw } from 'vue-router';
import type { Role, AssistantPageContext } from '@sh/shared';
import { useAuth } from '@/stores/auth';
import AppShell from '@/components/AppShell.vue';

declare module 'vue-router' {
  interface RouteMeta {
    roles?: Role[];
    public?: boolean;
    title?: string;
    assistantPage?: AssistantPageContext;
  }
}

const employee: Role[] = ['employee'];
const manager: Role[] = ['manager'];
const admin: Role[] = ['admin'];
const staff: Role[] = ['employee', 'manager'];

const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true, title: 'Sign in' } },
  // The link in an invitation or password reset email (the token is in the #fragment).
  { path: '/set-password', component: () => import('@/pages/SetPasswordPage.vue'), meta: { public: true, title: 'Choose your password' } },
  { path: '/forgot-password', component: () => import('@/pages/ForgotPasswordPage.vue'), meta: { public: true, title: 'Forgot password' } },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', component: () => import('@/pages/employee/DashboardPage.vue'), meta: { assistantPage: 'today', roles: employee, title: 'Today' } },
      { path: 'reports', component: () => import('@/pages/employee/MyReportsPage.vue'), meta: { assistantPage: 'reports', roles: employee, title: 'My endorsements' } },
      { path: 'assistant', component: () => import('@/pages/employee/AssistantPage.vue'), meta: { assistantPage: 'assistant', title: 'Mica assistant' } },
      { path: 'reports/:id', component: () => import('@/pages/employee/ReportPage.vue'), meta: { assistantPage: 'report', roles: employee, title: 'Shift endorsement' } },
      { path: 'shifts/:shiftId/report', component: () => import('@/pages/employee/OpenReportPage.vue'), meta: { assistantPage: 'report', roles: employee } },
      { path: 'handover', component: () => import('@/pages/employee/IncomingPage.vue'), meta: { assistantPage: 'handover', roles: employee, title: 'Incoming endorsement' } },
      { path: 'schedule', component: () => import('@/pages/employee/MySchedulePage.vue'), meta: { assistantPage: 'my_schedule', roles: employee, title: 'My schedule' } },
      { path: 'leave', component: () => import('@/pages/employee/LeavePage.vue'), meta: { assistantPage: 'leave', roles: staff, title: 'Leave' } },
      { path: 'tasks', component: () => import('@/pages/shared/IssuesPage.vue'), meta: { assistantPage: 'issues', roles: staff, title: 'Open concerns' } },
      { path: 'tasks/:id', component: () => import('@/pages/shared/IssueDetailPage.vue'), meta: { assistantPage: 'issue', roles: staff, title: 'Concern' } },
      { path: 'notifications', component: () => import('@/pages/shared/NotificationsPage.vue'), meta: { assistantPage: 'notifications', title: 'Notifications' } },
      { path: 'profile', component: () => import('@/pages/shared/ProfilePage.vue'), meta: { assistantPage: 'profile', title: 'Profile' } },

      { path: 'manager', component: () => import('@/pages/manager/QueuePage.vue'), meta: { assistantPage: 'review', roles: manager, title: 'For approval' } },
      { path: 'manager/reports', component: () => import('@/pages/manager/HistoryPage.vue'), meta: { assistantPage: 'reports', roles: manager, title: 'Endorsement history' } },
      { path: 'manager/reports/:id', component: () => import('@/pages/manager/ReviewPage.vue'), meta: { assistantPage: 'review', roles: manager, title: 'Endorsement review' } },
      { path: 'manager/shifts', component: () => import('@/pages/manager/ShiftBoardPage.vue'), meta: { assistantPage: 'today', roles: manager, title: 'Today' } },
      { path: 'manager/schedule', component: () => import('@/pages/manager/SchedulePage.vue'), meta: { assistantPage: 'schedule', roles: manager, title: 'Duty schedule' } },
      { path: 'manager/team', component: () => import('@/pages/manager/TeamPage.vue'), meta: { assistantPage: 'today', roles: manager, title: 'Unit staff' } },
      { path: 'manager/leave', component: () => import('@/pages/manager/LeaveRequestsPage.vue'), meta: { assistantPage: 'leave_requests', roles: manager, title: 'Leave requests' } },
      { path: 'manager/issues', component: () => import('@/pages/shared/IssuesPage.vue'), meta: { assistantPage: 'issues', roles: manager, title: 'Concerns' } },
      { path: 'manager/issues/:id', component: () => import('@/pages/shared/IssueDetailPage.vue'), meta: { assistantPage: 'issue', roles: manager, title: 'Concern' } },
      { path: 'manager/records', component: () => import('@/pages/manager/RecordsPage.vue'), meta: { assistantPage: 'records', roles: manager, title: 'Unit records' } },
      { path: 'manager/audit', component: () => import('@/pages/shared/AuditPage.vue'), meta: { assistantPage: 'audit', roles: manager, title: 'Audit log' } },

      { path: 'admin', component: () => import('@/pages/admin/IntegrationsPage.vue'), meta: { assistantPage: 'integrations', roles: admin, title: 'Integrations' } },
      { path: 'admin/ai-pipeline', component: () => import('@/pages/admin/AiPipelinePage.vue'), meta: { assistantPage: 'pipeline', roles: admin, title: 'Mica AI pipeline' } },
      { path: 'admin/users', component: () => import('@/pages/admin/UsersPage.vue'), meta: { assistantPage: 'users', roles: admin, title: 'User accounts' } },
      { path: 'admin/departments', component: () => import('@/pages/admin/DepartmentsPage.vue'), meta: { assistantPage: 'departments', roles: admin, title: 'Departments and units' } },
      { path: 'admin/shifts', redirect: '/admin' },
      { path: 'admin/settings', component: () => import('@/pages/admin/SettingsPage.vue'), meta: { assistantPage: 'settings', roles: admin, title: 'System rules' } },
      { path: 'admin/integrations', redirect: '/admin' },
      { path: 'admin/audit', component: () => import('@/pages/shared/AuditPage.vue'), meta: { assistantPage: 'audit', roles: admin, title: 'Audit log' } },
    ],
  },
  { path: '/:pathMatch(.*)*', component: () => import('@/pages/NotFoundPage.vue'), meta: { public: true, title: 'Not found' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Route guards are for navigation only. Every permission is enforced again by the API and the database.
router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) {
    try {
      await auth.init();
    } catch {
      return true; // App.vue shows the connection error with a retry button.
    }
  }
  if (to.meta.public) {
    if (to.path === '/login' && auth.profile) return auth.homePath;
    return true;
  }
  if (!auth.profile) return { path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  if (to.meta.roles && !to.meta.roles.includes(auth.profile.role)) {
    // Shared links (e.g. /tasks/:id for a manager) go to the role's equivalent page.
    if (auth.profile.role === 'manager' && to.path.startsWith('/tasks')) return to.path.replace('/tasks', '/manager/issues');
    if (auth.profile.role !== 'manager' && to.path.startsWith('/manager/issues')) return to.path.replace('/manager/issues', '/tasks');
    return auth.homePath;
  }
  return true;
});

router.afterEach((to) => {
  const title = useAuth().pageTitle(to.meta.title as string | undefined);
  document.title = title ? `${title} · Silent Handover` : 'Silent Handover';
});
