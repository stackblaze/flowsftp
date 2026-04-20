<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  CheckCircle2,
  Loader2,
  Minus,
  RefreshCw,
  Trash2,
  X,
} from "@renderer/lib/icons";
import { formatBytes, joinRemotePath } from "@renderer/lib/paths";
import type { WalkedEntry } from "@shared/types";

/* ----------------------------------------------------------------------- *
 * WinSCP-style "Synchronize" dialog.
 *
 * The user picks a direction (local→remote, remote→local, both ways) and a
 * comparison criterion (mtime, size, or both), then clicks Compare. We walk
 * both trees recursively, diff them, and surface a per-file "this is what
 * I'll do" list with checkboxes so the user can drop individual rows. On
 * confirm we hand a flat plan back to the parent, which is responsible for
 * actually enqueueing the transfers + deletions.
 *
 * Why split it this way:
 *   - Walks + diff are pure renderer work, nice to keep co-located with the
 *     UI that drives them.
 *   - Enqueueing/deletion needs to dovetail with `confirmAndEnqueue` and the
 *     existing dir-creation machinery in CommanderTab — easier for the
 *     parent to orchestrate than to expose those primitives down here.
 * ----------------------------------------------------------------------- */

export type SyncDirection = "toRemote" | "toLocal" | "both";
export type SyncCompareBy = "size+mtime" | "size" | "mtime";

export type SyncAction =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "skip";

export type SyncItem = {
  relPath: string;
  action: SyncAction;
  reason: string;
  enabled: boolean;
  localSize: number | null;
  remoteSize: number | null;
  localMtimeMs: number | null;
  remoteMtimeMs: number | null;
};

export type SyncPlan = {
  uploads: { src: string; dst: string; size: number }[];
  downloads: { src: string; dst: string; size: number }[];
  /** Absolute local paths to delete (mirror only). */
  deleteLocal: string[];
  /** Absolute remote paths to delete (mirror only). */
  deleteRemote: string[];
  /** Distinct destination directories that must exist before transfers. */
  uploadDirs: string[];
  downloadDirs: string[];
};

const props = defineProps<{
  open: boolean;
  connectionId: string | null;
  localRoot: string;
  remoteRoot: string;
}>();

const emit = defineEmits<{
  (e: "close", result: { action: "cancel" } | { action: "apply"; plan: SyncPlan }): void;
}>();

/* --- Form state ---
 * Persisted to localStorage so the user's preferences stick across sessions
 * — sync settings are the kind of thing you set once and forget. */
const STORE_KEY = "bt:sync:prefs:v1";

type Prefs = {
  direction: SyncDirection;
  compareBy: SyncCompareBy;
  mirror: boolean;
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      direction:
        parsed.direction === "toRemote" ||
        parsed.direction === "toLocal" ||
        parsed.direction === "both"
          ? parsed.direction
          : "toRemote",
      compareBy:
        parsed.compareBy === "size" ||
        parsed.compareBy === "mtime" ||
        parsed.compareBy === "size+mtime"
          ? parsed.compareBy
          : "size+mtime",
      mirror: !!parsed.mirror,
    };
  } catch {
    return defaultPrefs();
  }
}
function defaultPrefs(): Prefs {
  return { direction: "toRemote", compareBy: "size+mtime", mirror: false };
}
function savePrefs(): void {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        direction: form.direction,
        compareBy: form.compareBy,
        mirror: form.mirror,
      } satisfies Prefs),
    );
  } catch {
    /* ignore */
  }
}

const form = reactive<Prefs>(loadPrefs());

watch(
  () => [form.direction, form.compareBy, form.mirror] as const,
  () => savePrefs(),
);

/* --- Scan + diff state --- */
type Phase = "idle" | "scanning" | "ready" | "error";
const phase = ref<Phase>("idle");
const scanError = ref<string | null>(null);
const items = ref<SyncItem[]>([]);

/** Mtime comparison tolerance — SFTP timestamps are second-precision and
 *  some servers round to the nearest 2s. Treating <2s differences as equal
 *  prevents endless "the local copy is 0.4s newer" suggestions. */
const MTIME_TOLERANCE_MS = 2000;

