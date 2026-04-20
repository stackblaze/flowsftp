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
import type { LocalListEntry, RemoteListEntry } from "@shared/types";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronUp,
  FolderPlus,
  Home,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
} from "@renderer/lib/icons";
import {
  genericFolderIconUrl,
  iconUrlForEntry,
} from "@renderer/lib/file-icons";
import { fileName, formatBytes } from "@renderer/lib/paths";
import { formatDateTime } from "@renderer/lib/format";
import { typeLabelForEntry } from "@renderer/lib/file-types";
import { useTabsStore, type SortCol, type SortState } from "@renderer/stores/tabs";
import PathBar from "./PathBar.vue";
import PaneContextMenu from "./PaneContextMenu.vue";

type AnyEntry = LocalListEntry | RemoteListEntry;

/* All multi-select / sort / hidden fields are optional here so this prop
 * remains assignable from CommanderTab's narrower TabState type (CommanderTab
 * is owned by another agent and has not been updated to include the new
 * fields). At runtime the store always populates them, but at the type
 * boundary we tolerate the older shape and fall back to defaults. */
type TabState = {
  id: string;
  sessionId: string | null;
  title: string;
  connectionId: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  localPath: string;
  remotePath: string;
  localEntries: LocalListEntry[];
  remoteEntries: RemoteListEntry[];
  selectedLocal: string | null;
  selectedRemote: string | null;
  selectedLocalSet?: string[];
  selectedRemoteSet?: string[];
  focusedLocal?: string | null;
  focusedRemote?: string | null;
  sortLocal?: SortState;
  sortRemote?: SortState;
  showHiddenLocal?: boolean;
  showHiddenRemote?: boolean;
  statusMessage: string;
};

const DEFAULT_SORT: SortState = { col: "name", dir: "asc" };

/* --- Columns: definitions, sizing, visibility --- */
type ColKey = "name" | "size" | "type" | "mtime" | "perm";
type ColumnDef = {
  key: ColKey;
  label: string;
  sortKey: SortCol;
  defaultWidth: number;
  minWidth: number;
  align?: "left" | "right";
  remoteOnly?: boolean;
  /** Pinned columns can't be hidden via the header right-click menu. */
  pinned?: boolean;
};

const COLUMNS: ColumnDef[] = [
  {
    key: "name",
    label: "Name",
    sortKey: "name",
    defaultWidth: 320,
    minWidth: 140,
    pinned: true,
  },
  {
    key: "size",
    label: "Size",
    sortKey: "size",
    defaultWidth: 90,
    minWidth: 60,
    align: "right",
  },
  {
    key: "type",
    label: "Type",
    sortKey: "type",
    defaultWidth: 170,
    minWidth: 80,
  },
  {
    key: "mtime",
    label: "Modified",
    sortKey: "mtime",
    defaultWidth: 170,
    minWidth: 90,
  },
  {
    key: "perm",
    label: "Perms",
    sortKey: "perm",
    defaultWidth: 90,
    minWidth: 60,
    remoteOnly: true,
  },
];

const props = defineProps<{
  pane: "local" | "remote";
  tab: TabState;
}>();

/* Per-pane column prefs (widths + hidden set), persisted in localStorage so
 * the user's layout sticks across sessions. Each pane (local/remote) owns
 * its own key — the two panes show different default columns (perm is
 * remote-only) so it would be confusing to share one preference. */
type ColPrefs = {
  widths: Partial<Record<ColKey, number>>;
  hidden: ColKey[];
};

const PREFS_VERSION = 1;
const prefsStorageKey = computed(
  () => `bt:pane:${props.pane}:cols:v${PREFS_VERSION}`,
);

function loadPrefs(): ColPrefs {
  try {
    const raw = localStorage.getItem(prefsStorageKey.value);
    if (!raw) return { widths: {}, hidden: [] };
    const parsed = JSON.parse(raw) as Partial<ColPrefs>;
    const widths: Partial<Record<ColKey, number>> = {};
    if (parsed.widths && typeof parsed.widths === "object") {
      for (const c of COLUMNS) {
        const v = (parsed.widths as Record<string, unknown>)[c.key];
        if (typeof v === "number" && Number.isFinite(v) && v >= c.minWidth) {
          widths[c.key] = v;
        }
      }
    }
    const hidden: ColKey[] = Array.isArray(parsed.hidden)
      ? (parsed.hidden.filter(
          (k): k is ColKey =>
            typeof k === "string" &&
            COLUMNS.some((c) => c.key === k && !c.pinned),
        ) as ColKey[])
      : [];
    return { widths, hidden };
  } catch {
    return { widths: {}, hidden: [] };
  }
}

const colPrefs = reactive<ColPrefs>(loadPrefs());

/* Re-hydrate when the pane prop changes (shouldn't happen in practice, but
 * keeps the component robust against future reuse). */
watch(prefsStorageKey, () => {
  const fresh = loadPrefs();
  colPrefs.widths = fresh.widths;
  colPrefs.hidden = fresh.hidden;
});

function savePrefs(): void {
  try {
    localStorage.setItem(
      prefsStorageKey.value,
      JSON.stringify({
        widths: colPrefs.widths,
        hidden: colPrefs.hidden,
      }),
    );
  } catch {
    /* localStorage unavailable / quota — non-fatal */
  }
}

function widthFor(c: ColumnDef): number {
  return colPrefs.widths[c.key] ?? c.defaultWidth;
}

function isColumnHidden(c: ColumnDef): boolean {
  if (c.pinned) return false;
  return colPrefs.hidden.includes(c.key);
}

