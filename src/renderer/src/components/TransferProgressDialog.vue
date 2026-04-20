<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  CheckCircle2,
  CircleDashed,
  Pause,
  Play,
  Square,
  Upload,
  Download,
  X,
} from "@renderer/lib/icons";
import { fileName, formatBytes } from "@renderer/lib/paths";
import { formatEta, formatPercent, formatSpeed } from "@renderer/lib/format";

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
  bytesPerSec: number;
  /** When false, the user has dismissed the window for this run. */
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "pause", id: string): void;
  (e: "resume", id: string): void;
  (e: "cancel", id: string): void;
  (e: "cancelAll"): void;
  (e: "update:autoClose", value: boolean): void;
}>();

const autoClose = ref<boolean>(loadAutoClose());

function loadAutoClose(): boolean {
  try {
    return localStorage.getItem("bt:transfer:autoClose") !== "0";
  } catch {
    return true;
  }
}
watch(autoClose, (v) => {
  try {
    localStorage.setItem("bt:transfer:autoClose", v ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit("update:autoClose", v);
});

/** Reactive 1Hz tick so elapsed/eta refresh smoothly. */
const tick = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => tick.value++, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

/* The "current" job is the most recently active one.
 *
 * Priority:
 *  1. A job that's currently running.
 *  2. The id of the *last* job we saw running, even if it has since moved to
 *     a terminal state (completed/failed/cancelled). This keeps the dialog
 *     sitting on the "100% Done" view after a transfer instead of immediately
 *     snapping to "0% Queued" if any pending job happens to exist (duplicate
 *     enqueue, stale prior-session job, or a real follow-up).
 *  3. Otherwise the next paused/queued job — for the case where the user
 *     opened the dialog before anything started.
 *
 * The sticky id is updated by a watcher (a computed must stay pure).
 */
const lastActiveId = ref<string | null>(null);
watch(
  () => props.jobs.find((j) => j.status === "running")?.id ?? null,
  (id) => {
    if (id) lastActiveId.value = id;
  },
  { immediate: true },
);
/* When the dialog is reopened, refresh sticky pick to whatever's freshest. */
watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    const running = props.jobs.find((j) => j.status === "running");
    if (running) lastActiveId.value = running.id;
  },
);

const currentJob = computed<Job | null>(() => {
  const running = props.jobs.find((j) => j.status === "running");
  if (running) return running;
  if (lastActiveId.value) {
    const last = props.jobs.find((j) => j.id === lastActiveId.value);
    if (last) return last;
  }
  return (
    props.jobs.find((j) => j.status === "paused") ??
    props.jobs.find((j) => j.status === "queued") ??
    null
  );
});

const activeJobs = computed(() => props.jobs.filter((j) => j.status === "running"));
const queuedAhead = computed(() =>
  props.jobs.filter((j) =>
    ["queued", "paused", "running"].includes(j.status),
  ),
);

/**
 * Jobs that belong to the *current* multi-file wave for the overall bar.
 * `queuedAhead` alone drops each file as soon as it hits `completed`, so
 * the total byte denominator shrinks and the next file starts at 0 bytes —
 * the percentage snaps backward (flicker). We keep a contiguous window
 * from the first leading `completed` run before any active job through
 * the last trailing `completed` after the last active job (typical queue
 * layout during a folder copy with concurrency).
 */
const overallBatchJobs = computed(() => {
  const list = props.jobs;
  const activeIx = list
    .map((j, i) =>
      ["queued", "paused", "running"].includes(j.status) ? i : -1,
    )
    .filter((i) => i >= 0);
  if (activeIx.length === 0) return [];

  let lo = Math.min(...activeIx);
  let hi = Math.max(...activeIx);
  while (lo > 0 && list[lo - 1].status === "completed") lo--;
  while (hi + 1 < list.length && list[hi + 1].status === "completed") hi++;

  return list
    .slice(lo, hi + 1)
    .filter((j) =>
      ["queued", "paused", "running", "completed"].includes(j.status),
    );
});

const totalActiveBytes = computed(() =>
  overallBatchJobs.value.reduce((s, j) => s + j.size, 0),
);
const totalActiveTransferred = computed(() =>
  overallBatchJobs.value.reduce((s, j) => {
    if (j.status === "completed") return s + j.size;
    return s + Math.min(j.transferred, j.size);
  }, 0),
);

const overallPct = computed(() => {
  const total = totalActiveBytes.value;
  if (total === 0) return 0;
  return Math.min(100, (totalActiveTransferred.value / total) * 100);
});

const perJobSpeed = computed(() => {
  if (activeJobs.value.length === 0) return 0;
  return props.bytesPerSec / activeJobs.value.length;
});

const elapsedMs = computed<number>(() => {
  // depend on tick to refresh
  void tick.value;
  const j = currentJob.value;
  if (!j || !j.startedAt) return 0;
  const end = j.finishedAt ?? Date.now();
  return Math.max(0, end - j.startedAt);
});

const elapsedString = computed(() => formatHms(elapsedMs.value / 1000));