function isSameByCriteria(
  local: WalkedEntry,
  remote: WalkedEntry,
  by: SyncCompareBy,
): boolean {
  if (by === "size") return local.size === remote.size;
  if (by === "mtime") {
    if (local.mtimeMs == null || remote.mtimeMs == null) return false;
    return Math.abs(local.mtimeMs - remote.mtimeMs) <= MTIME_TOLERANCE_MS;
  }
  // "size+mtime": equal only if both match
  if (local.size !== remote.size) return false;
  if (local.mtimeMs == null || remote.mtimeMs == null) return false;
  return Math.abs(local.mtimeMs - remote.mtimeMs) <= MTIME_TOLERANCE_MS;
}

/** Returns 'local' / 'remote' / 'tie' based on mtime; null if either is
 *  missing a timestamp (we then fall back to caller defaults). */
function newerSide(
  local: WalkedEntry,
  remote: WalkedEntry,
): "local" | "remote" | "tie" | null {
  if (local.mtimeMs == null || remote.mtimeMs == null) return null;
  const delta = local.mtimeMs - remote.mtimeMs;
  if (Math.abs(delta) <= MTIME_TOLERANCE_MS) return "tie";
  return delta > 0 ? "local" : "remote";
}

async function runScan(): Promise<void> {
  if (!props.connectionId) {
    scanError.value = "Not connected.";
    phase.value = "error";
    return;
  }
  phase.value = "scanning";
  scanError.value = null;
  items.value = [];

  const [localRes, remoteRes] = await Promise.all([
    window.api.fs.local.walk(props.localRoot),
    window.api.sftp.walk(props.connectionId, props.remoteRoot),
  ]);

  if (!localRes.ok) {
    scanError.value = `Local: ${localRes.error.message}`;
    phase.value = "error";
    return;
  }
  if (!remoteRes.ok) {
    scanError.value = `Remote: ${remoteRes.error.message}`;
    phase.value = "error";
    return;
  }

  const localByPath = new Map<string, WalkedEntry>(
    localRes.data.map((e) => [e.relPath, e]),
  );
  const remoteByPath = new Map<string, WalkedEntry>(
    remoteRes.data.map((e) => [e.relPath, e]),
  );

  const allPaths = new Set<string>();
  for (const e of localRes.data) allPaths.add(e.relPath);
  for (const e of remoteRes.data) allPaths.add(e.relPath);
  const sortedPaths = [...allPaths].sort();

  const dir = form.direction;
  const mirror = form.mirror;
  const by = form.compareBy;

  const computed: SyncItem[] = [];
  for (const rel of sortedPaths) {
    const local = localByPath.get(rel);
    const remote = remoteByPath.get(rel);
    const item = decide({ rel, local, remote, dir, mirror, by });
    computed.push(item);
  }
  items.value = computed;
  phase.value = "ready";
}

