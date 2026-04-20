<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import type { LocalListEntry, RemoteListEntry } from "@shared/types";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCopy,
  Copy,
  Edit3,
  ExternalLink,
  FileText,
  FolderPlus,
  Info,
  PencilLine,
  Scissors,
  Shield,
  Trash2,
} from "@renderer/lib/icons";

type AnyEntry = LocalListEntry | RemoteListEntry;

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  pane: "local" | "remote";
  entry: AnyEntry | null;
  selectionCount: number;
}>();

/**
 * Action vocabulary:
 *
 *   Local pane  → Upload N (F5)             / Move N to host…  (F6)
 *   Remote pane → Download N (F5) / Save as…  / Move N to local… (F6)
 *
 * Every cross-pane transfer goes to the *opposite* pane's current directory.
 * The redundant "Upload to…" / "Download to…" entries were removed because
 * they pretended to open a folder picker but actually did the same thing as
 * the primary action — which made the menu read as two near-identical verbs.
 *
 * `copy` is now exposed only on the remote pane, single-selection, as
 * "Save as…" — the one case where a destination dialog is genuinely useful
 * (renaming the file during download). For multi-selection there's no
 * sensible single rename, so the entry is hidden.
 *
 * Side-specific actions: `permissions` (chmod) on remote, `showInFolder`
 * (reveal in Finder/Explorer) on local.
 */
type CtxAction =
  | "open"
  | "edit"
  | "transferNow"
  | "copy"
  | "move"
  | "delete"
  | "rename"
  | "clipboard"
  | "permissions"
  | "showInFolder"
  | "mkdir"
  | "properties";

const emit = defineEmits<{
  (e: CtxAction): void;
  (e: "close"): void;
}>();

function onWindowMouseDown(e: MouseEvent): void {
  if (!props.open) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest("[data-bt-context]")) return;
  emit("close");
}

function onKey(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  window.addEventListener("mousedown", onWindowMouseDown);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onWindowMouseDown);
  window.removeEventListener("keydown", onKey);
});

function pick(action: CtxAction): void {
  emit(action);
  emit("close");
}

const revealLabel = computed<string>(() => {
  switch (window.api?.app?.platform) {
    case "darwin":
      return "Reveal in Finder";
    case "win32":
      return "Show in Explorer";
    default:
      return "Open in file manager";
  }
});
</script>

