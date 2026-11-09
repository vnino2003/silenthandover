<script setup lang="ts">
import { IonContent, IonPage } from '@ionic/vue';
import AssistantDock from '@/components/AssistantDock.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
</script>
<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-3xl"><PageHeader title="Mica, your unit assistant" description="Continue the same conversation, with a little more room." /><AssistantDock embedded /></div>
      </div>
    </IonContent>
  </IonPage>
</template>