function decide(args: {
  rel: string;
  local?: WalkedEntry;
  remote?: WalkedEntry;
  dir: SyncDirection;
  mirror: boolean;
  by: SyncCompareBy;
}): SyncItem {
  const { rel, local, remote, dir, mirror, by } = args;
  const base: SyncItem = {
    relPath: rel,
    action: "skip",
    reason: "",
    enabled: false,
    localSize: local?.size ?? null,
    remoteSize: remote?.size ?? null,
    localMtimeMs: local?.mtimeMs ?? null,
    remoteMtimeMs: remote?.mtimeMs ?? null,
  };

  // Local-only file
  if (local && !remote) {
    if (dir === "toRemote" || dir === "both") {
      return {
        ...base,
        action: "upload",
        reason: "missing on remote",
        enabled: true,
      };
    }
    if (dir === "toLocal" && mirror) {
      return {
        ...base,
        action: "delete-local",
        reason: "extra on local (mirror)",
        enabled: true,
      };
    }
    return { ...base, reason: "local-only (skipped)" };
  }

  // Remote-only file
  if (remote && !local) {
    if (dir === "toLocal" || dir === "both") {
      return {
        ...base,
        action: "download",
        reason: "missing on local",
        enabled: true,
      };
    }
    if (dir === "toRemote" && mirror) {
      return {
        ...base,
        action: "delete-remote",
        reason: "extra on remote (mirror)",
        enabled: true,
      };
    }
    return { ...base, reason: "remote-only (skipped)" };
  }

  if (!local || !remote) return base; // unreachable, but TS-narrowing helper

  // Both sides have it
  if (isSameByCriteria(local, remote, by)) {
    return { ...base, reason: "identical" };
  }

  const newer = newerSide(local, remote);

  // One-way directions are easy: just push the source side wherever
  // there's a difference.
  if (dir === "toRemote") {
    return {
      ...base,
      action: "upload",
      reason:
        newer === "local"
          ? "local is newer"
          : newer === "remote"
            ? "differs (forcing local→remote)"
            : "differs",
      enabled: true,
    };
  }
  if (dir === "toLocal") {
    return {
      ...base,
      action: "download",
      reason:
        newer === "remote"
          ? "remote is newer"
          : newer === "local"
            ? "differs (forcing remote→local)"
            : "differs",
      enabled: true,
    };
  }

  // Both-ways: pick the newer side. Tie / unknown timestamps → mark as a
  // conflict; default to disabled so the user picks consciously.
  if (newer === "local") {
    return {
      ...base,
      action: "upload",
      reason: "local is newer",
      enabled: true,
    };
  }
  if (newer === "remote") {
    return {
      ...base,
      action: "download",
      reason: "remote is newer",
      enabled: true,
    };
  }
  return {
    ...base,
    action: "skip",
    reason:
      newer === "tie"
        ? "different size, same mtime — resolve manually"
        : "differs but timestamps unavailable",
    enabled: false,
  };
}

/* --- Re-scan when form options change after a scan has completed --- */
watch(
  () => [form.direction, form.compareBy, form.mirror],
  () => {
    if (phase.value === "ready" || phase.value === "error") {
      // Rescan only re-runs the diff against the cached walks would be a
      // small win, but for simplicity we just walk again. Big trees are
      // rare in practice and the UX is consistent.
      void runScan();
    }
  },
);

/* --- Reset when dialog opens / closes --- */
watch(
  () => props.open,
  (open) => {
    if (open) {
      phase.value = "idle";
      scanError.value = null;
      items.value = [];
      void nextTick(() => firstActionBtnRef.value?.focus());
    }
  },
);

/* --- Item list ergonomics: filter / counts / select-all --- */
const onlyChanges = ref(true);
const visibleItems = computed<SyncItem[]>(() =>
  onlyChanges.value
    ? items.value.filter((i) => i.action !== "skip" || i.enabled)
    : items.value,
);

const summary = computed(() => {
  const en = items.value.filter((i) => i.enabled);
  const up = en.filter((i) => i.action === "upload").length;
  const down = en.filter((i) => i.action === "download").length;
  const dl = en.filter((i) => i.action === "delete-local").length;
  const dr = en.filter((i) => i.action === "delete-remote").length;
  return { up, down, dl, dr, total: up + down + dl + dr };
});

function toggleAll(value: boolean): void {
  for (const i of visibleItems.value) {
    if (i.action === "skip") continue;
    i.enabled = value;
  }
}

function toggleItem(item: SyncItem): void {
  if (item.action === "skip") return;
  item.enabled = !item.enabled;
}

/* --- Build the plan + emit --- */
function dirOf(p: string): string | null {
  const i = p.lastIndexOf("/");
  if (i <= 0) return null;
  return p.slice(0, i);
}

function joinLocalPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

function buildPlan(): SyncPlan {
  const uploads: SyncPlan["uploads"] = [];
  const downloads: SyncPlan["downloads"] = [];
  const deleteLocal: string[] = [];
  const deleteRemote: string[] = [];
  const uploadDirs = new Set<string>();
  const downloadDirs = new Set<string>();

  for (const i of items.value) {
    if (!i.enabled || i.action === "skip") continue;
    const localAbs = joinLocalPath(props.localRoot, i.relPath);
    const remoteAbs = joinRemotePath(props.remoteRoot, i.relPath);

    if (i.action === "upload") {
      uploads.push({
        src: localAbs,
        dst: remoteAbs,
        size: i.localSize ?? 0,
      });
      const d = dirOf(remoteAbs);
      if (d) uploadDirs.add(d);
      continue;
    }
    if (i.action === "download") {
      downloads.push({
        src: remoteAbs,
        dst: localAbs,
        size: i.remoteSize ?? 0,
      });
      const d = dirOf(localAbs);
      if (d) downloadDirs.add(d);
      continue;
    }
    if (i.action === "delete-local") {
      deleteLocal.push(localAbs);
      continue;
    }
    if (i.action === "delete-remote") {
      deleteRemote.push(remoteAbs);
    }
  }

  return {
    uploads,
    downloads,
    deleteLocal,
    deleteRemote,
    uploadDirs: [...uploadDirs],
    downloadDirs: [...downloadDirs],
  };
}

