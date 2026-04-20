<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Copy,
  FileDigit,
  FileIcon,
  Folder,
  Link2,
  PencilLine,
  Settings,
  Shield,
  X,
} from "@renderer/lib/icons";
import { formatBytes } from "@renderer/lib/paths";
import { formatDateTime } from "@renderer/lib/format";
import type { FileStat, HashAlgorithm } from "@shared/types";

type EntryType = "file" | "dir" | "link" | "other";

type EntryProp = {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  mtimeMs: number | null;
};

const props = defineProps<{
  open: boolean;
  pane: "local" | "remote";
  connectionId?: string | null;
  entry: EntryProp | null;
}>();

const emit = defineEmits<{
  (e: "close", result: { changed: boolean }): void;
  (e: "toast", message: string): void;
}>();

const stat = ref<FileStat | null>(null);
const statLoading = ref(false);
const statError = ref<string>("");

const renameInput = ref<string>("");
const renameBusy = ref(false);

const originalMode = ref<number>(0);
const currentMode = ref<number>(0);
const chmodBusy = ref(false);

const currentName = ref<string>("");
const currentPath = ref<string>("");

const changed = ref(false);

const copyJustClicked = ref(false);

const renameInputRef = ref<HTMLInputElement | null>(null);

/* --- Checksum state -----------------------------------------------------
 * Per-algorithm slot: holds the computed digest, the in-flight state, and
 * a per-row "Copied" pulse so multiple Copy buttons don't share one flash.
 * We deliberately key by `currentPath` so renaming the file invalidates
 * the cached digests (paths differ → results re-loaded). */
type HashState = {
  digest: string | null;
  busy: boolean;
  error: string;
  copyJust: boolean;
};

function makeHashState(): HashState {
  return { digest: null, busy: false, error: "", copyJust: false };
}

const hashes = ref<Record<HashAlgorithm, HashState>>({
  md5: makeHashState(),
  sha1: makeHashState(),
  sha256: makeHashState(),
});

function resetHashes(): void {
  hashes.value = {
    md5: makeHashState(),
    sha1: makeHashState(),
    sha256: makeHashState(),
  };
}

const canHash = computed(
  () => props.entry?.type === "file" && (props.pane === "local" || !!props.connectionId),
);

const algoLabel = (a: HashAlgorithm): string =>
  a === "md5" ? "MD5" : a === "sha1" ? "SHA-1" : "SHA-256";

async function computeHash(alg: HashAlgorithm): Promise<void> {
  if (!props.entry || !canHash.value) return;
  const slot = hashes.value[alg];
  if (slot.busy) return;
  slot.busy = true;
  slot.error = "";
  try {
    const path = currentPath.value;
    const res =
      props.pane === "remote"
        ? await window.api.sftp.hash(props.connectionId as string, path, alg)
        : await window.api.fs.local.hash(path, alg);
    if (res.ok) {
      slot.digest = res.data;
    } else {
      slot.error = res.error.message;
    }
  } finally {
    slot.busy = false;
  }
}

async function copyHash(alg: HashAlgorithm): Promise<void> {
  const slot = hashes.value[alg];
  if (!slot.digest) return;
  try {
    await navigator.clipboard.writeText(slot.digest);
    slot.copyJust = true;
    setTimeout(() => (slot.copyJust = false), 1200);
  } catch {
    emit("toast", "Failed to copy checksum to clipboard");
  }
}

const isPosix = computed(() => props.pane === "remote" || !isWindowsPath(currentPath.value));

const parentDir = computed(() => parentPath(currentPath.value, isPosix.value));

const sep = computed(() => (isPosix.value ? "/" : "\\"));

const trimmedRename = computed(() => renameInput.value.trim());

const renameInvalidChar = computed(() => /[\\/]/.test(trimmedRename.value));

const canRename = computed(
  () =>
    !renameBusy.value &&
    trimmedRename.value.length > 0 &&
    trimmedRename.value !== currentName.value &&
    !renameInvalidChar.value,
);

const canApplyChmod = computed(
  () =>
    props.pane === "remote" &&
    stat.value !== null &&
    !chmodBusy.value &&
    currentMode.value !== originalMode.value,
);

