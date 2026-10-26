<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
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
    { to: '/handover', label: 'Shift takeover' },
    { to: '/tasks', label: 'Open issues' },
    { to: '/reports', label: 'My reports' },
  ],
  manager: [
    { to: '/manager/shifts', label: 'Today' },
    { to: '/manager', label: 'Review queue', exact: true },
    { to: '/manager/schedule', label: 'Schedule' },
    { to: '/manager/issues', label: 'Issues' },
    { to: '/manager/reports', label: 'Report history', exact: true },
    { to: '/manager/records', label: 'Source records' },
    { to: '/manager/audit', label: 'Audit log' },
  ],
  admin: [
    { to: '/admin', label: 'Integrations', exact: true },
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/departments', label: 'Departments' },
    { to: '/admin/settings', label: 'Settings' },
    { to: '/admin/audit', label: 'Audit log' },
  ],
} as const;

const nav = computed(() => (auth.role ? NAV[auth.role] : []));
const employeeMobileNav = [
  { to: '/', label: 'Today', exact: true },
  { to: '/handover', label: 'Takeover' },
  { to: '/tasks', label: 'Issues' },
  { to: '/reports', label: 'Reports' },
] as const;
const isActive = (item: { to: string; exact?: boolean }) => {
  // A report under review belongs to the review queue.
  if (item.to === '/manager' && route.path.startsWith('/manager/reports/')) return true;
  return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`);
};

watch(() => route.fullPath, () => (menuOpen.value = false));
onMounted(() => notes.start());
onUnmounted(() => notes.stop());

async function signOut() {
  await auth.signOut();
  router.replace('/login');
}
</script>

<template>
  <div class="min-h-dvh">
    <!-- Mobile top bar -->
    <div class="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
      <RouterLink :to="auth.homePath" class="text-[15px] font-semibold tracking-[-0.01em]" aria-label="Silent Handover home"><BrandMark :size="26" /></RouterLink>
      <div class="flex items-center gap-1">
        <RouterLink to="/notifications" class="relative rounded-md px-2.5 py-1.5 text-[14px] text-ink-2 hover:bg-sunken" aria-label="Notifications">
          Alerts
          <span v-if="notes.unread" class="ml-1 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white tnum">{{ notes.unread }}</span>
        </RouterLink>
        <button class="rounded-md px-2.5 py-1.5 text-[14px] text-ink-2 hover:bg-sunken" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">Menu</button>
      </div>
    </div>
    <nav v-if="menuOpen" class="border-b border-line bg-surface px-2 py-2 lg:hidden" aria-label="Main">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="block rounded-md px-3 py-2.5 text-[15px]"
        :class="isActive(item) ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-2'"
      >
        {{ item.label }}
      </RouterLink>
      <div class="mt-2 border-t border-line pt-2">
        <RouterLink to="/profile" class="block rounded-md px-3 py-2.5 text-[15px] text-ink-2">Profile &amp; notifications</RouterLink>
        <button class="block w-full rounded-md px-3 py-2.5 text-left text-[15px] text-ink-2" @click="signOut">Sign out</button>
      </div>
    </nav>

    <div class="mx-auto flex max-w-[1320px]">
      <!-- Desktop sidebar -->
      <aside class="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line px-4 py-6 lg:flex">
        <RouterLink :to="auth.homePath" class="px-2 text-[15px] font-semibold tracking-[-0.01em]" aria-label="Silent Handover home"><BrandMark :size="30" /></RouterLink>
        <p class="mt-0.5 px-2 text-[12.5px] text-ink-3">
          {{ auth.profile?.department_name ?? 'System setup' }}
        </p>
        <nav class="mt-8 space-y-0.5" aria-label="Main">
          <RouterLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="block rounded-md px-2.5 py-1.5 text-[14px] transition-colors"
            :class="isActive(item) ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'"
            :aria-current="isActive(item) ? 'page' : undefined"
          >
            {{ item.label }}
          </RouterLink>
        </nav>
        <div class="mt-6 border-t border-line pt-4">
          <RouterLink
            to="/notifications"
            class="flex items-center justify-between rounded-md px-2.5 py-1.5 text-[14px]"
            :class="route.path === '/notifications' ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'"
          >
            Notifications
            <span v-if="notes.unread" class="rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-white tnum">{{ notes.unread }}</span>
          </RouterLink>
        </div>
        <div class="mt-auto space-y-3 px-2">
          <div>
            <p class="truncate text-[14px] font-medium">{{ auth.profile?.full_name }}</p>
            <p class="text-[12.5px] text-ink-3">{{ auth.role ? ROLE_LABELS[auth.role] : '' }}</p>
          </div>
          <div class="flex gap-3 text-[13px]">
            <RouterLink to="/profile" class="text-ink-2 hover:text-ink">Profile</RouterLink>
            <button class="text-ink-2 hover:text-ink" @click="signOut">Sign out</button>
          </div>
        </div>
      </aside>

      <main class="min-w-0 flex-1 px-4 pt-6 sm:px-6 lg:px-10 lg:py-8" :class="auth.role === 'employee' ? 'pb-24' : 'pb-8'">
        <RouterView />
      </main>
    </div>

    <!-- Workers move between these four screens throughout a shift. Keep them one tap away on mobile. -->
    <nav
      v-if="auth.role === 'employee'"
      class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface/95 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
      aria-label="Employee navigation"
    >
      <RouterLink
        v-for="item in employeeMobileNav"
        :key="item.to"
        :to="item.to"
        class="rounded-md px-1 py-2 text-center text-[12px] font-medium"
        :class="isActive(item) ? 'bg-accent-soft text-accent-ink' : 'text-ink-3'"
        :aria-current="isActive(item) ? 'page' : undefined"
      >
        {{ item.label }}
      </RouterLink>
    </nav>
  </div>
</template>
