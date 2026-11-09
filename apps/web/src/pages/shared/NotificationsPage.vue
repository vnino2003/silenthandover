<script setup lang="ts">
import { IonContent, IonItem, IonPage } from '@ionic/vue';
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { relative } from '@/lib/format';
import type { NotificationItem } from '@/lib/types';
import { useNotifications } from '@/stores/notifications';

const notes = useNotifications();
const router = useRouter();
onMounted(() => void notes.refresh());

async function open(n: NotificationItem) {
  if (!n.read_at) await notes.markRead([n.id]);
  if (n.link) router.push(n.link);
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-3xl">
            <PageHeader title="Notifications">
              <UiButton v-if="notes.unread" size="sm" @click="notes.markRead(null)">Mark all as read</UiButton>
            </PageHeader>
            <StateBlock :empty="!notes.items.length" empty-title="You’re all caught up" empty-text="Approvals, endorsements and follow-ups appear here.">
              <ul class="stagger card divide-y divide-line">
                <li v-for="n in notes.items" :key="n.id">
                  <IonItem button :detail="false" lines="none" class="sh-row" @click="open(n)"><div class="flex w-full min-w-0 items-start gap-3 px-5 py-3.5 text-left hover:bg-canvas">
                    <span class="mt-2 size-2 shrink-0 rounded-full" :class="n.read_at ? 'bg-transparent' : 'bg-accent'" :aria-label="n.read_at ? undefined : 'Unread'" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-[14px]" :class="n.read_at ? 'text-ink-2' : 'font-medium text-ink'">{{ n.title }}</span>
                      <span v-if="n.body" class="mt-0.5 line-clamp-2 block text-[13px] text-ink-3">{{ n.body }}</span>
                    </span>
                    <span class="shrink-0 text-[12.5px] text-ink-3">{{ relative(n.created_at) }}</span>
                  </div></IonItem>
                </li>
              </ul>
            </StateBlock>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