const visibleColumns = computed<ColumnDef[]>(() =>
  COLUMNS.filter(
    (c) => (!c.remoteOnly || isRemote.value) && !isColumnHidden(c),
  ),
);

/** Toggleable columns shown in the header context menu (excludes pinned
 *  and excludes remote-only columns when rendering in the local pane). */
const toggleableColumns = computed<ColumnDef[]>(() =>
  COLUMNS.filter((c) => !c.pinned && (!c.remoteOnly || isRemote.value)),
);

const totalColumnsWidth = computed(() =>
  visibleColumns.value.reduce((acc, c) => acc + widthFor(c), 0),
);

/* The container's content width — tracked via ResizeObserver so the table
 * can stretch to fill it when columns sum to less than the viewport, and
 * grow beyond it (with horizontal scroll) when the user widens columns. */
const listWidth = ref(0);
let listResizeObserver: ResizeObserver | null = null;

const tableWidth = computed(() =>
  Math.max(totalColumnsWidth.value, listWidth.value),
);

/* --- Column resize (drag the right edge of a header) --- */
type ResizeState = {
  key: ColKey;
  startX: number;
  startWidth: number;
  minWidth: number;
};
let resize: ResizeState | null = null;
/* Click-suppression: when a drag actually happened, the subsequent click on
 * the th would trigger sort. Track recent resizes so we can swallow that. */
let resizeJustEnded = false;

function startResize(e: MouseEvent, c: ColumnDef): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  resize = {
    key: c.key,
    startX: e.clientX,
    startWidth: widthFor(c),
    minWidth: c.minWidth,
  };
  document.body.style.cursor = "col-resize";
  document.body.classList.add("bt-col-resizing");
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeEnd, { once: true });
}

function onResizeMove(e: MouseEvent): void {
  if (!resize) return;
  const next = Math.max(
    resize.minWidth,
    Math.round(resize.startWidth + (e.clientX - resize.startX)),
  );
  colPrefs.widths[resize.key] = next;
}

function onResizeEnd(): void {
  if (!resize) return;
  resize = null;
  resizeJustEnded = true;
  /* Reset on the next macrotask so the trailing `click` event on the th
   * (which fires after mouseup) sees the flag and gets ignored. */
  setTimeout(() => {
    resizeJustEnded = false;
  }, 0);
  document.body.style.cursor = "";
  document.body.classList.remove("bt-col-resizing");
  window.removeEventListener("mousemove", onResizeMove);
  savePrefs();
}

/* --- Header right-click menu (show / hide columns) --- */
type HeaderMenuState = { open: boolean; x: number; y: number };
const headerMenu = reactive<HeaderMenuState>({ open: false, x: 0, y: 0 });

function openHeaderMenu(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  headerMenu.open = true;
  headerMenu.x = e.clientX;
  headerMenu.y = e.clientY;
}

function closeHeaderMenu(): void {
  headerMenu.open = false;
}

function toggleColumnVisibility(c: ColumnDef): void {
  if (c.pinned) return;
  const idx = colPrefs.hidden.indexOf(c.key);
  if (idx >= 0) colPrefs.hidden.splice(idx, 1);
  else colPrefs.hidden.push(c.key);
  savePrefs();
}

function resetColumnPrefs(): void {
  colPrefs.widths = {};
  colPrefs.hidden = [];
  savePrefs();
  closeHeaderMenu();
}

function onHeaderMenuOutsideMouseDown(e: MouseEvent): void {
  if (!headerMenu.open) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest("[data-bt-header-menu]")) return;
  closeHeaderMenu();
}

function onHeaderMenuKeydown(e: KeyboardEvent): void {
  if (!headerMenu.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeHeaderMenu();
  }
}

const emit = defineEmits<{
  (e: "navigate", path: string): void;
  (e: "goUp"): void;
  (e: "goHome"): void;
  (e: "refresh"): void;
  (e: "select", path: string): void;
  (e: "activate", entry: AnyEntry): void;
  (e: "upload"): void;
  (e: "download", localDst: string): void;
  (e: "move"): void;
  /** Multi-select transfer to the opposite pane's current dir without
   *  prompting for a destination. CommanderTab does the actual enqueue. */
  (e: "transferNow"): void;
  /** Files dropped from the operating system (or another app). */
  (e: "dropFiles", paths: string[]): void;
  /** A row from the OPPOSITE pane (same tab) was dropped onto this pane.
   *  Direction can be derived from `props.pane`: drop on local = download,
   *  drop on remote = upload. The source-pane selection already reflects
   *  what was dragged, so the receiver just kicks off the existing transfer
   *  flow without needing to pass paths. */
  (e: "paneDrop"): void;
  (e: "toast", message: string): void;
  (e: "request-delete-selection"): void;
  (e: "request-properties", entry: AnyEntry): void;
  (e: "request-edit", entry: AnyEntry): void;
  (e: "request-reconnect"): void;
}>();

const tabs = useTabsStore();

const isRemote = computed(() => props.pane === "remote");
const path = computed(() =>
  isRemote.value ? props.tab.remotePath : props.tab.localPath,
);
const entries = computed<AnyEntry[]>(() =>
  isRemote.value ? props.tab.remoteEntries : props.tab.localEntries,
);
const selectionSet = computed<string[]>(() => {
  const set = isRemote.value
    ? props.tab.selectedRemoteSet
    : props.tab.selectedLocalSet;
  if (set && set.length > 0) return set;
  // Back-compat: derive from primary single-string when the set isn't populated.
  const primary = isRemote.value
    ? props.tab.selectedRemote
    : props.tab.selectedLocal;
  return primary ? [primary] : [];
});
const selectionLookup = computed<Set<string>>(
  () => new Set(selectionSet.value),
);
const focused = computed<string | null>(() => {
  const f = isRemote.value
    ? props.tab.focusedRemote
    : props.tab.focusedLocal;
  if (f !== undefined && f !== null) return f;
  return isRemote.value
    ? props.tab.selectedRemote
    : props.tab.selectedLocal;
});
const sort = computed<SortState>(() => {
  const s = isRemote.value ? props.tab.sortRemote : props.tab.sortLocal;
  return s ?? DEFAULT_SORT;
});
const showHidden = computed<boolean>(() =>
  isRemote.value
    ? !!props.tab.showHiddenRemote
    : !!props.tab.showHiddenLocal,
);

