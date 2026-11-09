<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonMenu, IonMenuButton, IonPage, IonRouterOutlet, IonSplitPane, IonToolbar, menuController } from '@ionic/vue';
import BrandMark from '@/components/BrandMark.vue';
import AssistantDock from '@/components/AssistantDock.vue';
import NavIcon from '@/components/ui/NavIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useNotifications } from '@/stores/notifications';

const auth = useAuth();
const notes = useNotifications();
const route = useRoute();
const router = useRouter();

const NAV = {
  employee: [
    { to: '/', label: 'Today', exact: true },
    { to: '/schedule', label: 'My schedule' },
    { to: '/leave', label: 'Leave' },
    { to: '/assistant', label: 'Mica assistant' },
    { to: '/handover', label: 'Incoming endorsement' },
    { to: '/tasks', label: 'Open concerns' },
    { to: '/reports', label: 'My endorsements' },
  ],
  // Department heads have the most screens: daily duties first, records after.
  manager: [
    { to: '/manager/shifts', label: 'Today', group: 'Daily duties' },
    { to: '/manager', label: 'For approval', exact: true, group: 'Daily duties', count: 'review' },
    { to: '/manager/schedule', label: 'Duty schedule', group: 'Daily duties' },
    { to: '/manager/team', label: 'Unit staff', group: 'Daily duties' },
    { to: '/manager/leave', label: 'Leave requests', group: 'Daily duties', count: 'leave' },
    { to: '/manager/issues', label: 'Concerns', group: 'Daily duties' },
    { to: '/manager/reports', label: 'Endorsement history', exact: true, group: 'Records' },
    { to: '/manager/records', label: 'Unit records', group: 'Records' },
    { to: '/manager/audit', label: 'Audit log', group: 'Records' },
    { to: '/leave', label: 'My leave', group: 'Records' },
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
} as const;

type NavItem = { to: string; label: string; exact?: boolean; group?: string; count?: 'review' | 'leave' };
// Concerns and endorsements follow the department's own words.
const nav = computed<readonly NavItem[]>(() => (auth.role ? NAV[auth.role] : []).map((item) => ({ ...item,
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

// Endorsements waiting for this department head, shown on the For approval link. Refreshes quietly.
const summary = useAsync(
  () => (auth.role === 'manager' ? api.get<{ pending_review: number; pending_leave: number }>('/manager/summary') : Promise.resolve(null)),
  [],
  { refreshMs: 30_000 },
);
const counts = computed(() => ({ review: summary.data.value?.pending_review ?? 0, leave: summary.data.value?.pending_leave ?? 0 }));
const mobileNav = computed<readonly { to: string; label: string; exact?: boolean }[]>(() => auth.role === 'employee' ? [
  { to: '/', label: 'Today', exact: true }, { to: '/schedule', label: 'Schedule' },
  { to: '/handover', label: 'Incoming' }, { to: '/tasks', label: auth.terms.issues }, { to: '/reports', label: 'Endorsements' },
] : auth.role === 'manager' ? [
  { to: '/manager/shifts', label: 'Today' }, { to: '/manager', label: 'Approval', exact: true },
  { to: '/manager/schedule', label: 'Schedule' }, { to: '/manager/issues', label: auth.terms.issues },
] : [
  { to: '/admin/users', label: 'Accounts' }, { to: '/admin', label: 'System', exact: true },
  { to: '/admin/ai-pipeline', label: 'Mica AI' }, { to: '/admin/settings', label: 'Rules' },
]);
const isActive = (item: { to: string; exact?: boolean }) => {
  // An endorsement under review belongs to the approval list.
  if (item.to === '/manager' && route.path.startsWith('/manager/reports/')) return true;
  return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`);
};

watch(
  () => route.fullPath,
  () => {
    // On phones the menu slides over the page; close it after choosing a page.
    void menuController.close('main');
    if (auth.role === 'manager') void summary.reload(true);
  },
);
onMounted(() => notes.start());
onUnmounted(() => notes.stop());

async function signOut() {
  await menuController.close('main');
  await auth.signOut();
  router.replace('/login');
}
</script>

<template>
  <IonPage>
    <a href="#workspace-main" class="skip-link">Skip to main content</a>
    <IonSplitPane content-id="shell-main" when="lg">
      <!-- The menu: always visible beside the page on wide screens, a slide-out drawer on phones. -->
      <IonMenu content-id="shell-main" menu-id="main" type="overlay" class="sh-menu">
        <IonContent class="sh-content">
          <div class="flex min-h-full flex-col px-4 py-6">
            <RouterLink :to="auth.homePath" class="px-2 text-[15px] font-semibold tracking-[-0.01em]" aria-label="Silent Handover home"><BrandMark :size="30" /></RouterLink>
            <p class="mt-0.5 px-2 text-[12.5px] text-ink-3">{{ auth.profile?.department_name ?? 'System administration' }}</p>
            <p v-if="auth.experience.organization_name" class="mt-1 truncate px-2 text-[10px] text-ink-3" :title="auth.experience.organization_name">{{ auth.experience.organization_name }}</p>
            <nav class="mt-8" aria-label="Main">
              <div v-for="(g, gi) in navGroups" :key="g.name ?? 'main'" class="space-y-0.5" :class="{ 'mt-5': gi > 0 }">
                <p v-if="g.name" class="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ g.name }}</p>
                <RouterLink
                  v-for="item in g.items"
                  :key="item.to"
                  :to="item.to"
                  class="relative flex items-center justify-between rounded-md px-2.5 py-1.5 text-[14px] transition-[color,background-color,transform] duration-200 before:absolute before:top-1.5 before:bottom-1.5 before:-left-1.5 before:w-[3px] before:rounded-full before:bg-accent before:transition-transform before:duration-300 before:content-['']"
                  :class="isActive(item) ? 'bg-accent-soft font-medium text-accent-ink before:scale-y-100' : 'text-ink-2 before:scale-y-0 hover:translate-x-0.5 hover:bg-sunken hover:text-ink'"
                  :aria-current="isActive(item) ? 'page' : undefined"
                >
                  <span class="flex items-center gap-3"><NavIcon :path="item.to" />{{ item.label }}</span>
                  <span
                    v-if="item.count && counts[item.count]"
                    :key="counts[item.count]"
                    class="pop rounded-full bg-warn px-1.5 text-[11px] leading-[18px] font-semibold text-white tnum"
                    :aria-label="`${counts[item.count]} waiting`"
                  >{{ counts[item.count] }}</span>
                </RouterLink>
              </div>
            </nav>
            <div class="mt-6 border-t border-line pt-4">
              <RouterLink
                to="/notifications"
                class="flex items-center justify-between rounded-md px-2.5 py-1.5 text-[14px]"
                :class="route.path === '/notifications' ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'"
              >
                Notifications
                <span v-if="notes.unread" :key="notes.unread" class="pop rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-white tnum">{{ notes.unread }}</span>
              </RouterLink>
            </div>
            <div class="mt-auto space-y-3 px-2 pt-6">
              <RouterLink to="/profile" class="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sunken" aria-label="Your profile">
                <UserAvatar v-if="auth.profile" :id="auth.profile.id" :name="auth.profile.full_name" :version="auth.profile.photo_version" :size="36" />
                <span class="min-w-0">
                  <span class="block truncate text-[14px] font-medium">{{ auth.profile?.full_name }}</span>
                  <span class="block text-[12.5px] text-ink-3">{{ auth.role ? auth.roleLabel(auth.role) : '' }}</span>
                </span>
              </RouterLink>
              <div class="flex gap-3 text-[13px]">
                <RouterLink to="/profile" class="text-ink-2 hover:text-ink">Profile</RouterLink>
                <IonButton fill="clear" class="sh-ghost sh-sm" @click="signOut">Sign out</IonButton>
              </div>
            </div>
          </div>
        </IonContent>
      </IonMenu>

      <div id="shell-main" class="ion-page">
        <IonHeader class="ion-no-border border-b border-line">
          <IonToolbar class="sh-toolbar">
            <IonButtons slot="start"><IonMenuButton menu="main" aria-label="Open the menu" /></IonButtons>
            <p class="truncate text-[12px] font-medium text-ink-3">
              <span class="uppercase">{{ auth.profile?.department_name ?? 'System administration' }}</span>
              <span class="mx-2 text-line-strong">/</span>
              <span class="text-ink-2">{{ auth.pageTitle(route.meta.title as string | undefined) ?? 'Overview' }}</span>
            </p>
            <IonButtons slot="end">
              <span class="hidden rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 sm:inline">{{ auth.role ? auth.roleLabel(auth.role) : '' }}</span>
              <IonButton router-link="/notifications" fill="clear" class="sh-ghost sh-sm ml-2 sh-hide-lg" aria-label="Notifications">
                Alerts<span v-if="notes.unread" :key="notes.unread" class="pop ml-1 inline-block rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white tnum">{{ notes.unread }}</span>
              </IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <!-- Each page is an Ionic page in this outlet and scrolls inside its own content area. -->
        <IonRouterOutlet id="workspace-main" />
        <!-- Primary work stays one tap away on phones. Mica is available separately on every page. -->
        <IonFooter class="sh-hide-lg">
          <IonToolbar class="mobile-dock">
            <nav class="grid px-1" :style="{ gridTemplateColumns: `repeat(${mobileNav.length}, minmax(0, 1fr))` }" aria-label="Quick navigation">
              <RouterLink
                v-for="item in mobileNav"
                :key="item.to"
                :to="item.to"
                class="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-center text-[10.5px] font-medium transition-[color,background-color,transform] duration-200 active:scale-95"
                :class="isActive(item) ? 'bg-accent-soft text-accent-ink' : 'text-ink-3'"
                :aria-current="isActive(item) ? 'page' : undefined"
              >
                <NavIcon :path="item.to" />{{ item.label }}
              </RouterLink>
            </nav>
          </IonToolbar>
        </IonFooter>
      </div>
    </IonSplitPane>
    <AssistantDock />
  </IonPage>
</template>
