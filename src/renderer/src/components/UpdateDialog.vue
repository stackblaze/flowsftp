<script setup lang="ts">
/**
 * Software-update dialog. Pure projection of `UpdateState` — every status
 * gets its own message, primary action, and (optionally) progress bar.
 *
 *   idle / not-available / dev-disabled  → "Check for updates" button
 *   checking                              → spinner
 *   available                             → version + "Download" (or
 *                                           "Downloading…" if auto-DL on)
 *   downloading                           → progress bar + speed
 *   downloaded                            → "Restart now" / "Later"
 *   error                                 → message + "Try again"
 *
 * The dialog is intentionally narrow on choices: the user never sees more
 * than one primary action at a time, mirroring how Slack/VS Code handle
 * updates.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  Download,
  Loader2,
  RefreshCw,
  X,
} from "@renderer/lib/icons";
import type { UpdateState } from "@shared/types";

const props = defineProps<{
  open: boolean;
  state: UpdateState;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "check"): void;
  (e: "download"): void;
  (e: "install"): void;
}>();

const primaryBtnRef = ref<HTMLButtonElement | null>(null);

const isBusy = computed<boolean>(
  () =>
    props.state.status === "checking" ||
    props.state.status === "downloading" ||
    (props.state.status === "available" && props.state.autoDownloading),
);

const title = computed<string>(() => {
  switch (props.state.status) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update available: ${props.state.version}`;
    case "downloading":
      return `Downloading update ${props.state.version}…`;
    case "downloaded":
      return `Update ready: ${props.state.version}`;
    case "not-available":
      return "You're up to date";
    case "error":
      return "Update error";
    case "dev-disabled":
      return "Updates unavailable in dev";
    case "idle":
    default:
      return "Software update";
  }
});

const message = computed<string>(() => {
  const cur = props.state.currentVersion || "this build";
  switch (props.state.status) {
    case "checking":
      return `Looking for a newer release than ${cur}…`;
    case "available":
      return props.state.autoDownloading
        ? `Found ${props.state.version}. Download is starting automatically.`
        : `A newer release is available. Download to install when ready.`;
    case "downloading":
      return `Downloading at ${formatRate(props.state.bytesPerSecond)}.`;
    case "downloaded":
      return `Version ${props.state.version} has been downloaded. Restart Synctron to finish installing.`;
    case "not-available":
      return `Version ${cur} is the latest.`;
    case "error":
      return (
        props.state.message ||
        "Something went wrong while checking for updates."
      );
    case "dev-disabled":
      return "This is a development build. Auto-update is only available in packaged builds.";
    case "idle":
    default:
      return `Currently running ${cur}.`;
  }
});

const iconComponent = computed(() => {
  switch (props.state.status) {
    case "available":
    case "downloading":
      return CloudDownload;
    case "downloaded":
      return CheckCircle2;
    case "checking":
      return Loader2;
    case "error":
      return AlertCircle;
    case "not-available":
      return CheckCircle2;
    case "dev-disabled":
      return AlertCircle;
    default:
      return RefreshCw;
  }
});

const iconClass = computed<string>(() => {
  switch (props.state.status) {
    case "error":
      return "ud__icon ud__icon--danger";
    case "downloaded":
    case "not-available":
      return "ud__icon ud__icon--success";
    case "dev-disabled":
      return "ud__icon ud__icon--warning";
    case "checking":
      return "ud__icon ud__icon--spin";
    default:
      return "ud__icon ud__icon--accent";
  }
});

const releaseNotes = computed<string | null>(() => {
  if (
    props.state.status === "available" ||
    props.state.status === "downloaded"
  ) {
    return props.state.releaseNotes ?? null;
  }
  return null;
});

const progress = computed(() => {
  if (props.state.status !== "downloading") return null;
  return {
    percent: props.state.percent,
    transferred: props.state.transferred,
    total: props.state.total,
  };
});

function formatRate(bps: number): string {
  if (!bps || !Number.isFinite(bps)) return "—";
  return `${formatBytes(bps)}/s`;
}
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function close(): void {
  emit("close");
}

function onPrimary(): void {
  switch (props.state.status) {
    case "available":
      if (!props.state.autoDownloading) emit("download");
      return;
    case "downloaded":
      emit("install");
      return;
    case "error":
    case "not-available":
    case "idle":
    default:
      emit("check");
      return;
  }
}

const primaryLabel = computed<string>(() => {
  switch (props.state.status) {
    case "checking":
      return "Checking…";
    case "available":
      return props.state.autoDownloading
        ? "Downloading…"
        : `Download ${props.state.version}`;
    case "downloading":
      return `Downloading… ${props.state.percent}%`;
    case "downloaded":
      return "Restart & install";
    case "error":
      return "Try again";
    case "not-available":
      return "Check again";
    case "dev-disabled":
      return "Close";
    case "idle":
    default:
      return "Check for updates";
  }
});

const primaryDisabled = computed<boolean>(() => {
  if (props.state.status === "checking" || props.state.status === "downloading")
    return true;
  if (props.state.status === "available" && props.state.autoDownloading)
    return true;
  return false;
});

const primaryIcon = computed(() => {
  switch (props.state.status) {
    case "available":
    case "downloading":
      return Download;
    case "downloaded":
      return RefreshCw;
    default:
      return null;
  }
});

const dismissLabel = computed<string>(() => {
  if (props.state.status === "downloaded") return "Later";
  return "Close";
});

function onBackdropMouseDown(e: MouseEvent): void {
  if (e.target !== e.currentTarget) return;
  if (isBusy.value) return; // don't allow accidental dismiss mid-download
  close();
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape" && !isBusy.value) {
    e.preventDefault();
    close();
  } else if (e.key === "Enter" && !primaryDisabled.value) {
    e.preventDefault();
    onPrimary();
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void nextTick(() => primaryBtnRef.value?.focus());
  },
  { immediate: true },
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

const showPrimary = computed<boolean>(
  () => props.state.status !== "dev-disabled",
);
</script>

<template>
  <transition name="bt-cd">
    <div
      v-if="open"
      class="cd-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ud-title"
      @mousedown="onBackdropMouseDown"
    >
      <div class="ud">
        <header class="ud__head">
          <div id="ud-title" class="ud__title">{{ title }}</div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Close"
            :disabled="isBusy"
            @click="close"
          >
            <X :size="14" />
          </button>
        </header>

        <div class="ud__body">
          <component :is="iconComponent" :size="28" :class="iconClass" />
          <div class="ud__text">
            <p class="ud__message">{{ message }}</p>

            <div v-if="progress" class="ud__progress">
              <div class="ud__bar" :style="{ width: progress.percent + '%' }" />
              <div class="ud__progress-meta">
                <span>{{ progress.percent }}%</span>
                <span>
                  {{ formatBytes(progress.transferred) }} /
                  {{ formatBytes(progress.total) }}
                </span>
              </div>
            </div>

            <details v-if="releaseNotes" class="ud__notes">
              <summary>Release notes</summary>
              <!-- Release notes come from the publisher's own manifest. Render
                   as plain text rather than HTML to side-step XSS even if a
                   release pipeline starts shipping richer payloads later. -->
              <pre class="ud__notes-body">{{ releaseNotes }}</pre>
            </details>
          </div>
        </div>

        <footer class="ud__foot">
          <button
            type="button"
            class="bt-btn"
            :disabled="isBusy"
            @click="close"
          >
            {{ dismissLabel }}
          </button>
          <button
            v-if="showPrimary"
            ref="primaryBtnRef"
            type="button"
            class="bt-btn bt-btn--primary ud__primary"
            :disabled="primaryDisabled"
            :aria-busy="primaryDisabled"
            @click="onPrimary"
          >
            <Loader2 v-if="primaryDisabled" :size="13" class="ud__spin" />
            <component :is="primaryIcon" v-else-if="primaryIcon" :size="13" />
            <span>{{ primaryLabel }}</span>
          </button>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.cd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 7700;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.ud {
  width: 100%;
  max-width: 480px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ud__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.ud__title {
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
}

.ud__body {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 18px 18px 14px;
}
.ud__icon {
  flex: 0 0 auto;
  margin-top: 2px;
}
.ud__icon--danger {
  color: var(--bt-danger);
}
.ud__icon--warning {
  color: var(--bt-warning);
}
.ud__icon--success {
  color: var(--bt-success, #2ea043);
}
.ud__icon--accent {
  color: var(--bt-accent);
}
.ud__icon--spin {
  color: var(--bt-accent);
  animation: ud-spin 1s linear infinite;
}

.ud__text {
  min-width: 0;
  flex: 1 1 auto;
}
.ud__message {
  margin: 0;
  color: var(--bt-text);
  font-size: var(--bt-fs-md);
  line-height: 1.45;
}

.ud__progress {
  margin-top: 12px;
  height: 8px;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border-subtle);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}
.ud__bar {
  height: 100%;
  background: var(--bt-accent);
  transition: width 0.18s ease;
}
.ud__progress-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  font-variant-numeric: tabular-nums;
}

.ud__notes {
  margin-top: 12px;
  font-size: var(--bt-fs-sm);
  color: var(--bt-text-muted);
}
.ud__notes summary {
  cursor: pointer;
  user-select: none;
  color: var(--bt-text);
  font-weight: 500;
}
.ud__notes-body {
  margin-top: 8px;
  padding: 10px;
  max-height: 180px;
  overflow-y: auto;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
  white-space: pre-wrap;
  font-family: inherit;
  font-size: var(--bt-fs-sm);
  color: var(--bt-text);
}

.ud__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}
.ud__primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ud__spin {
  animation: ud-spin 1s linear infinite;
}
@keyframes ud-spin {
  to {
    transform: rotate(360deg);
  }
}

.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.18s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}
.bt-cd-enter-active .ud,
.bt-cd-leave-active .ud {
  transition: transform 0.18s ease;
}
.bt-cd-enter-from .ud,
.bt-cd-leave-to .ud {
  transform: translateY(8px);
}
</style>