function onConfirm(): void {
  if (summary.value.total === 0) return;
  emit("close", { action: "apply", plan: buildPlan() });
}

function onCancel(): void {
  emit("close", { action: "cancel" });
}

/* --- Keyboard ergonomics --- */
const firstActionBtnRef = ref<HTMLButtonElement | null>(null);

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

function actionLabel(a: SyncAction): string {
  switch (a) {
    case "upload":
      return "Upload";
    case "download":
      return "Download";
    case "delete-local":
      return "Delete (local)";
    case "delete-remote":
      return "Delete (remote)";
    default:
      return "Skip";
  }
}

function actionClass(a: SyncAction): string {
  switch (a) {
    case "upload":
      return "sd__act sd__act--up";
    case "download":
      return "sd__act sd__act--down";
    case "delete-local":
    case "delete-remote":
      return "sd__act sd__act--del";
    default:
      return "sd__act sd__act--skip";
  }
}

function fmtMtime(ms: number | null): string {
  if (ms == null) return "—";
  try {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "—";
  }
}

function onBackdropMouseDown(e: MouseEvent): void {
  if (e.target === e.currentTarget) onCancel();
}
</script>

<template>
  <transition name="bt-cd">
    <div
      v-if="open"
      class="cd-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sd-title"
      @mousedown="onBackdropMouseDown"
    >
      <div class="sd">
        <header class="sd__head">
          <div class="sd__title" id="sd-title">Synchronize</div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Close"
            @click="onCancel"
          >
            <X :size="14" />
          </button>
        </header>

        <div class="sd__form">
          <div class="sd__paths">
            <div class="sd__path">
              <span class="sd__path-label">Local</span>
              <span class="sd__path-val bt-mono bt-truncate" :title="localRoot">
                {{ localRoot || "—" }}
              </span>
            </div>
            <div class="sd__path">
              <span class="sd__path-label">Remote</span>
              <span
                class="sd__path-val bt-mono bt-truncate"
                :title="remoteRoot"
              >
                {{ remoteRoot || "—" }}
              </span>
            </div>
          </div>

          <fieldset class="sd__group">
            <legend>Direction</legend>
            <label class="sd__radio">
              <input
                type="radio"
                value="toRemote"
                v-model="form.direction"
              />
              <ArrowUpFromLine :size="13" class="sd__radio-icon" />
              <span>Local → Remote</span>
            </label>
            <label class="sd__radio">
              <input type="radio" value="toLocal" v-model="form.direction" />
              <ArrowDownToLine :size="13" class="sd__radio-icon" />
              <span>Remote → Local</span>
            </label>
            <label class="sd__radio">
              <input type="radio" value="both" v-model="form.direction" />
              <RefreshCw :size="13" class="sd__radio-icon" />
              <span>Both directions (newer wins)</span>
            </label>
          </fieldset>

          <fieldset class="sd__group">
            <legend>Compare by</legend>
            <label class="sd__radio">
              <input
                type="radio"
                value="size+mtime"
                v-model="form.compareBy"
              />
              <span>Size + Modified time</span>
            </label>
            <label class="sd__radio">
              <input type="radio" value="size" v-model="form.compareBy" />
              <span>Size only</span>
            </label>
            <label class="sd__radio">
              <input type="radio" value="mtime" v-model="form.compareBy" />
              <span>Modified time only</span>
            </label>
          </fieldset>

          <label class="sd__check">
            <input type="checkbox" v-model="form.mirror" />
            <Trash2 :size="13" class="sd__check-icon" />
            <span>Mirror (delete files missing on the source)</span>
          </label>
        </div>

        <div class="sd__actions">
          <button
            ref="firstActionBtnRef"
            type="button"
            class="bt-btn bt-btn--primary"
            :disabled="!connectionId || phase === 'scanning'"
            @click="runScan"
          >
            <Loader2
              v-if="phase === 'scanning'"
              :size="13"
              class="sd__spin"
            />
            <RefreshCw v-else :size="13" />
            <span>{{
              phase === "scanning"
                ? "Scanning…"
                : phase === "ready" || phase === "error"
                  ? "Re-compare"
                  : "Compare"
            }}</span>
          </button>
          <span v-if="phase === 'ready'" class="sd__summary">
            <CheckCircle2 :size="13" />
            <span>
              {{ items.length }} file{{ items.length === 1 ? "" : "s" }}
              compared,
              <strong>{{ summary.total }}</strong>
              action{{ summary.total === 1 ? "" : "s" }}
              <span v-if="summary.up > 0">· ↑ {{ summary.up }}</span>
              <span v-if="summary.down > 0">· ↓ {{ summary.down }}</span>
              <span v-if="summary.dl > 0">· del {{ summary.dl }} local</span>
              <span v-if="summary.dr > 0">· del {{ summary.dr }} remote</span>
            </span>
          </span>
          <span v-else-if="phase === 'error'" class="sd__error">
            {{ scanError }}
          </span>
        </div>

        <div class="sd__list-head" v-if="phase === 'ready'">
          <label class="sd__filter">
            <input type="checkbox" v-model="onlyChanges" />
            <span>Only show changes</span>
          </label>
          <span class="sd__list-spacer" />
          <button
            type="button"
            class="bt-btn bt-btn--ghost"
            @click="toggleAll(true)"
          >
            Select all
          </button>
          <button
            type="button"
            class="bt-btn bt-btn--ghost"
            @click="toggleAll(false)"
          >
            Select none
          </button>
        </div>

        <div class="sd__list" v-if="phase === 'ready'">
          <div v-if="visibleItems.length === 0" class="sd__empty">
            <CheckCircle2 :size="20" />
            <span>Nothing to do — both sides are in sync.</span>
          </div>
          <table v-else class="sd__table">
            <thead>
              <tr>
                <th class="sd__col-check"></th>
                <th class="sd__col-action">Action</th>
                <th class="sd__col-path">Path</th>
                <th class="sd__col-size">Local</th>
                <th class="sd__col-size">Remote</th>
                <th class="sd__col-reason">Why</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="i in visibleItems"
                :key="i.relPath"
                class="sd__row"
                :class="{
                  'sd__row--dis': i.action === 'skip',
                  'sd__row--off': !i.enabled && i.action !== 'skip',
                }"
                @click="toggleItem(i)"
              >
                <td class="sd__col-check">
                  <input
                    type="checkbox"
                    :checked="i.enabled"
                    :disabled="i.action === 'skip'"
                    @click.stop="toggleItem(i)"
                  />
                </td>
                <td>
                  <span :class="actionClass(i.action)">
                    <ArrowUp
                      v-if="i.action === 'upload'"
                      :size="11"
                    />
                    <ArrowDown
                      v-else-if="i.action === 'download'"
                      :size="11"
                    />
                    <Trash2
                      v-else-if="
                        i.action === 'delete-local' ||
                        i.action === 'delete-remote'
                      "
                      :size="11"
                    />
                    <Minus v-else :size="11" />
                    {{ actionLabel(i.action) }}
                  </span>
                </td>
                <td class="sd__col-path bt-mono bt-truncate" :title="i.relPath">
                  {{ i.relPath }}
                </td>
                <td class="sd__col-size">
                  <template v-if="i.localSize != null">
                    <div>{{ formatBytes(i.localSize) }}</div>
                    <div class="sd__mtime">{{ fmtMtime(i.localMtimeMs) }}</div>
                  </template>
                  <template v-else>—</template>
                </td>
                <td class="sd__col-size">
                  <template v-if="i.remoteSize != null">
                    <div>{{ formatBytes(i.remoteSize) }}</div>
                    <div class="sd__mtime">
                      {{ fmtMtime(i.remoteMtimeMs) }}
                    </div>
                  </template>
                  <template v-else>—</template>
                </td>
                <td class="sd__col-reason">{{ i.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="phase === 'idle'" class="sd__hint">
          <p>
            Pick a direction above and click <strong>Compare</strong> to scan
            both sides.
          </p>
        </div>

        <footer class="sd__foot">
          <button type="button" class="bt-btn" @click="onCancel">Cancel</button>
          <button
            type="button"
            class="bt-btn bt-btn--primary"
            :disabled="phase !== 'ready' || summary.total === 0"
            @click="onConfirm"
          >
            Synchronize ({{ summary.total }})
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
.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.16s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}

.sd {
  width: 100%;
  max-width: 960px;
  max-height: calc(100vh - 48px);
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sd__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.sd__title {
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
}

.sd__form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 18px;
  padding: 14px 16px 6px;
}
.sd__paths {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.sd__path {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sd__path-label {
  font-size: var(--bt-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--bt-text-muted);
}
.sd__path-val {
  font-size: var(--bt-fs-sm);
  color: var(--bt-text);
  background: var(--bt-bg);
  padding: 4px 8px;
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
}

.sd__group {
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
  padding: 8px 10px 6px;
  margin: 0;
}
.sd__group legend {
  font-size: var(--bt-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--bt-text-muted);
  padding: 0 4px;
}
.sd__radio,
.sd__check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: var(--bt-fs-sm);
  color: var(--bt-text);
  cursor: pointer;
}
.sd__radio input,
.sd__check input {
  margin: 0;
}
.sd__radio-icon,
.sd__check-icon {
  color: var(--bt-text-muted);
  flex: 0 0 auto;
}
.sd__check {
  grid-column: 1 / -1;
  padding: 4px 2px 6px;
}

.sd__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 16px 10px;
  flex-wrap: wrap;
}
.sd__summary {
  font-size: var(--bt-fs-sm);
  color: var(--bt-text-muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sd__summary strong {
  color: var(--bt-text);
}
.sd__error {
  font-size: var(--bt-fs-sm);
  color: var(--bt-danger, #d33);
}
.sd__spin {
  animation: sd-spin 1s linear infinite;
}
@keyframes sd-spin {
  to {
    transform: rotate(360deg);
  }
}

.sd__list-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-top: 1px solid var(--bt-border-subtle);
  background: var(--bt-bg);
}
.sd__filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--bt-fs-sm);
  color: var(--bt-text);
  cursor: pointer;
}
.sd__list-spacer {
  flex: 1 1 auto;
}

.sd__list {
  flex: 1 1 auto;
  min-height: 200px;
  max-height: 50vh;
  overflow: auto;
  background: var(--bt-panel);
  border-top: 1px solid var(--bt-border-subtle);
}
.sd__hint {
  flex: 0 0 auto;
  padding: 24px;
  text-align: center;
  color: var(--bt-text-muted);
}

.sd__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--bt-text-muted);
}