const filteredEntries = computed<AnyEntry[]>(() => {
  if (showHidden.value) return entries.value;
  return entries.value.filter((e) => !e.name.startsWith("."));
});

const hiddenCount = computed<number>(
  () => entries.value.length - filteredEntries.value.length,
);

const sortedEntries = computed<AnyEntry[]>(() => {
  const arr = [...filteredEntries.value];
  const { col, dir } = sort.value;
  const mult = dir === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    const ad = a.type === "dir" ? 0 : 1;
    const bd = b.type === "dir" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    let cmp = 0;
    switch (col) {
      case "size": {
        const av = a.type === "dir" ? -1 : a.size;
        const bv = b.type === "dir" ? -1 : b.size;
        cmp = av - bv;
        break;
      }
      case "mtime": {
        const av = a.mtimeMs ?? 0;
        const bv = b.mtimeMs ?? 0;
        cmp = av - bv;
        break;
      }
      case "type": {
        cmp = typeLabelForEntry(a).localeCompare(typeLabelForEntry(b));
        break;
      }
      case "perm":
      case "name":
      default:
        cmp = a.name.localeCompare(b.name);
        break;
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return cmp * mult;
  });
  return arr;
});

const sortedPaths = computed<string[]>(() =>
  sortedEntries.value.map((e) => e.path),
);

/** Compute the alt-text for a row icon. Screen readers benefit from a
 *  human-readable type instead of just the filename, which they'll already
 *  read from the adjacent name cell. */
function iconAltFor(entry: AnyEntry): string {
  if (entry.type === "dir") return "Folder";
  if (entry.type === "link") return "Symbolic link";
  if (entry.type === "other") return "Special file";
  return "File";
}

function isSelected(p: string): boolean {
  return selectionLookup.value.has(p);
}

/* --- Click / multi-select handling --- */

const DBLCLICK_MS = 400;
let lastClickAt = 0;
let lastClickedPath: string | null = null;

function onRowMousedown(e: MouseEvent, entry: AnyEntry): void {
  if (e.button !== 0) return;
  // Suppress click handling during inline rename so input keeps focus.
  if (rename.path !== null) return;

  const now = Date.now();
  const isDouble =
    lastClickedPath === entry.path && now - lastClickAt < DBLCLICK_MS;
  if (isDouble) {
    lastClickedPath = null;
    lastClickAt = 0;
    emit("activate", entry);
    return;
  }
  lastClickedPath = entry.path;
  lastClickAt = now;

  if (e.shiftKey) {
    tabs.extendSelection(
      props.tab.id,
      props.pane,
      focused.value,
      entry.path,
      sortedPaths.value,
    );
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    tabs.toggleInSelection(props.tab.id, props.pane, entry.path);
    return;
  }
  tabs.setSelectionSet(props.tab.id, props.pane, [entry.path]);
}

/* --- Drag & drop ---
 *
 * Two flavours of drag are handled here:
 *
 *   1. OS Files dropped from outside the app (Finder/Explorer/another app).
 *      Carries the standard `Files` MIME — only meaningful on the remote pane,
 *      where it triggers an upload of the dropped paths.
 *
 *   2. Internal drags from the OPPOSITE pane of the same tab. We tag them
 *      with a custom MIME so we can distinguish from external drops, and so
 *      that drops INSIDE the source pane (or onto unrelated apps) are no-ops.
 *      The source pane's selection is the source of truth for which files
 *      to transfer, so the payload doesn't need to repeat the path list — but
 *      we include it anyway as a sanity-check / future-proofing.
 */
const PANE_DRAG_MIME = "application/x-flowsftp";
type PaneDragPayload = {
  tabId: string;
  pane: "local" | "remote";
  paths: string[];
};

const dragOver = ref(false);

function readPanePayload(e: DragEvent): PaneDragPayload | null {
  if (!e.dataTransfer) return null;
  const types = Array.from(e.dataTransfer.types);
  if (!types.includes(PANE_DRAG_MIME)) return null;
  // Note: getData returns "" during dragover/dragenter for security reasons,
  // so callers should only rely on the payload contents inside `drop`.
  const raw = e.dataTransfer.getData(PANE_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PaneDragPayload;
    if (
      typeof parsed?.tabId === "string" &&
      (parsed.pane === "local" || parsed.pane === "remote") &&
      Array.isArray(parsed.paths)
    ) {
      return parsed;
    }
  } catch {
    /* malformed payload — ignore */
  }
  return null;
}

function hasPaneDrag(e: DragEvent): boolean {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types).includes(PANE_DRAG_MIME);
}
function hasOsFiles(e: DragEvent): boolean {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types).includes("Files");
}

