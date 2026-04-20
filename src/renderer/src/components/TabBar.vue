<script setup lang="ts">
import { computed } from "vue";
import { CircleDashed, Plug, Plus, Server, X } from "@renderer/lib/icons";

type TabSummary = {
  id: string;
  title: string;
  isConnecting: boolean;
  isConnected: boolean;
  sessionId: string | null;
};

const props = defineProps<{
  tabs: TabSummary[];
  activeTabId: string | null;
}>();

const emit = defineEmits<{
  (e: "activate", id: string): void;
  (e: "close", id: string): void;
  (e: "new"): void;
}>();

const empty = computed(() => props.tabs.length === 0);

function onMiddleClick(e: MouseEvent, id: string): void {
  if (e.button !== 1) return;
  e.preventDefault();
  emit("close", id);
}
</script>

<template>
  <div class="tabs" role="tablist" aria-label="Open tabs">
    <div v-if="empty" class="tabs__empty">No open tabs</div>
    <div
      v-for="t in tabs"
      :key="t.id"
      class="tab"
      :class="{ 'tab--active': t.id === activeTabId }"
      role="tab"
      :aria-selected="t.id === activeTabId"
      :tabindex="t.id === activeTabId ? 0 : -1"
      @mousedown="onMiddleClick($event, t.id)"
      @click="emit('activate', t.id)"
    >
      <span class="tab__icon">
        <CircleDashed v-if="t.isConnecting" :size="13" class="tab__spin" />
        <Plug v-else-if="t.isConnected" :size="13" />
        <Server v-else :size="13" />
      </span>
      <span class="tab__title bt-truncate">{{ t.title || "New tab" }}</span>
      <button
        type="button"
        class="tab__close"
        :aria-label="`Close ${t.title}`"
        data-tooltip="Close tab (Ctrl/Cmd+W)"
        @click.stop="emit('close', t.id)"
      >
        <X :size="12" />
      </button>
    </div>

    <button
      type="button"
      class="tabs__new"
      data-tooltip="New tab (Ctrl/Cmd+T)"
      aria-label="New tab"
      @click="emit('new')"
    >
      <Plus :size="14" />
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  align-items: end;
  height: var(--bt-h-tabs);
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
  padding: 8px 20px 0 20px;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar {
  display: none;
}

.tabs__empty {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--bt-sp-3);
  color: var(--bt-text-subtle);
  font-size: var(--bt-fs-sm);
  font-style: italic;
}

.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 160px;
  max-width: 240px;
  height: calc(var(--bt-h-tabs) - 8px);
  padding: 0 8px 0 12px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
  cursor: pointer;
  font-size: var(--bt-fs-md);
  color: var(--bt-text-muted);
  user-select: none;
  flex: 0 0 auto;
  transition: background 0.12s ease, color 0.12s ease;
}
.tab + .tab {
  margin-left: 0;
}
.tab:hover {
  background: var(--bt-row-hover);
  color: var(--bt-text);
}

.tab--active {
  background: var(--bt-panel);
  color: var(--bt-text);
  border-color: var(--bt-border);
}
.tab--active::after {
  content: "";
  position: absolute;
  left: -1px;
  right: -1px;
  bottom: -1px;
  height: 2px;
  background: var(--bt-panel);
}
.tab--active::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: var(--bt-accent);
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
}

.tab__icon {
  display: inline-flex;
  align-items: center;
  color: var(--bt-text-muted);
  flex: 0 0 auto;
}
.tab--active .tab__icon {
  color: var(--bt-accent);
}

.tab__title {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 4px;
}

.tab__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--bt-text-muted);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
  flex: 0 0 auto;
  transition: background 0.12s ease, opacity 0.12s ease;
}
.tab__close:hover {
  background: var(--bt-bg-elevated);
  color: var(--bt-danger);
  opacity: 1;
}
.tab:not(:hover):not(.tab--active) .tab__close {
  opacity: 0.35;
}

.tabs__new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: calc(var(--bt-h-tabs) - 12px);
  margin-left: 8px;
  margin-bottom: 2px;
  border: none;
  background: transparent;
  color: var(--bt-text-muted);
  cursor: pointer;
  flex: 0 0 auto;
  border-radius: 5px;
  transition: background 0.12s ease, color 0.12s ease;
}
.tabs__new:hover {
  background: var(--bt-row-hover);
  color: var(--bt-text);
}

.tab__spin {
  animation: bt-tab-spin 0.9s linear infinite;
}
@keyframes bt-tab-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