const busy = computed(() => statLoading.value || renameBusy.value || chmodBusy.value);

const typeLabel = computed(() => {
  if (!props.entry) return "";
  if (stat.value?.isSymbolicLink) return "Symbolic link";
  switch (props.entry.type) {
    case "dir":
      return "Directory";
    case "link":
      return "Symbolic link";
    case "file":
      return "File";
    case "other":
    default:
      return "Other";
  }
});

const typeIcon = computed(() => {
  if (!props.entry) return FileIcon;
  if (props.entry.type === "dir") return Folder;
  if (props.entry.type === "link") return Link2;
  return FileIcon;
});

const sizeLabel = computed(() => {
  if (!props.entry) return "—";
  if (props.entry.type === "dir") return "—";
  return `${formatBytes(props.entry.size)} (${props.entry.size.toLocaleString()} bytes)`;
});

const modifiedLabel = computed(() => {
  const ts = props.entry?.mtimeMs ?? stat.value?.mtimeMs ?? null;
  return ts == null ? "—" : formatDateTime(ts);
});

const octal = computed(() => octalString(currentMode.value));
const perms = computed(() => permString(currentMode.value));

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function parentPath(p: string, posix: boolean): string {
  if (!p) return posix ? "/" : "";
  if (posix) {
    if (p === "/") return "/";
    const n = p.replace(/\/$/, "");
    const i = n.lastIndexOf("/");
    if (i <= 0) return "/";
    return n.slice(0, i) || "/";
  }
  const norm = p.replace(/\//g, "\\");
  const m = norm.match(/^(.*)[\\]([^\\]+)$/);
  if (!m) return norm;
  if (m[1].endsWith(":")) return `${m[1]}\\`;
  return m[1];
}

function joinPath(parent: string, name: string, posix: boolean): string {
  if (posix) {
    if (parent === "/" || parent === "") return `/${name}`.replace(/\/+/g, "/");
    return `${parent.replace(/\/$/, "")}/${name}`.replace(/\/+/g, "/");
  }
  if (/[\\/]$/.test(parent)) return `${parent}${name}`;
  return `${parent}\\${name}`;
}

function permString(mode: number): string {
  const chars = ["r", "w", "x"];
  let out = "";
  for (let i = 8; i >= 0; i--) {
    if ((mode & (1 << i)) !== 0) {
      out += chars[2 - (i % 3)];
    } else {
      out += "-";
    }
  }
  return out;
}

function octalString(mode: number): string {
  const m = mode & 0o777;
  return `0${m.toString(8).padStart(3, "0")}`;
}

function setBit(mode: number, bitIndex: number, on: boolean): number {
  const mask = 1 << bitIndex;
  return on ? (mode | mask) : (mode & ~mask);
}

function bitForRowCol(row: number, col: number): number {
  // row 0=Owner, 1=Group, 2=Other; col 0=Read, 1=Write, 2=Execute
  // Owner R=8, W=7, X=6 ; Group R=5,W=4,X=3 ; Other R=2,W=1,X=0
  return (2 - row) * 3 + (2 - col);
}

function isBitOn(row: number, col: number): boolean {
  return (currentMode.value & (1 << bitForRowCol(row, col))) !== 0;
}

function toggleBit(row: number, col: number, on: boolean): void {
  currentMode.value = setBit(currentMode.value, bitForRowCol(row, col), on);
}

async function loadStat(): Promise<void> {
  if (!props.entry) return;
  statLoading.value = true;
  statError.value = "";
  stat.value = null;
  try {
    let res;
    if (props.pane === "remote") {
      if (!props.connectionId) {
        statError.value = "No connection";
        return;
      }
      res = await window.api.sftp.stat(props.connectionId, currentPath.value);
    } else {
      res = await window.api.fs.local.stat(currentPath.value);
    }
    if (res.ok) {
      stat.value = res.data;
      originalMode.value = res.data.mode & 0o777;
      currentMode.value = originalMode.value;
    } else {
      statError.value = res.error.message;
    }
  } finally {
    statLoading.value = false;
  }
}

function resetState(): void {
  stat.value = null;
  statLoading.value = false;
  statError.value = "";
  renameBusy.value = false;
  chmodBusy.value = false;
  originalMode.value = 0;
  currentMode.value = 0;
  changed.value = false;
  resetHashes();
}

watch(
  () => [props.open, props.entry?.path] as const,
  async ([open]) => {
    if (!open || !props.entry) {
      resetState();
      return;
    }
    currentName.value = props.entry.name;
    currentPath.value = props.entry.path;
    renameInput.value = props.entry.name;
    changed.value = false;
    await loadStat();
    void nextTick(() => renameInputRef.value?.focus());
    // Auto-compute MD5 for files. SHA-256 stays on demand so we don't
    // pay for a second full read (especially noticeable for remote files
    // where every byte hits the wire). MD5 is the one users most often
    // want for quick "is this the same file?" comparisons.
    if (canHash.value) void computeHash("md5");
  },
  { immediate: true },
);

async function copyPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(currentPath.value);
    copyJustClicked.value = true;
    setTimeout(() => (copyJustClicked.value = false), 1200);
  } catch {
    emit("toast", "Failed to copy path to clipboard");
  }
}