function onRowDragStart(e: DragEvent, entry: AnyEntry): void {
  if (!e.dataTransfer) return;
  // Don't initiate a drag during inline rename — keep the editor focused.
  if (rename.path !== null) {
    e.preventDefault();
    return;
  }
  // If the user starts dragging an unselected row, replace the selection
  // with that row so the dragged set matches what they "see" picked up.
  if (!isSelected(entry.path)) {
    tabs.setSelectionSet(props.tab.id, props.pane, [entry.path]);
  }
  const paths =
    selectionSet.value.length > 0 ? selectionSet.value : [entry.path];
  const payload: PaneDragPayload = {
    tabId: props.tab.id,
    pane: props.pane,
    paths,
  };
  e.dataTransfer.setData(PANE_DRAG_MIME, JSON.stringify(payload));
  // A human-readable fallback so dropping on apps that don't understand
  // our custom MIME at least reveals something useful.
  e.dataTransfer.setData("text/plain", paths.join("\n"));
  e.dataTransfer.effectAllowed = "copy";
}

function onDragEnter(e: DragEvent): void {
  if (!e.dataTransfer) return;
  if (hasPaneDrag(e) || hasOsFiles(e)) {
    e.preventDefault();
    dragOver.value = true;
  }
}
function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return;
  if (hasPaneDrag(e) || hasOsFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
}
function onDragLeave(e: DragEvent): void {
  if (e.currentTarget === e.target) dragOver.value = false;
}
function onDrop(e: DragEvent): void {
  if (!e.dataTransfer) return;
  e.preventDefault();
  dragOver.value = false;

  // Internal cross-pane drag wins over OS files when both are present —
  // it's unambiguous and avoids weird edge-cases on platforms where
  // Electron synthesises a `Files` entry for the dragged row.
  const internal = readPanePayload(e);
  if (internal) {
    if (internal.tabId !== props.tab.id) {
      emit("toast", "Cross-tab drag-and-drop isn’t supported yet.");
      return;
    }
    if (internal.pane === props.pane) {
      // Dropped back onto the source pane — silently ignore.
      return;
    }
    if (props.pane === "remote" && !props.tab.isConnected) {
      emit("toast", "Connect to a server first.");
      return;
    }
    emit("paneDrop");
    return;
  }

  // External OS drop — only meaningful on the remote pane (upload).
  const files = Array.from(e.dataTransfer.files);
  const paths = files
    .map((f) => (f as File & { path?: string }).path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  if (props.pane === "local") {
    emit(
      "toast",
      "Drag files here from the remote pane, or use the Upload button on the other side.",
    );
    return;
  }

  if (!props.tab.isConnected) {
    emit("toast", "Connect to a server first.");
    return;
  }
  if (paths.length === 0) {
    emit(
      "toast",
      "These items don’t expose a filesystem path (was likely dragged from a browser).",
    );
    return;
  }
  emit("dropFiles", paths);
}

/* --- Context menu --- */
type CtxMenuState = {
  open: boolean;
  x: number;
  y: number;
  entry: AnyEntry | null;
};
const ctx = reactive<CtxMenuState>({ open: false, x: 0, y: 0, entry: null });

function openContext(e: MouseEvent, entry: AnyEntry): void {
  e.preventDefault();
  // If the right-clicked row isn't already selected, replace selection so
  // ctx-menu actions act on the visible target (matches OS file managers).
  if (!isSelected(entry.path)) {
    tabs.setSelectionSet(props.tab.id, props.pane, [entry.path]);
  }
  ctx.open = true;
  ctx.x = e.clientX;
  ctx.y = e.clientY;
  ctx.entry = entry;
}

function closeContext(): void {
  ctx.open = false;
  ctx.entry = null;
}

async function onCtxOpen(): Promise<void> {
  if (ctx.entry) emit("activate", ctx.entry);
}

/**
 * "Copy…" (F5) — cross-pane transfer of the current selection.
 * Local pane → upload to host. Remote pane → download to local pane's cwd.
 */
async function onCtxCopy(): Promise<void> {
  if (isRemote.value) {
    if (!ctx.entry || ctx.entry.type !== "file") return;
    const pick = await window.api.dialog.saveRemoteFile(ctx.entry.path);
    if (pick.ok && pick.data) emit("download", pick.data);
  } else {
    emit("upload");
  }
}

/** "Move…" (F6) — like Copy then delete the source on success. */
function onCtxMove(): void {
  emit("move");
}

function onCtxRename(): void {
  if (!ctx.entry) return;
  startRename(ctx.entry);
}

function onCtxDelete(): void {
  emit("request-delete-selection");
}

function onCtxMkdir(): void {
  startMkdir();
}

function onCtxProperties(): void {
  if (ctx.entry) emit("request-properties", ctx.entry);
}

function onCtxEdit(): void {
  if (ctx.entry && ctx.entry.type === "file") emit("request-edit", ctx.entry);
}

/** "Copy to Clipboard" (Ctrl+C) — copies selected paths to system clipboard. */
async function onCtxClipboard(): Promise<void> {
  const paths = selectionSet.value;
  if (paths.length === 0) return;
  const text = paths.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    emit(
      "toast",
      paths.length === 1
        ? "Path copied to clipboard."
        : `${paths.length} paths copied to clipboard.`,
    );
  } catch (err) {
    emit("toast", `Clipboard: ${(err as Error).message}`);
  }
}

/** Direct download/upload (no save-dialog round-trip). The opposite pane's
 *  current directory is the destination; CommanderTab knows about both panes
 *  so it builds the actual JobInputs from the selection. */
function onCtxTransferNow(): void {
  emit("transferNow");
}

/** "Reveal in Finder" / "Show in Explorer" — local pane only. */
async function onCtxShowInFolder(): Promise<void> {
  if (!ctx.entry) return;
  const r = await window.api.shell.showItemInFolder(ctx.entry.path);
  if (!r.ok) emit("toast", `Reveal: ${r.error.message}`);
}

