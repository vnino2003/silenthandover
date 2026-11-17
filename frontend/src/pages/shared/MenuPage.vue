<script setup lang="ts">
import { IonContent, IonItem, IonPage } from '@ionic/vue';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/ui/PageHeader.vue';
import NavIcon from '@/components/ui/NavIcon.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { useAsync } from '@/composables/useAsync';
import { useNavigation } from '@/composables/useNavigation';
import { api } from '@/lib/api';
import { disablePush } from '@/lib/push';
import { useAuth } from '@/stores/auth';
import { useNotifications } from '@/stores/notifications';

/**
 * "More" on phones: every page of the menu for this person, in the same sections as the
 * wide-screen side menu (they share one definition), plus notifications, profile and sign-out.
 * Nothing in the web menu is missing on Android.
 */
const auth = useAuth();
const notes = useNotifications();
const router = useRouter();
const { navGroups, isActive } = useNavigation();
// The same waiting counts as the side menu (endorsements to approve, leave to decide).
const summary = useAsync(() => (auth.role === 'manager' ? api.get<{ pending_review: number; pending_leave: number }>('/manager/summary') : Promise.resolve(null)));
const counts = computed(() => ({ review: summary.data.value?.pending_review ?? 0, leave: summary.data.value?.pending_leave ?? 0 }));

async function signOut() {
  // Alerts belong to the person, not the device: stop them here before signing out (as the side menu does).
  await disablePush();
  await auth.signOut();
  await router.replace('/login');
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-xl space-y-5">
          <PageHeader title="Menu" :description="auth.role === 'admin' ? 'System administration' : auth.profile?.department_name ?? ''" />
          <nav class="space-y-5" aria-label="All pages">
            <section v-for="g in navGroups" :key="g.name ?? 'main'" class="card overflow-hidden">
              <h2 v-if="g.name" class="border-b border-line px-4 py-2.5 text-[11.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ g.name }}</h2>
              <ul class="divide-y divide-line">
                <li v-for="item in g.items" :key="item.to">
                  <IonItem button :detail="true" lines="none" class="sh-row" :aria-current="isActive(item) ? 'page' : undefined" @click="router.push(item.to)">
                    <div class="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-[15px]" :class="isActive(item) ? 'font-medium text-accent-ink' : 'text-ink'">
                      <NavIcon :path="item.to" /><span class="flex-1">{{ item.label }}</span>
                      <span v-if="item.count && counts[item.count]" class="rounded-full bg-warn px-2 text-[12px] leading-5 font-semibold text-white tnum" :aria-label="`${counts[item.count]} waiting`">{{ counts[item.count] }}</span>
                    </div>
                  </IonItem>
                </li>
              </ul>
            </section>
            <section class="card overflow-hidden">
              <ul class="divide-y divide-line">
                <li>
                  <IonItem button :detail="true" lines="none" class="sh-row" @click="router.push('/notifications')">
                    <div class="flex w-full items-center justify-between gap-3 px-4 py-3 text-[15px]">
                      <span>Notifications</span>
                      <span v-if="notes.unread" class="rounded-full bg-accent px-2 text-[12px] leading-5 font-semibold text-white tnum">{{ notes.unread }}</span>
                    </div>
                  </IonItem>
                </li>
                <li>
                  <IonItem button :detail="true" lines="none" class="sh-row" @click="router.push('/profile')">
                    <div class="flex w-full min-w-0 items-center gap-3 px-4 py-3">
                      <UserAvatar v-if="auth.profile" :id="auth.profile.id" :name="auth.profile.full_name" :version="auth.profile.photo_version" :size="36" />
                      <span class="min-w-0">
                        <span class="block truncate text-[15px] font-medium">{{ auth.profile?.full_name }}</span>
                        <span class="block text-[13px] text-ink-3">{{ auth.role ? auth.roleLabel(auth.role) : '' }} · Profile</span>
                      </span>
                    </div>
                  </IonItem>
                </li>
              </ul>
            </section>
          </nav>
          <UiButton block variant="secondary" @click="signOut">Sign out</UiButton>
        </div>
      </div>
    </IonContent>
  </IonPage>
</template>