async function doRename(): Promise<void> {
  if (!canRename.value || !props.entry) return;
  const oldPath = currentPath.value;
  const newName = trimmedRename.value;
  const newPath = joinPath(parentDir.value, newName, isPosix.value);
  renameBusy.value = true;
  try {
    let res;
    if (props.pane === "remote") {
      if (!props.connectionId) {
        emit("toast", "No connection");
        return;
      }
      res = await window.api.sftp.rename(props.connectionId, oldPath, newPath);
    } else {
      res = await window.api.fs.local.rename(oldPath, newPath);
    }
    if (res.ok) {
      currentName.value = newName;
      currentPath.value = newPath;
      changed.value = true;
      resetHashes();
      emit("toast", `Renamed to ${newName}`);
    } else {
      emit("toast", `Rename failed: ${res.error.message}`);
    }
  } finally {
    renameBusy.value = false;
  }
}

async function applyChmod(): Promise<void> {
  if (!canApplyChmod.value) return;
  if (props.pane !== "remote" || !props.connectionId) return;
  chmodBusy.value = true;
  try {
    const res = await window.api.sftp.chmod(
      props.connectionId,
      currentPath.value,
      currentMode.value,
    );
    if (res.ok) {
      originalMode.value = currentMode.value;
      changed.value = true;
      emit("toast", `Permissions updated (${octalString(currentMode.value)})`);
    } else {
      emit("toast", `chmod failed: ${res.error.message}`);
    }
  } finally {
    chmodBusy.value = false;
  }
}

function close(): void {
  emit("close", { changed: changed.value });
}

function onBackdropMouseDown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

const ROWS = ["Owner", "Group", "Other"] as const;
const COLS = ["Read", "Write", "Execute"] as const;
</script>