/** "Permissions…" — chmod via SFTP. Prompts for an octal mode (e.g. 644)
 *  and applies it. Refresh follows on success so the new mode shows up.
 *  Single-file scoped for now; multi-select chmod can follow once we have
 *  a proper modal dialog instead of window.prompt. */
async function onCtxPermissions(): Promise<void> {
  if (!ctx.entry || ctx.entry.type !== "file") return;
  if (!props.tab.connectionId) {
    emit("toast", "Connect to a server first.");
    return;
  }
  // Pre-fill the prompt with the current octal mode so the user can tweak
  // a single bit instead of remembering the whole thing. If stat fails we
  // fall back to a sane default rather than blocking the prompt.
  let hint = "644";
  const stat = await window.api.sftp.stat(
    props.tab.connectionId,
    ctx.entry.path,
  );
  if (stat.ok && typeof stat.data.mode === "number") {
    hint = (stat.data.mode & 0o777).toString(8).padStart(3, "0");
  }
  const input = window.prompt(
    `Set permissions for ${fileName(ctx.entry.path)}\n(octal, e.g. 644)`,
    hint,
  );
  if (input == null) return;
  const trimmed = input.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) {
    emit("toast", "Permissions must be 3–4 octal digits (e.g. 644 or 0755).");
    return;
  }
  const mode = parseInt(trimmed, 8);
  const r = await window.api.sftp.chmod(
    props.tab.connectionId,
    ctx.entry.path,
    mode,
  );
  if (!r.ok) {
    emit("toast", `Permissions: ${r.error.message}`);
    return;
  }
  emit("toast", `Set permissions to ${trimmed}.`);
  emit("refresh");
}

/* --- Sorting --- */
function onSort(col: SortCol): void {
  /* The trailing click after a column-resize drag would otherwise toggle
   * sort direction unexpectedly — swallow it. */
  if (resizeJustEnded) return;
  tabs.setSort(props.pane, col);
}

function sortIcon(col: SortCol): typeof ArrowUp | typeof ArrowDown | null {
  if (sort.value.col !== col) return null;
  return sort.value.dir === "asc" ? ArrowUp : ArrowDown;
}

/* --- Show hidden --- */
function onToggleHidden(): void {
  tabs.toggleHidden(props.pane);
}

/* --- Inline mkdir --- */
const mkdir = reactive<{ open: boolean; name: string }>({
  open: false,
  name: "",
});
const mkdirInputEl = ref<HTMLInputElement | null>(null);

function startMkdir(): void {
  mkdir.open = true;
  mkdir.name = "";
  void nextTick(() => {
    mkdirInputEl.value?.focus();
    mkdirInputEl.value?.select();
  });
}

function cancelMkdir(): void {
  mkdir.open = false;
  mkdir.name = "";
}

async function commitMkdir(): Promise<void> {
  const name = mkdir.name.trim();
  if (!name) {
    cancelMkdir();
    return;
  }
  if (name.includes("/") || name.includes("\\")) {
    emit("toast", "Folder name cannot contain slashes.");
    return;
  }
  const r = isRemote.value
    ? await tabs.mkdirRemote(props.tab.id, name)
    : await tabs.mkdirLocal(props.tab.id, name);
  if (!r.ok) {
    emit("toast", `Couldn’t create folder: ${r.error.message}`);
    return;
  }
  cancelMkdir();
}

function onMkdirKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    void commitMkdir();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelMkdir();
  }
}

/* --- Inline rename --- */
const rename = reactive<{ path: string | null; name: string }>({
  path: null,
  name: "",
});
const renameInputEl = ref<HTMLInputElement | null>(null);

function startRename(entry: AnyEntry): void {
  rename.path = entry.path;
  rename.name = entry.name;
  void nextTick(() => {
    const el = renameInputEl.value;
    if (!el) return;
    el.focus();
    // Select stem (without extension) for nicer keep-typing UX.
    const dot = el.value.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  });
}

function cancelRename(): void {
  rename.path = null;
  rename.name = "";
}

async function commitRename(): Promise<void> {
  const oldPath = rename.path;
  if (!oldPath) return;
  const newName = rename.name.trim();
  const original = fileName(oldPath);
  if (!newName || newName === original) {
    cancelRename();
    return;
  }
  if (newName.includes("/") || newName.includes("\\")) {
    emit("toast", "Name cannot contain slashes.");
    return;
  }
  const r = isRemote.value
    ? await tabs.renameRemote(props.tab.id, oldPath, newName)
    : await tabs.renameLocal(props.tab.id, oldPath, newName);
  if (!r.ok) {
    emit("toast", `Couldn’t rename: ${r.error.message}`);
    return;
  }
  cancelRename();
}

function onRenameKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    void commitRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelRename();
  }
}

function onRenameBlur(): void {
  if (rename.path !== null) cancelRename();
}

/* --- Keyboard inside the pane --- */

function focusedEntry(): AnyEntry | null {
  const f = focused.value;
  if (!f) return null;
  return sortedEntries.value.find((e) => e.path === f) ?? null;
}

