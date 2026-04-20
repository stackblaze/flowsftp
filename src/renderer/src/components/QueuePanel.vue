<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Clock,
  GripVertical,
  Minus,
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
  X,
} from "@renderer/lib/icons";
import { formatBytes } from "@renderer/lib/paths";
import { formatPercent, formatSpeed } from "@renderer/lib/format";

type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

type Job = {
  id: string;
  connectionId: string;
  kind: "upload" | "download";
  src: string;
  dst: string;
  size: number;
  transferred: number;
  status: JobStatus;
  error?: string;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  priority: "low" | "normal" | "high";
};

const props = defineProps<{
  jobs: Job[];
  collapsed: boolean;
  stats: { active: number; queued: number; completed: number; failed: number };
  bytesPerSec: number;
  autoClear: boolean;
  /** Current "max parallel transfers" value driving the toolbar stepper. */
  concurrency: number;
  /** Inclusive bounds of the stepper. Defaults to 1..8. */
  concurrencyMin?: number;
  concurrencyMax?: number;
}>();

const emit = defineEmits<{
  (e: "toggleCollapse"): void;
  (e: "pauseAll"): void;
  (e: "resumeAll"): void;
  (e: "clearCompleted"): void;
  (e: "pause", id: string): void;
  (e: "resume", id: string): void;
  (e: "cancel", id: string): void;
  (e: "remove", id: string): void;
  (e: "reorder", orderedIds: string[]): void;
  (e: "update:autoClear", value: boolean): void;
  (e: "update:concurrency", value: number): void;
}>();

const concurrencyMin = computed(() => props.concurrencyMin ?? 1);
const concurrencyMax = computed(() => props.concurrencyMax ?? 8);
function bumpConcurrency(delta: 1 | -1): void {
  const next = Math.max(
    concurrencyMin.value,
    Math.min(concurrencyMax.value, props.concurrency + delta),
  );
  if (next !== props.concurrency) emit("update:concurrency", next);
}

const STATUS_ORDER: Record<JobStatus, number> = {
  running: 0,
  queued: 1,
  paused: 2,
  failed: 3,
  completed: 4,
  cancelled: 5,
};

/** True for rows the user is allowed to reorder/move/remove via drag. */
function isPending(j: Job): boolean {
  return j.status === "queued" || j.status === "paused";
}