<template>
  <transition name="bt-cd">
    <div
      v-if="open"
      class="cd-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="props-title"
      @mousedown="onBackdropMouseDown"
    >
      <div class="props">
        <header class="props__head">
          <div class="props__title" id="props-title">
            <Settings :size="14" />
            <span>Properties — </span>
            <span class="bt-truncate" :title="currentName">{{ currentName }}</span>
          </div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Close"
            @click="close"
          >
            <X :size="14" />
          </button>
        </header>

        <div class="props__body">
          <!-- Basic info -->
          <section class="props__section">
            <div class="props__name-row">
              <component :is="typeIcon" :size="20" class="props__type-icon" />
              <span class="props__name bt-truncate" :title="currentName">{{
                currentName
              }}</span>
            </div>

            <dl class="props__grid">
              <dt>Path</dt>
              <dd>
                <span class="props__path bt-mono bt-truncate" :title="currentPath">
                  {{ currentPath }}
                </span>
                <button
                  type="button"
                  class="bt-iconbtn props__copy"
                  :data-tooltip="copyJustClicked ? 'Copied' : 'Copy path'"
                  @click="copyPath"
                >
                  <Copy :size="12" />
                </button>
              </dd>

              <dt>Type</dt>
              <dd>{{ typeLabel }}</dd>

              <dt>Size</dt>
              <dd>{{ sizeLabel }}</dd>

              <dt>Modified</dt>
              <dd>{{ modifiedLabel }}</dd>
            </dl>

            <div v-if="statLoading" class="props__loading">Loading details…</div>
            <div v-else-if="statError" class="props__error">
              Failed to load file details: {{ statError }}
            </div>
          </section>

          <!-- Rename -->
          <section class="props__section">
            <h4 class="props__h">
              <PencilLine :size="13" />
              <span>Rename</span>
            </h4>
            <div class="props__rename-row">
              <input
                ref="renameInputRef"
                v-model="renameInput"
                class="bt-input bt-grow"
                spellcheck="false"
                autocomplete="off"
                :disabled="busy"
                @keydown.enter.prevent="doRename"
              />
              <button
                type="button"
                class="bt-btn"
                :disabled="!canRename"
                @click="doRename"
              >
                Rename
              </button>
            </div>
            <div v-if="renameInvalidChar" class="props__hint props__hint--warn">
              Name cannot contain {{ sep }} characters.
            </div>
          </section>

          <!-- Permissions (remote only) -->
          <section v-if="pane === 'remote' && stat" class="props__section">
            <h4 class="props__h">
              <Shield :size="13" />
              <span>Permissions</span>
            </h4>

            <div class="props__perm-summary">
              <span class="bt-mono props__perm-octal">{{ octal }}</span>
              <span class="bt-mono props__perm-string">{{ perms }}</span>
            </div>

            <div class="props__perm-grid">
              <div></div>
              <div
                v-for="c in COLS"
                :key="c"
                class="props__perm-colhead"
              >
                {{ c }}
              </div>

              <template v-for="(row, ri) in ROWS" :key="row">
                <div class="props__perm-rowhead">{{ row }}</div>
                <label
                  v-for="(_col, ci) in COLS"
                  :key="`${row}-${ci}`"
                  class="props__perm-cell"
                >
                  <input
                    type="checkbox"
                    :checked="isBitOn(ri, ci)"
                    :disabled="chmodBusy"
                    @change="
                      (e) =>
                        toggleBit(
                          ri,
                          ci,
                          (e.target as HTMLInputElement).checked,
                        )
                    "
                  />
                </label>
              </template>
            </div>

            <div class="props__perm-actions">
              <button
                type="button"
                class="bt-btn bt-btn--primary"
                :disabled="!canApplyChmod"
                @click="applyChmod"
              >
                Apply permissions
              </button>
              <button
                type="button"
                class="bt-btn"
                :disabled="
                  chmodBusy || currentMode === originalMode
                "
                @click="currentMode = originalMode"
              >
                Reset
              </button>
            </div>
          </section>

          <!-- Checksums (files only) -->
          <section v-if="canHash" class="props__section">
            <h4 class="props__h">
              <FileDigit :size="13" />
              <span>Checksums</span>
            </h4>
            <p class="props__hint">
              {{
                pane === "remote"
                  ? "Streams the entire file from the server."
                  : "Reads the file from disk."
              }}
            </p>
            <div class="props__hash-list">
              <div
                v-for="alg in (['md5', 'sha256'] as HashAlgorithm[])"
                :key="alg"
                class="props__hash-row"
              >
                <span class="props__hash-label">{{ algoLabel(alg) }}</span>
                <span
                  v-if="hashes[alg].digest"
                  class="props__hash-value bt-mono bt-truncate"
                  :title="hashes[alg].digest!"
                >
                  {{ hashes[alg].digest }}
                </span>
                <span
                  v-else-if="hashes[alg].busy"
                  class="props__hash-value props__hash-value--muted"
                >
                  Computing…
                </span>
                <span
                  v-else-if="hashes[alg].error"
                  class="props__hash-value props__hash-value--error bt-truncate"
                  :title="hashes[alg].error"
                >
                  {{ hashes[alg].error }}
                </span>
                <span
                  v-else
                  class="props__hash-value props__hash-value--muted"
                >
                  Click Compute &rarr;
                </span>
                <div class="props__hash-actions">
                  <button
                    type="button"
                    class="bt-iconbtn"
                    :data-tooltip="
                      hashes[alg].copyJust ? 'Copied' : 'Copy checksum'
                    "
                    :disabled="!hashes[alg].digest"
                    @click="copyHash(alg)"
                  >
                    <Copy :size="12" />
                  </button>
                  <button
                    type="button"
                    class="bt-btn props__hash-btn"
                    :class="{
                      'bt-btn--primary':
                        !hashes[alg].digest && !hashes[alg].busy,
                    }"
                    :disabled="hashes[alg].busy"
                    @click="computeHash(alg)"
                  >
                    {{
                      hashes[alg].busy
                        ? "Computing…"
                        : hashes[alg].digest
                          ? "Recompute"
                          : "Compute"
                    }}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer class="props__foot">
          <button type="button" class="bt-btn" :disabled="busy" @click="close">
            Close
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
  z-index: 7600;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.props {
  width: 100%;
  max-width: 520px;
  max-height: calc(100vh - 80px);
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.props__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.props__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
  min-width: 0;
}
.props__title .bt-truncate {
  max-width: 320px;
}