function onListKeydown(e: KeyboardEvent): void {
  // Ignore keys while inline editors are active — they have their own handlers.
  if (rename.path !== null || mkdir.open) return;
  const t = e.target as HTMLElement | null;
  if (
    t &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  ) {
    return;
  }

  if (e.key === "F2") {
    e.preventDefault();
    const fe = focusedEntry();
    if (fe) startRename(fe);
    return;
  }
  if (e.key === "Delete") {
    e.preventDefault();
    if (selectionSet.value.length > 0) emit("request-delete-selection");
    return;
  }
  if (e.key === "Enter" || (e.key === " " && !e.repeat)) {
    const fe = focusedEntry();
    if (fe) {
      e.preventDefault();
      emit("activate", fe);
    }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const list = sortedPaths.value;
    if (list.length === 0) return;
    const cur = focused.value ? list.indexOf(focused.value) : -1;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(
      list.length - 1,
      Math.max(0, cur === -1 ? 0 : cur + delta),
    );
    const nextPath = list[next];
    if (e.shiftKey) {
      tabs.extendSelection(
        props.tab.id,
        props.pane,
        focused.value,
        nextPath,
        list,
      );
    } else {
      tabs.setSelectionSet(props.tab.id, props.pane, [nextPath]);
    }
  }
}

/* --- Lifecycle --- */
const listEl = ref<HTMLDivElement | null>(null);

onMounted(() => {
  /* No global mousedown listener for the row context menu — PaneContextMenu
   * owns its own outside-click handling. The header menu is small and lives
   * in this component, so we wire it up here. */
  window.addEventListener("mousedown", onHeaderMenuOutsideMouseDown, true);
  window.addEventListener("keydown", onHeaderMenuKeydown);

  if (listEl.value) {
    /* Track container width so the table can stretch to fill empty space
     * when the columns are narrower than the viewport, and overflow with
     * a horizontal scrollbar when they're wider. */
    listResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) listWidth.value = entry.contentRect.width;
    });
    listResizeObserver.observe(listEl.value);
    listWidth.value = listEl.value.clientWidth;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onHeaderMenuOutsideMouseDown, true);
  window.removeEventListener("keydown", onHeaderMenuKeydown);
  window.removeEventListener("mousemove", onResizeMove);
  if (listResizeObserver) {
    listResizeObserver.disconnect();
    listResizeObserver = null;
  }
});
</script>

