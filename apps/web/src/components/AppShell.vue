<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import AssistantDock from '@/components/AssistantDock.vue';
import NavIcon from '@/components/ui/NavIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useNotifications } from '@/stores/notifications';
import { ROLE_LABELS } from '@sh/shared';

const auth = useAuth();
const notes = useNotifications();
const route = useRoute();
const router = useRouter();
const menuOpen = ref(false);

const NAV = {
  employee: [
    { to: '/', label: 'Today', exact: true },
    { to: '/schedule', label: 'My schedule' },
    { to: '/leave', label: 'Leave' },
    { to: '/assistant', label: 'Workplace assistant' },
    { to: '/handover', label: 'Shift takeover' },
    { to: '/tasks', label: 'Open issues' },
    { to: '/reports', label: 'My reports' },
  ],
  // Supervisors have the most screens: daily work first, look-ups after.
  manager: [
    { to: '/manager/shifts', label: 'Today', group: 'Daily work' },
    { to: '/manager', label: 'Review queue', exact: true, group: 'Daily work', count: 'review' },
    { to: '/manager/schedule', label: 'Schedule', group: 'Daily work' },
    { to: '/manager/leave', label: 'Leave requests', group: 'Daily work', count: 'leave' },
    { to: '/manager/issues', label: 'Issues', group: 'Daily work' },
    { to: '/manager/reports', label: 'Report history', exact: true, group: 'Records' },
    { to: '/manager/records', label: 'Source records', group: 'Records' },
    { to: '/manager/audit', label: 'Audit log', group: 'Records' },
    { to: '/leave', label: 'My leave', group: 'Records' },
  ],
  // IT / HR: people first, then the system settings (AI and integrations among them), then the log.
  admin: [
    { to: '/admin/users', label: 'Users', group: 'People' },
    { to: '/admin/departments', label: 'Departments', group: 'People' },
    { to: '/admin/schedules', label: 'Schedules', group: 'People' },
    { to: '/admin/leave', label: 'Leave approvals', group: 'People' },
    { to: '/admin', label: 'Integrations', exact: true, group: 'Settings' },
    { to: '/admin/ai-pipeline', label: 'Mica AI pipeline', group: 'Settings' },
    { to: '/admin/settings', label: 'Rules and emails', group: 'Settings' },
    { to: '/admin/audit', label: 'Audit log', group: 'Records' },
  ],
} as const;