const remainingSeconds = computed<number | null>(() => {
  const j = currentJob.value;
  if (!j || j.status !== "running") return null;
  const speed = perJobSpeed.value;
  if (speed <= 0) return null;
  const remaining = Math.max(0, j.size - j.transferred);
  return remaining / speed;
});

function formatHms(seconds: number): string {
  const totalSec = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => n.toString().padStart(2, "0")).join(":");
}

const allDone = computed(() => {
  if (props.jobs.length === 0) return false;
  return props.jobs.every(
    (j) =>
      j.status === "completed" ||
      j.status === "failed" ||
      j.status === "cancelled",
  );
});

function onPauseCurrent(): void {
  const j = currentJob.value;
  if (!j) return;
  if (j.status === "running" || j.status === "queued") emit("pause", j.id);
  else if (j.status === "paused") emit("resume", j.id);
}

function onCancelCurrent(): void {
  const j = currentJob.value;
  if (!j) return;
  emit("cancel", j.id);
}

function onClose(): void {
  emit("close");
}

const direction = computed(() => currentJob.value?.kind ?? "upload");
const titlePct = computed(() => {
  const j = currentJob.value;
  if (!j) return 0;
  if (j.status === "completed") return 100;
  if (j.status === "cancelled") return 0;
  if (!j.size) return 0;
  return Math.floor((j.transferred / j.size) * 100);
});
const titleAction = computed(() => {
  const j = currentJob.value;
  if (!j) return "Transfer";
  if (allDone.value) return "Done";
  if (j.status === "completed") return "Completed";
  if (j.status === "failed") return "Failed";
  if (j.status === "cancelled") return "Cancelled";
  if (j.status === "paused") return "Paused";
  if (j.status === "queued") return "Queued";
  return j.kind === "upload" ? "Uploading" : "Downloading";
});

/* Width and label for the per-file progress bar. Lock to 100% on completion
 * so the bar doesn't visibly snap back if the final SFTP `step` callback
 * was throttled out. */
function fileBarWidth(j: Job): string {
  if (j.status === "completed") return "100%";
  if (j.status === "cancelled") return "0%";
  return formatPercent(j.transferred, j.size);
}
function fileBarLabel(j: Job): string {
  if (j.status === "completed") return "100%";
  if (j.status === "cancelled") return "—";
  return formatPercent(j.transferred, j.size, 0);
}
</script>

<template>
  <transition name="bt-tp">
    <div
      v-if="visible && jobs.length > 0"
      class="tp-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tp-title"
      @mousedown.self="onClose"
    >
      <div class="tp" :class="{ 'tp--done': allDone }">
        <header class="tp__head">
          <div class="tp__title" id="tp-title">
            <CircleDashed
              v-if="currentJob && currentJob.status === 'running'"
              :size="14"
              class="tp__spin"
            />
            <CheckCircle2
              v-else-if="
                allDone ||
                (currentJob && currentJob.status === 'completed')
              "
              :size="14"
              class="tp__icon-ok"
            />
            <Pause
              v-else-if="currentJob && currentJob.status === 'paused'"
              :size="14"
            />
            <Upload v-else-if="direction === 'upload'" :size="14" />
            <Download v-else :size="14" />
            <span>
              <strong>{{ titlePct }}%</strong>
              {{ titleAction }}
            </span>
          </div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Hide window"
            @click="onClose"
          >
            <X :size="14" />
          </button>
        </header>

        <div v-if="currentJob" class="tp__body">
          <div class="tp__row">
            <span class="tp__lbl">File</span>
            <span class="tp__val bt-truncate" :title="currentJob.src">
              <span class="tp__file-icon">
                <Upload v-if="currentJob.kind === 'upload'" :size="13" />
                <Download v-else :size="13" />
              </span>
              {{ currentJob.src }}
            </span>
          </div>
          <div class="tp__row">
            <span class="tp__lbl">Target</span>
            <span class="tp__val bt-truncate" :title="currentJob.dst">
              {{ currentJob.dst }}
            </span>
          </div>

          <!-- Per-file progress -->
          <div
            class="tp__bar tp__bar--file"
            :class="{
              'tp__bar--done': currentJob.status === 'completed',
              'tp__bar--err': currentJob.status === 'failed',
            }"
          >
            <div
              class="tp__bar-fill"
              :style="{ width: fileBarWidth(currentJob) }"
            />
            <span class="tp__bar-label">
              {{ fileBarLabel(currentJob) }} · {{ fileName(currentJob.src) }}
            </span>
          </div>

          <div class="tp__stats">
            <div class="tp__stat">
              <span class="tp__lbl">Time left</span>
              <span class="tp__val bt-mono">{{
                formatEta(remainingSeconds)
              }}</span>
            </div>
            <div class="tp__stat">
              <span class="tp__lbl">Time elapsed</span>
              <span class="tp__val bt-mono">{{ elapsedString }}</span>
            </div>
            <div class="tp__stat">
              <span class="tp__lbl">Bytes transferred</span>
              <span class="tp__val bt-mono">
                {{ formatBytes(currentJob.transferred) }}
                <span class="tp__muted">
                  / {{ formatBytes(currentJob.size) }}
                </span>
              </span>
            </div>
            <div class="tp__stat">
              <span class="tp__lbl">Speed</span>
              <span class="tp__val bt-mono">
                {{
                  currentJob.status === "running"
                    ? formatSpeed(perJobSpeed)
                    : "—"
                }}
              </span>
            </div>
          </div>

          <!-- Overall queue progress -->
          <div v-if="overallBatchJobs.length > 1" class="tp__overall">
            <div class="tp__overall-lbl">
              Overall ({{ overallBatchJobs.length }} files,
              {{ formatBytes(totalActiveTransferred) }} /
              {{ formatBytes(totalActiveBytes) }})
            </div>
            <div class="tp__bar tp__bar--overall">
              <div
                class="tp__bar-fill tp__bar-fill--overall"
                :style="{ width: overallPct + '%' }"
              />
              <span class="tp__bar-label">{{ Math.floor(overallPct) }}%</span>
            </div>
          </div>
        </div>

        <footer class="tp__foot">
          <div class="tp__foot-left">
            <button
              type="button"
              class="bt-btn"
              :disabled="!currentJob"
              @click="onPauseCurrent"
            >
              <Play
                v-if="currentJob && currentJob.status === 'paused'"
                :size="13"
              />
              <Pause v-else :size="13" />
              <span>
                {{
                  currentJob && currentJob.status === "paused"
                    ? "Resume"
                    : "Pause"
                }}
              </span>
            </button>
            <button
              type="button"
              class="bt-btn"
              :disabled="!currentJob"
              @click="onCancelCurrent"
            >
              <Square :size="13" />
              <span>Cancel</span>
            </button>
            <button
              type="button"
              class="bt-btn bt-btn--danger"
              :disabled="queuedAhead.length === 0"
              @click="emit('cancelAll')"
            >
              <X :size="13" />
              <span>Cancel all</span>
            </button>
          </div>

          <label class="tp__autoclose">
            <input v-model="autoClose" type="checkbox" />
            <span>Close when finished</span>
          </label>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.tp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 7000;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.tp {
  width: 100%;
  max-width: 560px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}