<template>
  <section
    class="pane"
    :class="{ 'pane--drop': dragOver, 'pane--remote': isRemote }"
    :aria-label="isRemote ? 'Remote pane' : 'Local pane'"
  >
    <PathBar :path="path" :pane="pane" @navigate="(p) => emit('navigate', p)" />

    <div class="pane__toolbar" role="toolbar">
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Up (Backspace)"
        @click="emit('goUp')"
      >
        <ChevronUp :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Home directory"
        @click="emit('goHome')"
      >
        <Home :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="Refresh"
        @click="emit('refresh')"
      >
        <RefreshCw :size="14" />
      </button>
      <button
        type="button"
        class="bt-iconbtn"
        data-tooltip="New folder (F7)"
        :disabled="isRemote && !tab.isConnected"
        @click="startMkdir"
      >
        <FolderPlus :size="14" />
      </button>
      <span class="pane__toolbar-spacer" />
      <span
        class="pane__count"
        :aria-label="`${filteredEntries.length} items`"
      >
        {{ filteredEntries.length }} items<span
          v-if="hiddenCount > 0"
          class="pane__count-hidden"
        >
          ({{ hiddenCount }} hidden)</span
        >
      </span>
      <button
        type="button"
        class="bt-iconbtn"
        :class="{ 'bt-iconbtn--active': showHidden }"
        :data-tooltip="
          showHidden ? 'Hide dotfiles (Ctrl+H)' : 'Show hidden (Ctrl+H)'
        "
        @click="onToggleHidden"
      >
        <Search :size="14" />
      </button>
    </div>

    <div
      ref="listEl"
      class="pane__list"
      tabindex="0"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @keydown="onListKeydown"
    >
      <table
        class="pane__table"
        :style="{ width: tableWidth + 'px' }"
      >
        <colgroup>
          <col
            v-for="c in visibleColumns"
            :key="c.key"
            :style="{ width: widthFor(c) + 'px' }"
          />
          <!-- Spacer absorbs leftover width when the explicit column widths
               sum to less than the container, so the table visually fills
               the pane instead of leaving an awkward gap on the right. -->
          <col class="pane__col-spacer" />
        </colgroup>
        <thead>
          <tr @contextmenu="openHeaderMenu">
            <th
              v-for="c in visibleColumns"
              :key="c.key"
              :class="[
                'col-' + c.key,
                'pane__th--sort',
                c.align === 'right' ? 'pane__th--right' : null,
              ]"
              @click="onSort(c.sortKey)"
            >
              <span class="pane__th-label">{{ c.label }}</span>
              <component
                v-if="sortIcon(c.sortKey)"
                :is="sortIcon(c.sortKey)"
                :size="11"
                class="pane__th-arrow"
              />
              <span
                class="pane__th-resize"
                role="separator"
                aria-orientation="vertical"
                :aria-label="`Resize ${c.label} column`"
                @mousedown="startResize($event, c)"
                @click.stop
                @dblclick.stop
              />
            </th>
            <th class="pane__th-spacer" @contextmenu="openHeaderMenu" />
          </tr>
        </thead>
        <tbody>
          <tr v-if="mkdir.open" class="pane__row pane__row--mkdir">
            <td
              v-for="c in visibleColumns"
              :key="c.key"
              :class="['col-' + c.key, c.align === 'right' ? 'is-right' : null]"
            >
              <template v-if="c.key === 'name'">
                <img
                  :src="genericFolderIconUrl()"
                  width="16"
                  height="16"
                  alt="Folder"
                  class="pane__row-icon"
                />
                <input
                  ref="mkdirInputEl"
                  v-model="mkdir.name"
                  type="text"
                  class="pane__inline-input"
                  placeholder="New folder"
                  @keydown="onMkdirKeydown"
                  @blur="cancelMkdir"
                />
              </template>
              <template v-else>—</template>
            </td>
            <td class="pane__td-spacer" />
          </tr>

          <tr
            v-for="(e, i) in sortedEntries"
            :key="e.path"
            class="pane__row"
            :class="{
              'pane__row--sel': isSelected(e.path),
              'pane__row--focus': focused === e.path,
              'pane__row--alt': i % 2 === 1,
              'pane__row--dir': e.type === 'dir',
            }"
            :draggable="rename.path === null"
            @mousedown="onRowMousedown($event, e)"
            @dragstart="onRowDragStart($event, e)"
            @contextmenu="openContext($event, e)"
          >
            <td
              v-for="c in visibleColumns"
              :key="c.key"
              :class="['col-' + c.key, c.align === 'right' ? 'is-right' : null]"
            >
              <template v-if="c.key === 'name'">
                <img
                  :src="iconUrlForEntry(e)"
                  width="16"
                  height="16"
                  :alt="iconAltFor(e)"
                  loading="lazy"
                  decoding="async"
                  draggable="false"
                  class="pane__row-icon"
                />
                <input
                  v-if="rename.path === e.path"
                  ref="renameInputEl"
                  v-model="rename.name"
                  type="text"
                  class="pane__inline-input"
                  @keydown="onRenameKeydown"
                  @blur="onRenameBlur"
                  @mousedown.stop
                  @click.stop
                />
                <span v-else class="bt-truncate">{{ e.name }}</span>
              </template>
              <template v-else-if="c.key === 'size'">
                {{ e.type === "dir" ? "—" : formatBytes(e.size) }}
              </template>
              <template v-else-if="c.key === 'type'">
                <span class="bt-truncate" :title="typeLabelForEntry(e)">
                  {{ typeLabelForEntry(e) }}
                </span>
              </template>
              <template v-else-if="c.key === 'mtime'">
                {{ formatDateTime(e.mtimeMs) }}
              </template>
              <template v-else-if="c.key === 'perm'">
                <span class="bt-mono"></span>
              </template>
            </td>
            <td class="pane__td-spacer" />
          </tr>

          <tr
            v-if="
              sortedEntries.length === 0 &&
              !mkdir.open &&
              !(isRemote && !tab.isConnected)
            "
          >
            <td :colspan="visibleColumns.length + 1" class="pane__empty">
              <em v-if="hiddenCount > 0">
                {{ hiddenCount }} hidden item{{ hiddenCount === 1 ? "" : "s" }}.
                Toggle “Show hidden” to view.
              </em>
              <em v-else>This folder is empty.</em>
            </td>
          </tr>
        </tbody>
      </table>

      <div
        v-if="isRemote && !tab.isConnected"
        class="pane__reconnect"
      >
        <Plug :size="22" />
        <p>Disconnected</p>
        <button
          type="button"
          class="bt-btn bt-btn--primary"
          @click="emit('request-reconnect')"
        >
          Reconnect
        </button>
      </div>

      <div v-if="dragOver" class="pane__dropzone">
        <ArrowDownToLine :size="32" />
        <span>
          {{ isRemote ? "Drop to upload to" : "Drop to download to" }}
          {{ path || "/" }}
        </span>
      </div>
    </div>

    <Teleport to="body">
      <ul
        v-if="headerMenu.open"
        class="pane__hdr-menu"
        data-bt-header-menu
        role="menu"
        :style="{ left: headerMenu.x + 'px', top: headerMenu.y + 'px' }"
        @click.stop
      >
        <li
          v-for="c in toggleableColumns"
          :key="c.key"
          role="menuitemcheckbox"
          :aria-checked="!isColumnHidden(c)"
          class="pane__hdr-menu-item"
          @click="toggleColumnVisibility(c)"
        >
          <Check
            v-if="!isColumnHidden(c)"
            :size="13"
            class="pane__hdr-menu-check"
          />
          <span v-else class="pane__hdr-menu-check pane__hdr-menu-check--empty" />
          <span>Show “{{ c.label }}”</span>
        </li>
        <li class="pane__hdr-menu-sep" role="separator" />
        <li
          role="menuitem"
          class="pane__hdr-menu-item"
          @click="resetColumnPrefs"
        >
          <RotateCcw :size="13" class="pane__hdr-menu-check" />
          <span>Reset columns</span>
        </li>
      </ul>
    </Teleport>

    <PaneContextMenu
      :open="ctx.open"
      :x="ctx.x"
      :y="ctx.y"
      :pane="pane"
      :entry="ctx.entry"
      :selection-count="selectionSet.length"
      @open="onCtxOpen"
      @transfer-now="onCtxTransferNow"
      @copy="onCtxCopy"
      @move="onCtxMove"
      @clipboard="onCtxClipboard"
      @permissions="onCtxPermissions"
      @show-in-folder="onCtxShowInFolder"
      @rename="onCtxRename"
      @delete="onCtxDelete"
      @mkdir="onCtxMkdir"
      @edit="onCtxEdit"
      @properties="onCtxProperties"
      @close="closeContext"
    />
  </section>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  background: var(--bt-panel);
  position: relative;
  overflow: hidden;
}

.pane--drop {
  outline: 2px dashed var(--bt-accent);
  outline-offset: -3px;
}

.pane__toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 0 6px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.pane__toolbar-spacer {
  flex: 1 1 auto;
}
.pane__count {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  margin-right: 6px;
}
.pane__count-hidden {
  opacity: 0.7;
  margin-left: 2px;
}
.bt-iconbtn--active {
  background: var(--bt-row-selected);
  color: var(--bt-row-selected-text);
}

.pane__list {
  flex: 1 1 auto;
  overflow: auto;
  position: relative;
  background: var(--bt-panel);
  outline: none;
}

