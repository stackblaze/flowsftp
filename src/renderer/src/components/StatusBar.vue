<script setup lang="ts">
import { computed } from "vue";
import { CircleDashed, Plug, Server } from "@renderer/lib/icons";
import { formatSpeed } from "@renderer/lib/format";
import ThemeToggle from "./ThemeToggle.vue";

const props = defineProps<{
  isConnected: boolean;
  isConnecting: boolean;
  username?: string;
  host?: string;
  remotePath?: string;
  bytesPerSec: number;
  active: number;
  queued: number;
  /** Currently transferring filename, if any (drives the activity readout). */
  currentName?: string | null;
  /** 0..100 overall progress for the active transfer. */
  currentPercent?: number;
  /** Whether the queue panel is currently visible — controls the indicator
   * affordance: when hidden the indicator looks like a clickable button to
   * surface the in-progress work the user can't otherwise see. */
  queueVisible?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle-queue"): void;
}>();

const connectionLabel = computed<string>(() => {
  if (props.isConnecting) return "Connecting…";
  if (!props.isConnected || !props.host) return "Disconnected";
  const u = props.username ? `${props.username}@` : "";
  return `${u}${props.host}`;
});

const hasActivity = computed(() => props.active > 0 || props.queued > 0);
const pct = computed(() =>
  Math.max(0, Math.min(100, Math.round(props.currentPercent ?? 0))),
);
</script>

<template>
  <footer class="status" role="status" aria-live="polite">
    <div class="status__left">
      <span class="status__chip" :class="{ 'status__chip--ok': isConnected }">
        <CircleDashed v-if="isConnecting" :size="11" class="status__spin" />
        <Plug v-else-if="isConnected" :size="11" />
        <Server v-else :size="11" />
        <span class="bt-truncate">{{ connectionLabel }}</span>
      </span>
      <span v-if="isConnected && remotePath" class="status__path bt-truncate">
        {{ remotePath }}
      </span>
    </div>

    <div class="status__right">
      <!-- Activity indicator. When the queue panel is hidden and a transfer
           is running, this is the user's only "yes, things are happening"
           signal — so it pulses, shows live progress, and is clickable to
           pop the queue back open. -->
      <button
        type="button"
        class="status__activity"
        :class="{
          'status__activity--active': hasActivity,
          'status__activity--button': !queueVisible,
        }"
        :aria-label="queueVisible ? 'Hide queue panel' : 'Show queue panel'"
        :data-tooltip="queueVisible ? 'Hide queue' : 'Show queue'"
        @click="emit('toggle-queue')"
      >
        <span class="status__activity-bar" :style="{ width: pct + '%' }" />
        <span class="status__activity-content">
          <CircleDashed
            v-if="hasActivity"
            :size="11"
            class="status__activity-spin"
          />
          <span v-if="hasActivity && currentName" class="bt-truncate status__activity-name">
            {{ currentName }}
          </span>
          <span v-else-if="hasActivity" class="status__activity-counts">
            {{ active }} active · {{ queued }} queued
          </span>
          <span v-else class="status__activity-counts">Idle</span>
          <span v-if="hasActivity" class="status__activity-pct">{{ pct }}%</span>
        </span>
      </button>

      <span class="status__throughput">{{ formatSpeed(bytesPerSec) }}</span>
      <ThemeToggle />
    </div>
  </footer>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--bt-h-status);
  padding: 0 8px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  flex: 0 0 auto;
}

.status__left,
.status__right {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.status__left {
  flex: 1 1 auto;
}
.status__right {
  flex: 0 0 auto;
}

.status__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  height: 18px;
  border: 1px solid var(--bt-border);
  border-radius: 99px;
  background: var(--bt-bg-elevated);
  color: var(--bt-text-muted);
  max-width: 280px;
  font-variant-numeric: tabular-nums;
}
.status__chip--ok {
  color: var(--bt-success);
  border-color: color-mix(in srgb, var(--bt-success) 50%, var(--bt-border) 50%);
}

.status__path {
  font-family: var(--bt-font-mono);
  color: var(--bt-text-muted);
  max-width: 380px;
}

/* --- Activity indicator -------------------------------------------------- */
.status__activity {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 20px;
  min-width: 110px;
  max-width: 320px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--bt-radius-sm);
  color: var(--bt-text-muted);
  font: inherit;
  cursor: pointer;
  overflow: hidden;
}
/* When the queue panel is hidden we make the indicator look like an
 * affordable button — visible border + background — so the user notices
 * it and knows they can click to reveal the queue. */
.status__activity--button {
  border-color: var(--bt-border);
  background: var(--bt-bg-elevated);
  padding: 0 6px;
}
.status__activity:hover {
  border-color: color-mix(in srgb, var(--bt-accent) 60%, var(--bt-border) 40%);
  color: var(--bt-text);
}
.status__activity--active {
  color: var(--bt-text);
}
/* Subtle pulse to draw the eye to a running transfer. */
.status__activity--active.status__activity--button {
  border-color: color-mix(in srgb, var(--bt-accent) 60%, var(--bt-border) 40%);
  animation: bt-status-pulse 1.6s ease-in-out infinite;
}
@keyframes bt-status-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--bt-accent) 0%, transparent);
  }
  50% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--bt-accent) 18%, transparent);
  }
}
.status__activity-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  background: color-mix(in srgb, var(--bt-accent) 22%, transparent);
  transition: width 0.18s ease;
  pointer-events: none;
}
.status__activity-content {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0 6px;
  min-width: 0;
}
.status__activity-name {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bt-font-mono);
}
.status__activity-counts {
  flex: 1 1 auto;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.status__activity-pct {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--bt-accent);
  font-weight: 600;
}
.status__activity-spin {
  flex: 0 0 auto;
  color: var(--bt-accent);
  animation: bt-status-spin 0.9s linear infinite;
}

.status__throughput {
  font-family: var(--bt-font-mono);
  color: var(--bt-text);
  min-width: 60px;
  text-align: right;
}

.status__spin {
  animation: bt-status-spin 0.9s linear infinite;
}
@keyframes bt-status-spin {
  from {
    transform: rotate(0);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