.tp__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--bt-fs-md);
  color: var(--bt-text);
}
.tp__title strong {
  font-weight: 700;
  margin-right: 4px;
}

.tp__icon-ok {
  color: var(--bt-success);
}

.tp__spin {
  animation: bt-tp-spin 0.9s linear infinite;
  color: var(--bt-accent);
}
@keyframes bt-tp-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.tp__body {
  padding: 14px 16px 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tp__row {
  display: grid;
  grid-template-columns: 88px 1fr;
  align-items: center;
  gap: 10px;
  font-size: var(--bt-fs-sm);
}
.tp__lbl {
  color: var(--bt-text-muted);
}
.tp__val {
  color: var(--bt-text);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tp__file-icon {
  color: var(--bt-text-muted);
  flex: 0 0 auto;
}

.tp__bar {
  position: relative;
  height: 18px;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-sm);
  overflow: hidden;
  margin-top: 4px;
}
.tp__bar-fill {
  position: absolute;
  inset: 0;
  width: 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--bt-success) 80%, var(--bt-accent) 20%) 0%,
    var(--bt-success) 100%
  );
  transition: width 0.18s ease;
}
.tp__bar--done .tp__bar-fill {
  background: var(--bt-success);
}
.tp__bar--err .tp__bar-fill {
  background: var(--bt-danger);
}
.tp__bar-fill--overall {
  background: linear-gradient(
    90deg,
    var(--bt-accent) 0%,
    color-mix(in srgb, var(--bt-accent) 70%, white 30%) 100%
  );
}
.tp__bar-label {
  position: relative;
  display: block;
  text-align: center;
  line-height: 18px;
  color: var(--bt-text);
  font-variant-numeric: tabular-nums;
  font-size: var(--bt-fs-xs);
  text-shadow: 0 0 4px var(--bt-bg-elevated);
}

.tp__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  margin-top: 6px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--bt-border-subtle);
}
.tp__stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--bt-fs-sm);
}
.tp__muted {
  color: var(--bt-text-muted);
}

.tp__overall {
  margin-top: 4px;
  margin-bottom: 16px;
  border-top: 1px solid var(--bt-border-subtle);
  padding-top: 8px;
}
.tp__overall-lbl {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  margin-bottom: 2px;
}

.tp__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}
.tp__foot-left {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.tp__autoclose {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-sm);
  cursor: pointer;
  user-select: none;
}

.bt-tp-enter-active,
.bt-tp-leave-active {
  transition: opacity 0.18s ease;
}
.bt-tp-enter-from,
.bt-tp-leave-to {
  opacity: 0;
}
.bt-tp-enter-active .tp,
.bt-tp-leave-active .tp {
  transition: transform 0.18s ease;
}
.bt-tp-enter-from .tp,
.bt-tp-leave-to .tp {
  transform: translateY(8px);
}
</style>