type NavItem = { to: string; label: string; exact?: boolean; group?: string; count?: 'review' | 'leave' };
const nav = computed<readonly NavItem[]>(() => (auth.role ? NAV[auth.role] : []).map((item) => ({ ...item,
  label: item.to === '/reports' ? `My ${auth.experience.report_label.toLowerCase()}s` : item.to === '/tasks' || item.to === '/manager/issues' ? `${auth.experience.issue_label}s` : item.label,
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

// Reports waiting for this supervisor, shown on the Review queue link. Refreshes quietly.
const summary = useAsync(
  () => (auth.role === 'manager' ? api.get<{ pending_review: number; pending_leave: number }>('/manager/summary') : Promise.resolve(null)),
  [],
  { refreshMs: 30_000 },
);
const counts = computed(() => ({ review: summary.data.value?.pending_review ?? 0, leave: summary.data.value?.pending_leave ?? 0 }));
const employeeMobileNav = [
  { to: '/', label: 'Today', exact: true },
  { to: '/schedule', label: 'Schedule' },
  { to: '/handover', label: 'Takeover' },
  { to: '/tasks', label: 'Issues' },
  { to: '/reports', label: 'Reports' },
] as const;
const mobileNav = computed<readonly { to: string; label: string; exact?: boolean }[]>(() => auth.role === 'employee' ? employeeMobileNav : auth.role === 'manager' ? [
  { to: '/manager/shifts', label: 'Today' }, { to: '/manager', label: 'Review', exact: true },
  { to: '/manager/schedule', label: 'Schedule' }, { to: '/manager/issues', label: 'Issues' },
] : [
  { to: '/admin/users', label: 'People' }, { to: '/admin', label: 'System', exact: true },
  { to: '/admin/ai-pipeline', label: 'Mica AI pipeline' }, { to: '/admin/settings', label: 'Settings' },
]);
const isActive = (item: { to: string; exact?: boolean }) => {
  // A report under review belongs to the review queue.
  if (item.to === '/manager' && route.path.startsWith('/manager/reports/')) return true;
  return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`);
};

watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
    if (auth.role === 'manager') void summary.reload(true);
  },
);
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (menuOpen.value = false);
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
onMounted(() => notes.start());
onUnmounted(() => notes.stop());

async function signOut() {
  await auth.signOut();
  router.replace('/login');
}
</script>

<template>
  <div class="app-shell min-h-dvh">
    <a href="#workspace-main" class="skip-link">Skip to workspace</a>
    <!-- Mobile top bar -->
    <div class="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
      <RouterLink :to="auth.homePath" class="text-[15px] font-semibold tracking-[-0.01em]" aria-label="Silent Handover home"><BrandMark :size="26" /></RouterLink>
      <div class="flex items-center gap-1">
        <RouterLink to="/notifications" class="relative rounded-md px-2.5 py-1.5 text-[14px] text-ink-2 hover:bg-sunken" aria-label="Notifications">
          Alerts
          <span v-if="notes.unread" :key="notes.unread" class="pop ml-1 inline-block rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white tnum">{{ notes.unread }}</span>
        </RouterLink>
        <button class="rounded-md px-2.5 py-1.5 text-[14px] text-ink-2 hover:bg-sunken" aria-controls="mobile-main-menu" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">Menu</button>
      </div>
    </div>
    <Transition name="fade">
      <div v-if="menuOpen" class="fixed inset-0 top-14 z-20 bg-ink/20 lg:hidden" aria-hidden="true" @click="menuOpen = false" />
    </Transition>
    <Transition name="drop">
    <nav
      v-if="menuOpen"
      id="mobile-main-menu"
      class="fixed inset-x-0 top-14 z-30 max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-b border-line bg-surface px-2 py-2 shadow-pop lg:hidden"
      aria-label="Main"
    >
      <template v-for="g in navGroups" :key="g.name ?? 'main'">
        <p v-if="g.name" class="px-3 pt-2 pb-1 text-[11.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ g.name }}</p>
        <RouterLink
          v-for="item in g.items"
          :key="item.to"
          :to="item.to"
          class="flex items-center justify-between rounded-md px-3 py-2.5 text-[15px]"
          :class="isActive(item) ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-2'"
        >
          <span class="flex items-center gap-3"><NavIcon :path="item.to" />{{ item.label }}</span>
          <span
            v-if="item.count && counts[item.count]"
            :key="counts[item.count]"
            class="pop rounded-full bg-warn px-1.5 text-[11px] leading-[18px] font-semibold text-white tnum"
            :aria-label="`${counts[item.count]} waiting`"
          >{{ counts[item.count] }}</span>
        </RouterLink>
      </template>
      <div class="mt-2 border-t border-line pt-2">
        <RouterLink to="/profile" class="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[15px] text-ink-2">
          <UserAvatar v-if="auth.profile" :id="auth.profile.id" :name="auth.profile.full_name" :version="auth.profile.photo_version" :size="28" />
          Profile &amp; notifications
        </RouterLink>
        <button class="block w-full rounded-md px-3 py-2.5 text-left text-[15px] text-ink-2" @click="signOut">Sign out</button>
      </div>
    </nav>
    </Transition>

    <div class="mx-auto flex max-w-[1320px]">
      <!-- Desktop sidebar -->
      <aside class="workspace-sidebar sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r border-line px-4 py-6 lg:flex">
        <RouterLink :to="auth.homePath" class="px-2 text-[15px] font-semibold tracking-[-0.01em]" aria-label="Silent Handover home"><BrandMark :size="30" /></RouterLink>
        <p class="mt-0.5 px-2 text-[12.5px] text-ink-3">
          {{ auth.profile?.department_name ?? 'System setup' }}
        </p>
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
        <div class="mt-auto space-y-3 px-2">
          <RouterLink to="/profile" class="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sunken" aria-label="Your profile">
            <UserAvatar v-if="auth.profile" :id="auth.profile.id" :name="auth.profile.full_name" :version="auth.profile.photo_version" :size="36" />
            <span class="min-w-0">
              <span class="block truncate text-[14px] font-medium">{{ auth.profile?.full_name }}</span>
              <span class="block text-[12.5px] text-ink-3">{{ auth.role ? auth.roleLabel(auth.role) : '' }}</span>
            </span>
          </RouterLink>
          <div class="flex gap-3 text-[13px]">
            <RouterLink to="/profile" class="text-ink-2 hover:text-ink">Profile</RouterLink>
            <button class="text-ink-2 hover:text-ink" @click="signOut">Sign out</button>
          </div>
        </div>
      </aside>

      <main id="workspace-main" tabindex="-1" class="workspace-main min-w-0 flex-1 px-4 pt-6 sm:px-6 lg:px-10 lg:py-8">
        <div class="workspace-topline mb-7 hidden items-center justify-between border-b border-line pb-4 lg:flex">
          <p class="text-[12px] font-medium text-ink-3">WORKSPACE <span class="mx-2 text-line-strong">/</span> <span class="text-ink-2">{{ route.meta.title ?? 'Overview' }}</span></p>
          <span class="rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2">{{ auth.role ? auth.roleLabel(auth.role) : '' }} portal</span>
        </div>
        <!-- Each new page fades in with a CSS animation. Unlike a Vue transition it never waits on
             the browser, so navigation can't stall in a background tab. -->
        <RouterView v-slot="{ Component, route: r }">
          <component :is="Component" :key="r.path" class="page-enter" />
        </RouterView>
      </main>
    </div>

    <AssistantDock />
    <!-- Primary work stays one tap away. Mica is available separately on every page. -->
    <nav
      class="mobile-dock fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-surface/95 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
      :style="{ gridTemplateColumns: `repeat(${mobileNav.length}, minmax(0, 1fr))` }"
      aria-label="Workspace navigation"
    >
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
  </div>
</template>
