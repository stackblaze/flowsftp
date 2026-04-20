<script setup lang="ts">
import { onMounted } from "vue";
import { RouterView } from "vue-router";
import { useTheme } from "@renderer/composables/useTheme";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useQueueStore } from "@renderer/stores/queue";

useTheme();

onMounted(async () => {
  try {
    const sessions = useSessionsStore();
    const queue = useQueueStore();
    await Promise.all([
      Promise.resolve().then(() => sessions.load()),
      Promise.resolve().then(() => queue.init()),
    ]);
  } catch (err) {
    // Stores may not be available on first wiring or in tests; the renderer
    // should still mount so the user sees the empty shell rather than a
    // white screen.
    console.warn("Synctron store init failed:", err);
  }
});
</script>

<template>
  <div class="bt-app-root">
    <RouterView />
  </div>
</template>

<style>
.bt-app-root {
  height: 100vh;
  width: 100vw;
  margin: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