.sd__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--bt-fs-sm);
}
.sd__table thead th {
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
.sd__col-check {
  width: 28px;
  text-align: center;
}
.sd__col-action {
  width: 110px;
}
.sd__col-size {
  width: 110px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: var(--bt-text-muted);
}
.sd__col-reason {
  width: 200px;
  color: var(--bt-text-muted);
}
.sd__col-path {
  min-width: 0;
}

.sd__row {
  cursor: pointer;
  border-bottom: 1px solid var(--bt-border-subtle);
}
.sd__row:hover {
  background: var(--bt-row-hover);
}
.sd__row td {
  padding: 4px 10px;
  vertical-align: middle;
}
.sd__row--off {
  opacity: 0.55;
}
.sd__row--dis {
  opacity: 0.45;
  cursor: default;
}

.sd__act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: var(--bt-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-weight: 600;
}
.sd__act--up {
  background: rgba(0, 122, 204, 0.18);
  color: var(--bt-accent);
}
.sd__act--down {
  background: rgba(53, 173, 53, 0.18);
  color: #2a8a2a;
}
.sd__act--del {
  background: rgba(220, 60, 60, 0.16);
  color: #c5392f;
}
.sd__act--skip {
  background: var(--bt-bg);
  color: var(--bt-text-muted);
}
.sd__mtime {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
}

.sd__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}
</style>
