<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FileText, Loader2, X } from "@renderer/lib/icons";
import { Save } from "lucide-vue-next";
import { formatBytes } from "@renderer/lib/paths";

type EntryProp = {
  name: string;
  path: string;
  size: number;
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const props = withDefaults(
  defineProps<{
    open: boolean;
    pane: "local" | "remote";
    connectionId?: string | null;
    entry: EntryProp | null;
    maxBytes?: number;
  }>(),
  {
    connectionId: null,
    maxBytes: DEFAULT_MAX_BYTES,
  },
);

const emit = defineEmits<{
  (e: "close", result: { saved: boolean }): void;
  (e: "toast", message: string): void;
}>();

const loading = ref(false);
const loadError = ref<string>("");
const baseline = ref<string>("");
const contents = ref<string>("");
const saving = ref(false);
const savedOnce = ref(false);
const closeArmed = ref(false);

const cursorLine = ref<number>(1);
const cursorCol = ref<number>(1);

const textareaRef = ref<HTMLTextAreaElement | null>(null);

const dirty = computed(() => contents.value !== baseline.value);
const charCount = computed(() => contents.value.length);
const lineCount = computed(() =>
  contents.value.length === 0 ? 1 : contents.value.split("\n").length,
);

function resetState(): void {
  loading.value = false;
  loadError.value = "";
  baseline.value = "";
  contents.value = "";
  saving.value = false;
  savedOnce.value = false;
  closeArmed.value = false;
  cursorLine.value = 1;
  cursorCol.value = 1;
}

async function load(): Promise<void> {
  if (!props.entry) return;
  loading.value = true;
  loadError.value = "";
  try {
    if (props.entry.size > props.maxBytes) {
      loadError.value = `File is too large to edit (${formatBytes(props.entry.size)} > ${formatBytes(props.maxBytes)}).`;
      return;
    }
    let res;
    if (props.pane === "remote") {
      if (!props.connectionId) {
        loadError.value = "No connection";
        return;
      }
      res = await window.api.sftp.readText(
        props.connectionId,
        props.entry.path,
        props.maxBytes,
      );
    } else {
      res = await window.api.fs.local.readText(
        props.entry.path,
        props.maxBytes,
      );
    }
    if (res.ok) {
      baseline.value = res.data;
      contents.value = res.data;
      void nextTick(() => {
        textareaRef.value?.focus();
        updateCursor();
      });
    } else {
      loadError.value = res.error.message;
    }
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.entry?.path] as const,
  ([open]) => {
    if (!open || !props.entry) {
      resetState();
      return;
    }
    resetState();
    void load();
  },
  { immediate: true },
);

async function doSave(): Promise<boolean> {
  if (!props.entry || saving.value) return false;
  saving.value = true;
  try {
    let res;
    if (props.pane === "remote") {
      if (!props.connectionId) {
        emit("toast", "No connection");
        return false;
      }
      res = await window.api.sftp.writeText(
        props.connectionId,
        props.entry.path,
        contents.value,
      );
    } else {
      res = await window.api.fs.local.writeText(
        props.entry.path,
        contents.value,
      );
    }
    if (res.ok) {
      baseline.value = contents.value;
      savedOnce.value = true;
      emit("toast", `Saved ${props.entry.name}`);
      return true;
    }
    emit("toast", `Save failed: ${res.error.message}`);
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveAndClose(): Promise<void> {
  const ok = await doSave();
  if (ok) emit("close", { saved: true });
}

function attemptClose(): void {
  if (dirty.value && !closeArmed.value) {
    closeArmed.value = true;
    emit("toast", "You have unsaved changes — press Close again to discard.");
    setTimeout(() => {
      closeArmed.value = false;
    }, 4000);
    return;
  }
  emit("close", { saved: savedOnce.value });
}

function onBackdropMouseDown(e: MouseEvent): void {
  if (e.target === e.currentTarget) attemptClose();
}

function onTextareaKeydown(e: KeyboardEvent): void {
  // Tab inserts 2 spaces
  if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const ta = e.currentTarget as HTMLTextAreaElement;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = contents.value.slice(0, start);
    const after = contents.value.slice(end);
    const insert = "  ";
    contents.value = before + insert + after;
    void nextTick(() => {
      ta.selectionStart = ta.selectionEnd = start + insert.length;
      updateCursor();
    });
  }
}

function updateCursor(): void {
  const ta = textareaRef.value;
  if (!ta) return;
  const pos = ta.selectionStart;
  const before = contents.value.slice(0, pos);
  const lastNl = before.lastIndexOf("\n");
  const line = before.split("\n").length;
  const col = pos - (lastNl + 1) + 1;
  cursorLine.value = line;
  cursorCol.value = col;
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    attemptClose();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void doSave();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <transition name="bt-cd">
    <div
      v-if="open"
      class="cd-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ed-title"
      @mousedown="onBackdropMouseDown"
    >
      <div class="ed">
        <header class="ed__head">
          <div class="ed__title" id="ed-title">
            <FileText :size="14" />
            <span class="bt-truncate" :title="entry?.name ?? ''">
              {{ entry?.name ?? "Editor" }}
            </span>
            <span v-if="dirty" class="ed__badge">modified</span>
          </div>
          <div class="ed__head-actions">
            <button
              type="button"
              class="bt-btn bt-btn--primary"
              :disabled="!dirty || saving || loading || !!loadError"
              @click="doSave"
            >
              <Save :size="13" />
              <span>Save</span>
            </button>
            <button
              type="button"
              class="bt-btn"
              :disabled="saving || loading || !!loadError"
              @click="saveAndClose"
            >
              Save &amp; Close
            </button>
            <button
              type="button"
              class="bt-btn"
              :disabled="saving"
              @click="attemptClose"
            >
              <X :size="13" />
              <span>Close</span>
            </button>
          </div>
        </header>

        <div class="ed__body">
          <div v-if="loading" class="ed__center">
            <Loader2 :size="20" class="ed__spin" />
            <p>Loading…</p>
          </div>
          <div v-else-if="loadError" class="ed__center ed__center--err">
            <p class="ed__err-msg">{{ loadError }}</p>
            <button type="button" class="bt-btn" @click="emit('close', { saved: savedOnce })">
              Close
            </button>
          </div>
          <textarea
            v-else
            ref="textareaRef"
            v-model="contents"
            class="ed__textarea bt-mono"
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            wrap="off"
            @keydown="onTextareaKeydown"
            @keyup="updateCursor"
            @click="updateCursor"
            @select="updateCursor"
          ></textarea>
        </div>

        <footer class="ed__foot">
          <div class="ed__foot-left bt-mono">
            <span>Ln {{ cursorLine }}, Col {{ cursorCol }}</span>
            <span class="ed__foot-sep">·</span>
            <span>{{ lineCount }} lines</span>
            <span class="ed__foot-sep">·</span>
            <span>{{ charCount }} chars</span>
          </div>
          <div class="ed__foot-right">
            <span v-if="dirty" class="ed__foot-dirty">Unsaved changes</span>
            <span v-else-if="savedOnce" class="ed__foot-saved">Saved</span>
          </div>
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

.ed {
  width: 100%;
  max-width: min(960px, 92vw);
  height: min(640px, 80vh);
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ed__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.ed__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
}
.ed__title .bt-truncate {
  max-width: 360px;
}
.ed__badge {
  display: inline-block;
  padding: 1px 6px;
  font-size: var(--bt-fs-xs);
  font-weight: 500;
  color: var(--bt-warning);
  background: color-mix(in srgb, var(--bt-warning) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--bt-warning) 40%, transparent);
  border-radius: 999px;
}
.ed__head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ed__body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--bt-bg-elevated);
  display: flex;
}

.ed__textarea {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  resize: none;
  border: 0;
  outline: none;
  padding: 10px 12px;
  background: var(--bt-bg-elevated);
  color: var(--bt-text);
  font-size: var(--bt-fs-md);
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}

.ed__center {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--bt-text-muted);
  padding: 20px;
}
.ed__center--err {
  color: var(--bt-danger);
}
.ed__err-msg {
  margin: 0;
  max-width: 520px;
  text-align: center;
  font-size: var(--bt-fs-sm);
}
.ed__spin {
  animation: ed-spin 1s linear infinite;
}
@keyframes ed-spin {
  to {
    transform: rotate(360deg);
  }
}

.ed__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
}
.ed__foot-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ed__foot-sep {
  color: var(--bt-text-subtle);
}
.ed__foot-dirty {
  color: var(--bt-warning);
}
.ed__foot-saved {
  color: var(--bt-success);
}

.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.18s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}
.bt-cd-enter-active .ed,
.bt-cd-leave-active .ed {
  transition: transform 0.18s ease;
}
.bt-cd-enter-from .ed,
.bt-cd-leave-to .ed {
  transform: translateY(8px);
}
</style>
