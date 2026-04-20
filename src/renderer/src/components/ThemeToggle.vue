<script setup lang="ts">
import { computed } from "vue";
import { useTheme, type ThemeMode } from "@renderer/composables/useTheme";
import { Monitor, Moon, Sun } from "@renderer/lib/icons";

const { mode, cycle } = useTheme();

const label = computed(() => {
  const m = mode.value as ThemeMode;
  if (m === "light") return "Theme: Light";
  if (m === "dark") return "Theme: Dark";
  return "Theme: System";
});
</script>

<template>
  <button
    type="button"
    class="bt-iconbtn theme-toggle"
    :data-tooltip="label"
    :aria-label="label"
    @click="cycle()"
  >
    <Sun v-if="mode === 'light'" :size="14" />
    <Moon v-else-if="mode === 'dark'" :size="14" />
    <Monitor v-else :size="14" />
  </button>
</template>

<style scoped>
.theme-toggle {
  width: 22px;
  height: 22px;
}
</style>