<template>
  <teleport to="body">
    <div
      v-if="open && entry"
      data-bt-context
      class="ctxmenu"
      :style="{ left: x + 'px', top: y + 'px' }"
      role="menu"
    >
      <div v-if="selectionCount > 1" class="ctxmenu__header">
        {{ selectionCount }} items selected
      </div>

      <button
        v-if="selectionCount <= 1"
        type="button"
        class="ctxmenu__item"
        @click="pick('open')"
      >
        <FileText :size="12" />
        <span class="ctxmenu__label">Open</span>
      </button>

      <button
        v-if="entry && entry.type === 'file'"
        type="button"
        class="ctxmenu__item"
        @click="pick('edit')"
      >
        <PencilLine :size="12" />
        <span class="ctxmenu__label">Edit</span>
        <span class="ctxmenu__kbd">F4</span>
      </button>

      <div class="ctxmenu__sep" />

      <button
        type="button"
        class="ctxmenu__item ctxmenu__item--accent"
        :disabled="!entry"
        @click="pick('transferNow')"
      >
        <ArrowDownToLine v-if="pane === 'remote'" :size="12" />
        <ArrowUpFromLine v-else :size="12" />
        <span class="ctxmenu__label">
          {{
            pane === "local"
              ? selectionCount > 1
                ? `Upload ${selectionCount}`
                : "Upload"
              : selectionCount > 1
                ? `Download ${selectionCount}`
                : "Download"
          }}
        </span>
        <span class="ctxmenu__kbd">F5</span>
      </button>
      <button
        v-if="pane === 'remote' && selectionCount <= 1"
        type="button"
        class="ctxmenu__item"
        :disabled="!entry || entry.type !== 'file'"
        @click="pick('copy')"
      >
        <Copy :size="12" />
        <span class="ctxmenu__label">Save as…</span>
      </button>
      <button
        type="button"
        class="ctxmenu__item"
        :disabled="!entry"
        @click="pick('move')"
      >
        <Scissors :size="12" />
        <span class="ctxmenu__label">
          {{ pane === "local" ? "Move to host…" : "Move to local…" }}
        </span>
        <span class="ctxmenu__kbd">F6</span>
      </button>
      <button
        type="button"
        class="ctxmenu__item ctxmenu__item--danger"
        :disabled="!entry"
        @click="pick('delete')"
      >
        <Trash2 :size="12" />
        <span class="ctxmenu__label">
          {{ selectionCount > 1 ? `Delete ${selectionCount}` : "Delete" }}
        </span>
        <span class="ctxmenu__kbd">Del</span>
      </button>
      <button
        type="button"
        class="ctxmenu__item"
        :disabled="selectionCount > 1 || !entry"
        @click="pick('rename')"
      >
        <Edit3 :size="12" />
        <span class="ctxmenu__label">Rename</span>
        <span class="ctxmenu__kbd">F2</span>
      </button>

      <div class="ctxmenu__sep" />

      <button
        v-if="pane === 'remote'"
        type="button"
        class="ctxmenu__item"
        :disabled="selectionCount > 1 || !entry || entry.type !== 'file'"
        @click="pick('permissions')"
      >
        <Shield :size="12" />
        <span class="ctxmenu__label">Permissions…</span>
      </button>
      <button
        v-if="pane === 'local'"
        type="button"
        class="ctxmenu__item"
        :disabled="selectionCount > 1 || !entry"
        @click="pick('showInFolder')"
      >
        <ExternalLink :size="12" />
        <span class="ctxmenu__label">
          {{ revealLabel }}
        </span>
      </button>
      <button
        type="button"
        class="ctxmenu__item"
        :disabled="!entry"
        @click="pick('clipboard')"
      >
        <ClipboardCopy :size="12" />
        <span class="ctxmenu__label">
          {{ pane === "local" ? "Copy local path" : "Copy remote path" }}
        </span>
        <span class="ctxmenu__kbd">Ctrl+C</span>
      </button>

      <div class="ctxmenu__sep" />

      <button type="button" class="ctxmenu__item" @click="pick('mkdir')">
        <FolderPlus :size="12" />
        <span class="ctxmenu__label">New folder…</span>
        <span class="ctxmenu__kbd">F7</span>
      </button>

      <div class="ctxmenu__sep" />

      <button
        type="button"
        class="ctxmenu__item"
        :disabled="!entry"
        @click="pick('properties')"
      >
        <Info :size="12" />
        <span class="ctxmenu__label">Properties</span>
        <span class="ctxmenu__kbd">F9</span>
      </button>
    </div>
  </teleport>
</template>

<style>
/* Menu density matches the file rows (--bt-h-row 26px) and toolbar (30px)
 * so the popup feels like part of the pane rather than a separate, blown-up
 * surface. Font drops to --bt-fs-sm (12px), padding tightens, and icons step
 * down from 13px to 12px to balance with the smaller text. */
.ctxmenu {
  position: fixed;
  z-index: 6000;
  min-width: 200px;
  padding: 3px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-sm);
  box-shadow: var(--bt-shadow-lg);
  font-size: var(--bt-fs-sm);
  line-height: 1.2;
}
.ctxmenu__header {
  padding: 4px 8px 2px;
  font-size: var(--bt-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--bt-text-muted);
}
.ctxmenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--bt-text);
  border-radius: var(--bt-radius-sm);
  cursor: pointer;
  font-size: var(--bt-fs-sm);
  text-align: left;
  white-space: nowrap;
}
.ctxmenu__item :deep(svg) {
  flex: 0 0 auto;
  color: var(--bt-text-muted);
}
.ctxmenu__item:hover:not(:disabled) :deep(svg),
.ctxmenu__item--danger:hover:not(:disabled) :deep(svg) {
  color: inherit;
}
.ctxmenu__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctxmenu__kbd {
  flex: 0 0 auto;
  margin-left: auto;
  padding-left: 14px;
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  font-variant-numeric: tabular-nums;
}
.ctxmenu__item:hover:not(:disabled) {
  background: var(--bt-accent);
  color: #fff;
}
.ctxmenu__item:hover:not(:disabled) .ctxmenu__kbd {
  color: rgba(255, 255, 255, 0.85);
}
.ctxmenu__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ctxmenu__item--danger:hover:not(:disabled) {
  background: var(--bt-danger);
  color: #fff;
}
.ctxmenu__item--accent {
  font-weight: 600;
}
.ctxmenu__item--accent:not(:hover):not(:disabled) :deep(svg) {
  color: var(--bt-accent);
}
.ctxmenu__sep {
  height: 1px;
  background: var(--bt-border);
  margin: 3px 2px;
}
</style>
