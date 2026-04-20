<script setup lang="ts">
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from "@renderer/lib/icons";

const emit = defineEmits<{
  (e: "newTab"): void;
  (e: "newSession"): void;
  (e: "refresh"): void;
  (e: "upload"): void;
  (e: "download"): void;
  (e: "pauseAll"): void;
  (e: "resumeAll"): void;
  (e: "clearCompleted"): void;
}>();

defineProps<{
  canUpload?: boolean;
  canDownload?: boolean;
  canRefresh?: boolean;
}>();
</script>

<template>
  <div class="toolbar" role="toolbar" aria-label="Application toolbar">
    <div class="toolbar__group">
      <button
        type="button"
        class="bt-btn bt-btn--ghost"
        data-tooltip="New tab (Ctrl/Cmd+T)"
        @click="emit('newTab')"
      >
        <Plus :size="14" />
        <span>New tab</span>
      </button>
      <button
        type="button"
        class="bt-btn bt-btn--ghost"
        data-tooltip="New session"
        @click="emit('newSession')"
      >
        <Plug :size="14" />
        <span>New session</span>
      </button>
    </div>

    <div class="toolbar__sep" />

    <div class="toolbar__group">
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Refresh (Ctrl/Cmd+R)"
        :disabled="!canRefresh"
        @click="emit('refresh')"
      >
        <RefreshCw :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Upload selected"
        :disabled="!canUpload"
        @click="emit('upload')"
      >
        <ArrowUpFromLine :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Download selected"
        :disabled="!canDownload"
        @click="emit('download')"
      >
        <ArrowDownToLine :size="14" />
      </button>
    </div>

    <div class="toolbar__sep" />

    <div class="toolbar__group">
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Pause all transfers"
        @click="emit('pauseAll')"
      >
        <Pause :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Resume all transfers"
        @click="emit('resumeAll')"
      >
        <Play :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Clear completed transfers"
        @click="emit('clearCompleted')"
      >
        <Trash2 :size="14" />
      </button>
    </div>

    <div class="toolbar__spacer" />
    <slot name="end" />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: var(--bt-h-toolbar);
  padding: 0 var(--bt-sp-2);
  background: var(--bt-toolbar);
  border-bottom: 1px solid var(--bt-border);
}

.toolbar__group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.toolbar__sep {
  width: 1px;
  height: 18px;
  background: var(--bt-border);
  margin: 0 4px;
}

.toolbar__spacer {
  flex: 1 1 auto;
}
</style>