const sortedJobs = computed<Job[]>(() => {
  // Within the queued+paused group preserve the canonical order coming from
  // `props.jobs` (driven by main process). Outside that group fall back to
  // status-then-recency. This way drag-and-drop reorders queued items
  // visibly while running and terminal rows stay where users expect them.
  const rank = new Map<string, number>();
  props.jobs.forEach((j, i) => rank.set(j.id, i));
  return [...props.jobs].sort((a, b) => {
    const sa = STATUS_ORDER[a.status];
    const sb = STATUS_ORDER[b.status];
    if (sa !== sb) return sa - sb;
    if (isPending(a) && isPending(b)) {
      return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
    }
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
});

/** The pending-only subset in their current display order. The reorder API
 *  only ever rewrites these slots, so all the move helpers operate on this. */
const pendingOrder = computed<string[]>(() =>
  sortedJobs.value.filter(isPending).map((j) => j.id),
);

/* --- Drag-and-drop reorder ---
 * HTML5 D&D within the table body. Only pending rows are draggable. While a
 * drag is in flight we track the hovered row so we can paint a drop-line
 * indicator. On drop we splice the dragged id into its new slot among the
 * pending ids and emit the resulting list. */
const draggingId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
const dragOverPosition = ref<"before" | "after">("before");

function onRowDragStart(j: Job, ev: DragEvent): void {
  if (!isPending(j) || !ev.dataTransfer) return;
  draggingId.value = j.id;
  ev.dataTransfer.effectAllowed = "move";
  ev.dataTransfer.setData("text/plain", j.id);
}

function onRowDragOver(j: Job, ev: DragEvent): void {
  if (!draggingId.value || !isPending(j)) return;
  if (j.id === draggingId.value) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  // Decide whether we're hovering the upper or lower half of the row so the
  // user gets a precise insertion line, not just "somewhere on this row".
  const target = ev.currentTarget as HTMLElement | null;
  if (target) {
    const r = target.getBoundingClientRect();
    dragOverPosition.value = ev.clientY < r.top + r.height / 2
      ? "before"
      : "after";
  }
  dragOverId.value = j.id;
}

function onRowDragLeave(j: Job): void {
  if (dragOverId.value === j.id) dragOverId.value = null;
}

function onRowDrop(j: Job, ev: DragEvent): void {
  ev.preventDefault();
  const dragged = draggingId.value;
  draggingId.value = null;
  dragOverId.value = null;
  if (!dragged || dragged === j.id || !isPending(j)) return;
  const next = pendingOrder.value.filter((id) => id !== dragged);
  const idx = next.indexOf(j.id);
  if (idx < 0) return;
  const insertAt = dragOverPosition.value === "after" ? idx + 1 : idx;
  next.splice(insertAt, 0, dragged);
  emit("reorder", next);
}

function onRowDragEnd(): void {
  draggingId.value = null;
  dragOverId.value = null;
}

/** Move a pending job up/down by one slot. Used by the keyboard-friendly
 *  arrow buttons on each pending row. */
function nudge(id: string, dir: -1 | 1): void {
  const ids = pendingOrder.value.slice();
  const i = ids.indexOf(id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  emit("reorder", ids);
}

function pendingIndex(id: string): number {
  return pendingOrder.value.indexOf(id);
}
function pendingCount(): number {
  return pendingOrder.value.length;
}

function statusLabel(s: JobStatus): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Time spent on this job, formatted like 00:00:23. */
function elapsedString(j: Job): string {
  if (!j.startedAt) return "—";
  const end =
    j.finishedAt ?? (j.status === "running" ? Date.now() : j.startedAt);
  const totalSec = Math.max(0, Math.floor((end - j.startedAt) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => n.toString().padStart(2, "0")).join(":");
}

function transferredString(j: Job): string {
  if (j.status === "completed") return formatBytes(j.size);
  if (j.transferred > 0 || j.status === "running" || j.status === "paused") {
    return `${formatBytes(j.transferred)} / ${formatBytes(j.size)}`;
  }
  return formatBytes(j.size);
}

/**
 * Visual progress for a job. A completed job always reads 100% even if the
 * final progress event was missed (the SFTP `step` callback is throttled
 * and may not deliver the last byte before fastPut resolves). A cancelled
 * row reads 0%; everything else uses the actual transferred/size ratio.
 */
function progressLabel(j: Job): string {
  if (j.status === "completed") return "100%";
  if (j.status === "cancelled") return "—";
  return formatPercent(j.transferred, j.size, 0);
}

function progressWidth(j: Job): string {
  if (j.status === "completed") return "100%";
  if (j.status === "cancelled") return "0%";
  return formatPercent(j.transferred, j.size);
}

/** Tick a reactive "now" value once per second so elapsed time updates. */
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => tick.value++, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="queue" :class="{ 'queue--collapsed': collapsed }">
    <header class="queue__head">
      <button
        type="button"
        class="bt-iconbtn"
        :data-tooltip="collapsed ? 'Show queue' : 'Hide queue'"
        @click="emit('toggleCollapse')"
      >
        <ChevronUp v-if="collapsed" :size="14" />
        <ChevronDown v-else :size="14" />
      </button>
      <h2 class="queue__title">Transfer queue</h2>

      <div class="queue__stats">
        <span class="queue__stat queue__stat--active">
          <CircleDashed :size="11" />
          {{ stats.active }} active
        </span>
        <span class="queue__stat">
          <Clock :size="11" />
          {{ stats.queued }} queued
        </span>
        <span class="queue__stat queue__stat--ok">
          <CheckCircle2 :size="11" />
          {{ stats.completed }} done
        </span>
        <span v-if="stats.failed > 0" class="queue__stat queue__stat--err">
          <AlertCircle :size="11" />
          {{ stats.failed }} failed
        </span>
        <span class="queue__stat queue__stat--speed">
          {{ formatSpeed(bytesPerSec) }}
        </span>
      </div>

      <div class="queue__actions">
        <label
          class="queue__autoclear"
          data-tooltip="Automatically remove completed transfers"
        >
          <input
            type="checkbox"
            :checked="autoClear"
            @change="
              emit('update:autoClear', ($event.target as HTMLInputElement).checked)
            "
          />
          <span>Auto-clear</span>
        </label>
        <div
          class="queue__concurrency"
          :data-tooltip="`Max parallel transfers (${concurrencyMin}–${concurrencyMax})`"
          role="group"
          aria-label="Max parallel transfers"
        >
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Fewer parallel transfers"
            :disabled="concurrency <= concurrencyMin"
            aria-label="Decrease max parallel transfers"
            @click="bumpConcurrency(-1)"
          >
            <Minus :size="12" />
          </button>
          <span class="queue__concurrency-value bt-mono" aria-live="polite">
            {{ concurrency }}
          </span>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="More parallel transfers"
            :disabled="concurrency >= concurrencyMax"
            aria-label="Increase max parallel transfers"
            @click="bumpConcurrency(1)"
          >
            <Plus :size="12" />
          </button>
        </div>
        <button
          type="button"
          class="bt-btn bt-btn--ghost"
          data-tooltip="Pause all"
          @click="emit('pauseAll')"
        >
          <Pause :size="13" />
        </button>
        <button
          type="button"
          class="bt-btn bt-btn--ghost"
          data-tooltip="Resume all"
          @click="emit('resumeAll')"
        >
          <Play :size="13" />
        </button>
        <button
          type="button"
          class="bt-btn bt-btn--ghost"
          data-tooltip="Clear completed"
          @click="emit('clearCompleted')"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </header>

    <div v-if="!collapsed" class="queue__body">
      <table class="queue__table">
        <thead>
          <tr>
            <th class="qcol-grip"></th>
            <th class="qcol-op">Operation</th>
            <th class="qcol-source">Source</th>
            <th class="qcol-dest">Destination</th>
            <th class="qcol-xferred">Transferred</th>
            <th class="qcol-time">Time</th>
            <th class="qcol-speed">Speed</th>
            <th class="qcol-progress">Progress</th>
            <th class="qcol-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="sortedJobs.length === 0">
            <td colspan="9" class="queue__empty">
              <em>No transfers yet — drop files on the remote pane to upload.</em>
            </td>
          </tr>
          <tr
            v-for="j in sortedJobs"
            :key="j.id"
            class="queue__row"
            :class="[
              `queue__row--${j.status}`,
              {
                'queue__row--dragging': draggingId === j.id,
                'queue__row--drop-before':
                  dragOverId === j.id && dragOverPosition === 'before',
                'queue__row--drop-after':
                  dragOverId === j.id && dragOverPosition === 'after',
              },
            ]"
            :draggable="isPending(j)"
            :title="j.error || statusLabel(j.status)"
            @dragstart="onRowDragStart(j, $event)"
            @dragover="onRowDragOver(j, $event)"
            @dragleave="onRowDragLeave(j)"
            @drop="onRowDrop(j, $event)"
            @dragend="onRowDragEnd"
          >
            <td class="qcol-grip">
              <span
                v-if="isPending(j)"
                class="queue__grip"
                title="Drag to reorder"
                aria-label="Drag to reorder"
              >
                <GripVertical :size="12" />
              </span>
            </td>
            <td class="qcol-op">
              <span class="queue__op">
                <span
                  class="queue__op-direction"
                  :class="
                    j.kind === 'upload'
                      ? 'queue__op-direction--up'
                      : 'queue__op-direction--down'
                  "
                  :aria-label="j.kind"
                >
                  {{ j.kind === "upload" ? "↑" : "↓" }}
                </span>
                <span class="queue__op-status" :title="statusLabel(j.status)">
                  <CircleDashed
                    v-if="j.status === 'running'"
                    :size="13"
                    class="queue__spin"
                  />
                  <Clock v-else-if="j.status === 'queued'" :size="13" />
                  <Pause v-else-if="j.status === 'paused'" :size="13" />
                  <CheckCircle2
                    v-else-if="j.status === 'completed'"
                    :size="13"
                    class="queue__icon-ok"
                  />
                  <AlertCircle
                    v-else-if="j.status === 'failed'"
                    :size="13"
                    class="queue__icon-err"
                  />
                  <X v-else :size="13" />
                </span>
              </span>
            </td>
            <td class="qcol-source bt-truncate" :title="j.src">{{ j.src }}</td>
            <td class="qcol-dest bt-truncate" :title="j.dst">{{ j.dst }}</td>
            <td class="qcol-xferred bt-mono">{{ transferredString(j) }}</td>
            <td class="qcol-time bt-mono">
              <span :data-tick="tick">{{ elapsedString(j) }}</span>
            </td>
            <td class="qcol-speed bt-mono">
              <span v-if="j.status === 'running'">
                {{ formatSpeed(bytesPerSec / Math.max(1, stats.active)) }}
              </span>
              <span v-else class="queue__muted">—</span>
            </td>
            <td class="qcol-progress">
              <div class="queue__progress">
                <div
                  class="queue__progress-bar"
                  :style="{ width: progressWidth(j) }"
                />
                <span class="queue__progress-label">
                  {{ progressLabel(j) }}
                </span>
              </div>
              <div v-if="j.error" class="queue__error" :title="j.error">
                {{ j.error }}
              </div>
            </td>
            <td class="qcol-actions">
              <button
                v-if="isPending(j)"
                type="button"
                class="bt-iconbtn"
                data-tooltip="Move up"
                :disabled="pendingIndex(j.id) <= 0"
                @click="nudge(j.id, -1)"
              >
                <ArrowUp :size="12" />
              </button>
              <button
                v-if="isPending(j)"
                type="button"
                class="bt-iconbtn"
                data-tooltip="Move down"
                :disabled="pendingIndex(j.id) >= pendingCount() - 1"
                @click="nudge(j.id, 1)"
              >
                <ArrowDown :size="12" />
              </button>
              <button
                v-if="j.status === 'running' || j.status === 'queued'"
                type="button"
                class="bt-iconbtn"
                data-tooltip="Pause"
                @click="emit('pause', j.id)"
              >
                <Pause :size="12" />
              </button>
              <button
                v-if="j.status === 'paused'"
                type="button"
                class="bt-iconbtn"
                data-tooltip="Resume"
                @click="emit('resume', j.id)"
              >
                <Play :size="12" />
              </button>
              <button
                v-if="
                  j.status === 'running' ||
                  j.status === 'queued' ||
                  j.status === 'paused'
                "
                type="button"
                class="bt-iconbtn"
                data-tooltip="Cancel"
                @click="emit('cancel', j.id)"
              >
                <Square :size="12" />
              </button>
              <button
                type="button"
                class="bt-iconbtn"
                data-tooltip="Remove from queue"
                @click="emit('remove', j.id)"
              >
                <X :size="12" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.queue {
  display: flex;
  flex-direction: column;
  background: var(--bt-bg-elevated);
  border-top: 1px solid var(--bt-border);
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.queue--collapsed {
  height: auto !important;
}

.queue__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
  flex: 0 0 auto;
}

.queue__title {
  margin: 0;
  font-size: var(--bt-fs-sm);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--bt-text-muted);
}

.queue__stats {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  font-size: var(--bt-fs-sm);
  color: var(--bt-text-muted);
}

.queue__stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.queue__stat--active {
  color: var(--bt-accent);
}
.queue__stat--ok {
  color: var(--bt-success);
}
.queue__stat--err {
  color: var(--bt-danger);
}
.queue__stat--speed {
  font-family: var(--bt-font-mono);
  color: var(--bt-text);
}

.queue__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.queue__autoclear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px;
  margin-right: 4px;
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.queue__autoclear input {
  margin: 0;
  accent-color: var(--bt-accent);
  cursor: pointer;
}
.queue__autoclear:hover {
  color: var(--bt-text);
}

/* "Max parallel transfers" stepper. Sits in the toolbar between auto-clear
 * and the bulk action buttons. The label is a tabular-nums mono span so the
 * width doesn't twitch when stepping between 1 and 9. */
.queue__concurrency {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 2px;
  margin: 0 4px;
  border-left: 1px solid var(--bt-border);
  border-right: 1px solid var(--bt-border);
}
.queue__concurrency-value {
  display: inline-block;
  min-width: 1.4em;
  padding: 0 4px;
  text-align: center;
  font-size: var(--bt-fs-sm);
  color: var(--bt-text);
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.queue__concurrency .bt-iconbtn[disabled] {
  opacity: 0.35;
  cursor: not-allowed;
}

.queue__body {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
}

.queue__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: var(--bt-fs-sm);
}

.queue__table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  font-weight: 600;
  font-size: var(--bt-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 10px;
  background: var(--bt-bg);
  color: var(--bt-text-muted);
  border-bottom: 1px solid var(--bt-border);
}

.qcol-grip {
  width: 22px;
  padding: 0 !important;
  text-align: center;
}
.qcol-op {
  width: 80px;
}
.qcol-source {
  width: 22%;
}
.qcol-dest {
  width: 22%;
}
.qcol-xferred {
  width: 12%;
  text-align: right;
}
.qcol-time {
  width: 70px;
  text-align: right;
}
.qcol-speed {
  width: 90px;
  text-align: right;
}
.qcol-progress {
  width: 18%;
}
.qcol-actions {
  width: 150px;
  text-align: right;
  white-space: nowrap;
}
.qcol-actions .bt-iconbtn {
  margin-left: 1px;
}
.qcol-actions .bt-iconbtn[disabled] {
  opacity: 0.35;
  cursor: not-allowed;
}
.queue__table thead .qcol-xferred,
.queue__table thead .qcol-time,
.queue__table thead .qcol-speed,
.queue__table thead .qcol-actions {
  text-align: right;
}

.queue__op {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.queue__op-direction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
  flex: 0 0 auto;
}
.queue__op-direction--up {
  background: color-mix(in srgb, var(--bt-accent) 18%, transparent);
  color: var(--bt-accent);
}
.queue__op-direction--down {
  background: color-mix(in srgb, var(--bt-success) 18%, transparent);
  color: var(--bt-success);
}
.queue__op-status {
  display: inline-flex;
  align-items: center;
  color: var(--bt-text-muted);
}

.queue__row td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--bt-border-subtle);
  vertical-align: middle;
}