.props__body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.props__section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.props__h {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 2px;
  font-size: var(--bt-fs-sm);
  font-weight: 600;
  color: var(--bt-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.props__name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--bt-border-subtle);
}
.props__type-icon {
  color: var(--bt-text-muted);
  flex: 0 0 auto;
}
.props__name {
  font-size: var(--bt-fs-lg);
  font-weight: 600;
  color: var(--bt-text);
}

.props__grid {
  display: grid;
  grid-template-columns: 90px 1fr;
  row-gap: 4px;
  column-gap: 12px;
  margin: 0;
  font-size: var(--bt-fs-sm);
}
.props__grid dt {
  color: var(--bt-text-muted);
}
.props__grid dd {
  margin: 0;
  color: var(--bt-text);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.props__path {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--bt-text);
}
.props__copy {
  flex: 0 0 auto;
}

.props__loading {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
}
.props__error {
  font-size: var(--bt-fs-xs);
  color: var(--bt-danger);
}

.props__rename-row {
  display: flex;
  gap: 8px;
}

.props__hint {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
}
.props__hint--warn {
  color: var(--bt-warning);
}

.props__perm-summary {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: var(--bt-fs-sm);
}
.props__perm-octal {
  font-weight: 600;
  color: var(--bt-text);
}
.props__perm-string {
  color: var(--bt-text-muted);
}

.props__perm-grid {
  display: grid;
  grid-template-columns: 80px repeat(3, 1fr);
  align-items: center;
  gap: 6px 12px;
  padding: 8px 10px;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
  width: fit-content;
}
.props__perm-colhead {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  text-align: center;
}
.props__perm-rowhead {
  font-size: var(--bt-fs-sm);
  color: var(--bt-text);
}
.props__perm-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.props__perm-cell input {
  cursor: pointer;
}

.props__perm-actions {
  display: inline-flex;
  gap: 8px;
  margin-top: 4px;
}

.props__hash-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.props__hash-row {
  display: grid;
  grid-template-columns: 64px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
  min-width: 0;
}
.props__hash-label {
  font-size: var(--bt-fs-xs);
  font-weight: 600;
  color: var(--bt-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.props__hash-value {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text);
  min-width: 0;
}
.props__hash-value--muted {
  color: var(--bt-text-muted);
  font-style: italic;
}
.props__hash-value--error {
  color: var(--bt-danger);
}
.props__hash-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.props__hash-btn {
  font-size: var(--bt-fs-xs);
  padding: 2px 8px;
  min-width: 80px;
}

.props__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}

.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.18s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}
.bt-cd-enter-active .props,
.bt-cd-leave-active .props {
  transition: transform 0.18s ease;
}
.bt-cd-enter-from .props,
.bt-cd-leave-to .props {
  transform: translateY(8px);
}
</style>