.pane__list:focus-visible {
  box-shadow: inset 0 0 0 2px var(--bt-accent);
}

.pane__table {
  border-collapse: collapse;
  table-layout: fixed;
  font-size: var(--bt-fs-md);
}

.pane__table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  font-weight: 600;
  font-size: var(--bt-fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 10px;
  padding-right: 14px; /* leave room for the resize handle */
  background: var(--bt-bg);
  color: var(--bt-text-muted);
  border-bottom: 1px solid var(--bt-border);
  user-select: none;
  overflow: hidden;
}
.pane__table thead th.pane__th--right {
  text-align: right;
}

.pane__th--sort {
  cursor: pointer;
  position: relative;
}
.pane__th--sort:hover {
  color: var(--bt-text);
}
.pane__th-arrow {
  margin-left: 4px;
  vertical-align: -1px;
  display: inline-block;
}
.pane__th-label {
  /* Prevent very long column labels from butting into the resize handle. */
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  max-width: calc(100% - 14px);
}

/* Per-cell alignment override (the colgroup width drives sizing; this is
 * just for cell content alignment when a column is right-aligned). */
.pane__row td.is-right {
  text-align: right;
}

/* Drag-handle that sits on the right edge of every header cell. The wider
 * hit-zone (~6px) is more forgiving than a 1px line; the visible accent
 * only appears on hover so the headers don't look busy. */
.pane__th-resize {
  position: absolute;
  top: 0;
  right: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  user-select: none;
  z-index: 2;
}
.pane__th-resize::after {
  content: "";
  position: absolute;
  top: 4px;
  bottom: 4px;
  right: 2px;
  width: 1px;
  background: transparent;
  transition: background 120ms ease;
}
.pane__th-resize:hover::after,
.pane__table thead th:hover .pane__th-resize::after {
  background: var(--bt-border);
}
.pane__th-resize:active::after {
  background: var(--bt-accent);
}

/* Trailing spacer column / cells. They have no width — table-layout:fixed
 * gives them whatever pixels remain after the explicit columns. They render
 * as invisible filler so the body rows look like a continuous strip even
 * when the user shrinks the visible columns below the container width. */
.pane__th-spacer {
  padding: 0 !important;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
  position: sticky;
  top: 0;
  z-index: 1;
  cursor: default;
}
.pane__td-spacer {
  padding: 0 !important;
  border-bottom: 1px solid var(--bt-border-subtle);
}

/* Body-level cursor lock during an active drag so the cursor stays
 * consistent even if the pointer leaves the resize handle. */
:global(body.bt-col-resizing) {
  cursor: col-resize !important;
}
:global(body.bt-col-resizing) * {
  cursor: col-resize !important;
}

.pane__row {
  cursor: pointer;
  height: var(--bt-h-row);
  user-select: none;
  -webkit-user-select: none;
}

.pane__row td {
  padding: 4px 10px;
  border-bottom: 1px solid var(--bt-border-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--bt-text);
}

.pane__row .col-name {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pane__row .col-size {
  text-align: right;
  color: var(--bt-text-muted);
  font-variant-numeric: tabular-nums;
}
.pane__row .col-date,
.pane__row .col-mtime {
  color: var(--bt-text-muted);
  font-variant-numeric: tabular-nums;
}
.pane__row .col-type {
  color: var(--bt-text-muted);
}

.pane__row:hover {
  background: var(--bt-row-hover);
}

.pane__row--sel {
  background: var(--bt-row-selected) !important;
  color: var(--bt-row-selected-text);
}
.pane__row--sel td {
  color: var(--bt-row-selected-text);
}

.pane__row--focus {
  box-shadow: inset 0 0 0 1px var(--bt-accent);
}

.pane__row-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  /* Material file icons are pre-colored SVGs, but we render at a small
   * size where heavy details can wash into the row background. A tiny
   * drop-shadow keeps the silhouette readable on selected/hover rows
   * without altering the icon colors. */
  filter: drop-shadow(0 0 0.5px rgba(0, 0, 0, 0.25));
}
html.dark .pane__row-icon {
  filter: drop-shadow(0 0 0.5px rgba(0, 0, 0, 0.6));
}

.pane__inline-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 1px 4px;
  border: 1px solid var(--bt-accent);
  border-radius: var(--bt-radius-sm);
  background: var(--bt-panel);
  color: var(--bt-text);
  font: inherit;
  outline: none;
}

.pane__row--mkdir {
  background: var(--bt-bg-elevated);
}

.pane__empty {
  padding: 24px;
  color: var(--bt-text-subtle);
  text-align: center;
}

.pane__reconnect {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--bt-panel);
  color: var(--bt-text-muted);
  pointer-events: auto;
}
.pane__reconnect p {
  margin: 0;
  font-size: var(--bt-fs-md);
}

.pane__hdr-menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--bt-bg-elevated, var(--bt-panel));
  color: var(--bt-text);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-md, 6px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  font-size: var(--bt-fs-md);
}
.pane__hdr-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  cursor: pointer;
  border-radius: var(--bt-radius-sm, 4px);
  color: var(--bt-text);
}
.pane__hdr-menu-item:hover {
  background: var(--bt-row-hover);
}
.pane__hdr-menu-check {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--bt-accent);
}
.pane__hdr-menu-check--empty {
  /* Reserve space so the labels line up whether or not the column is shown. */
  display: inline-block;
}
.pane__hdr-menu-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--bt-border-subtle);
}

.pane__dropzone {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(0, 122, 204, 0.08);
  color: var(--bt-accent);
  font-weight: 600;
  pointer-events: none;
  font-size: var(--bt-fs-lg);
}
</style>