.queue__row--completed td {
  color: var(--bt-text-muted);
}
.queue__row--failed td {
  color: var(--bt-danger);
}

/* Drag-and-drop reorder visuals.
 * The dragged row is dimmed; the drop target gets a 2px accent line on top
 * or bottom to telegraph exactly where the row will land. We use a box-shadow
 * inset rather than a border so the line doesn't shift the row's geometry. */
.queue__row[draggable="true"] {
  cursor: grab;
}
.queue__row[draggable="true"]:active {
  cursor: grabbing;
}
.queue__row--dragging td {
  opacity: 0.45;
}
.queue__row--drop-before td {
  box-shadow: inset 0 2px 0 var(--bt-accent);
}
.queue__row--drop-after td {
  box-shadow: inset 0 -2px 0 var(--bt-accent);
}
.queue__grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--bt-text-subtle);
}
.queue__row[draggable="true"]:hover .queue__grip {
  color: var(--bt-text);
}

.queue__name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.queue__name-arrow {
  color: var(--bt-text-subtle);
  margin: 0 4px;
}
.queue__direction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: var(--bt-row-hover);
  color: var(--bt-accent);
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  flex: 0 0 auto;
}

.queue__progress {
  position: relative;
  height: 12px;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-sm);
  overflow: hidden;
  font-size: var(--bt-fs-xs);
}
.queue__progress-bar {
  position: absolute;
  inset: 0;
  width: 0;
  background: linear-gradient(
    90deg,
    var(--bt-accent) 0%,
    color-mix(in srgb, var(--bt-accent) 70%, white 30%) 100%
  );
  transition: width 0.18s ease;
}
.queue__progress-label {
  position: relative;
  display: block;
  text-align: center;
  line-height: 12px;
  color: var(--bt-text);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 4px var(--bt-bg-elevated);
}

.queue__row--completed .queue__progress-bar {
  background: var(--bt-success);
}
.queue__row--failed .queue__progress-bar {
  background: var(--bt-danger);
}
.queue__row--paused .queue__progress-bar {
  background: var(--bt-warning);
}

.queue__qcol-eta,
.queue__qcol-speed,
.queue__qcol-size {
  font-variant-numeric: tabular-nums;
}

.queue__error {
  margin-top: 2px;
  font-size: var(--bt-fs-xs);
  color: var(--bt-danger);
}

.queue__muted {
  color: var(--bt-text-subtle);
  font-size: var(--bt-fs-xs);
}

.queue__icon-ok {
  color: var(--bt-success);
}
.queue__icon-err {
  color: var(--bt-danger);
}

.queue__spin {
  animation: bt-q-spin 0.9s linear infinite;
  color: var(--bt-accent);
}
@keyframes bt-q-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.queue__empty {
  padding: 32px;
  color: var(--bt-text-subtle);
  text-align: center;
}
</style>
