<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type {
  Job,
  JobInput,
  LocalListEntry,
  RemoteListEntry,
} from "@shared/types";
import {
  ChevronLeft,
  ChevronRight,
  FolderSync,
  Plug,
  RefreshCw,
  Server,
} from "@renderer/lib/icons";
import { useTabsStore } from "@renderer/stores/tabs";
import { fileName, joinRemotePath } from "@renderer/lib/paths";
import FilePane from "./FilePane.vue";
import OverwriteDialog, {
  type OverwriteChoice,
  type OverwriteConflict,
} from "./OverwriteDialog.vue";
import SyncDialog, { type SyncPlan } from "./SyncDialog.vue";

type Draft = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
};

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
  statusMessage: string;
  draft: Draft;
};

type PaneEntry = LocalListEntry | RemoteListEntry;

const props = defineProps<{ tab: TabState }>();
const emit = defineEmits<{
  (e: "toast", message: string): void;
  (e: "open-login"): void;
  (e: "request-delete", pane: "local" | "remote"): void;
  (
    e: "request-properties",
    payload: { pane: "local" | "remote"; entry: PaneEntry },
  ): void;
  (
    e: "request-edit",
    payload: { pane: "local" | "remote"; entry: PaneEntry },
  ): void;
  (e: "request-reconnect"): void;
}>();

const tabs = useTabsStore();
const api = window.api;

/* Persist the splitter position across reloads so the user's preferred
 * layout sticks, but default to a clean 50/50 split for first-run. The
 * key is global (not per-tab) — users expect every pane to share the
 * same split feel, the way file managers behave. */
const SPLIT_STORAGE_KEY = "flowsftp:commander:split-ratio";

/** Fixed middle gutter (splitter + action column). Must match the grid
 *  template and the `.bt-splitter-h` / `.commander__center` widths. */
const SPLITTER_PX = 10;
/** Wide enough for `.bt-iconbtn` (28px) + `.commander__center` horizontal padding. */
const CENTER_COL_PX = 32;
const MID_FIXED_PX = SPLITTER_PX + CENTER_COL_PX;

/** Ratio 1–99 maps to `local : remote` fr weights (WinSCP-like: no hard
 *  18–82% cap; the grid `minmax(0, …fr)` tracks are what actually allow
 *  shrinking past the table column-sum). */
function readInitialSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_STORAGE_KEY);
    if (raw == null) return 50;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return 50;
    return Math.min(99, Math.max(1, n));
  } catch {
    return 50;
  }
}
const splitRatio = ref<number>(readInitialSplit());
watch(splitRatio, (n) => {
  try {
    localStorage.setItem(SPLIT_STORAGE_KEY, String(n));
  } catch {
    /* Storage may be unavailable in private mode — drop silently. */
  }
});
const isSplitterDragging = ref(false);
const containerEl = ref<HTMLDivElement | null>(null);

/** Snap back to 50/50. Wired to the splitter's double-click for a quick
 *  recenter without diving into a menu. */
function resetSplit(): void {
  splitRatio.value = 50;
}

/* Which pane the user most recently interacted with. F5/F6 (Copy/Move)
 * use this to decide direction: local-focused → upload, remote-focused
 * → download. */
const focusedPane = ref<"local" | "remote">("local");

const hasLocalSelection = computed(
  () =>
    (props.tab.selectedLocalSet?.length ?? 0) > 0 ||
    !!props.tab.selectedLocal,
);
const hasRemoteSelection = computed(
  () =>
    (props.tab.selectedRemoteSet?.length ?? 0) > 0 ||
    !!props.tab.selectedRemote,
);

function startSplitDrag(e: MouseEvent): void {
  e.preventDefault();
  const container = containerEl.value;
  if (!container) return;
  isSplitterDragging.value = true;
  const rect = container.getBoundingClientRect();
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  const onMove = (ev: MouseEvent): void => {
    /* Map pointer X to the *flexible* width between the two panes only.
     *  Old code used `x / rect.width`, which skewed the ratio because the
     *  splitter + center strip is not part of the left/right share. */
    const flexW = rect.width - MID_FIXED_PX;
    if (flexW <= 1) return;
    const x = ev.clientX - rect.left;
    const leftPx = Math.min(Math.max(0, x), flexW);
    const pct = (leftPx / flexW) * 100;
    splitRatio.value = Math.min(99, Math.max(1, pct));
  };
  const onUp = (): void => {
    isSplitterDragging.value = false;
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** CSS Grid is more reliable than flex here: `minmax(0, Nfr)` guarantees
 *  each pane can shrink to zero *track* width so wide tables scroll inside
 *  the pane instead of blocking the splitter (flex `min-width:auto` on
 *  descendants was still pinning ~70–75% local in practice). */
const splitGridStyle = computed(() => ({
  gridTemplateColumns: `minmax(0, ${splitRatio.value}fr) ${SPLITTER_PX}px ${CENTER_COL_PX}px minmax(0, ${100 - splitRatio.value}fr)`,
}));

/* --- File pane action handlers --- */

async function navigateLocal(p: string): Promise<void> {
  await tabs.navigateLocal(props.tab.id, p);
}
async function navigateRemote(p: string): Promise<void> {
  await tabs.navigateRemote(props.tab.id, p);
}
async function goUpLocal(): Promise<void> {
  await tabs.goUpLocal(props.tab.id);
}
async function goUpRemote(): Promise<void> {
  await tabs.goUpRemote(props.tab.id);
}
async function goHomeLocal(): Promise<void> {
  await tabs.goHomeLocal(props.tab.id);
}
async function goHomeRemote(): Promise<void> {
  if (!props.tab.connectionId) return;
  const r = await window.api.sftp.cwd(props.tab.connectionId);
  if (r.ok && r.data) await tabs.navigateRemote(props.tab.id, r.data);
  else if (!r.ok) emit("toast", `Home: ${r.error.message}`);
}
async function refreshLocal(): Promise<void> {
  await tabs.refreshLocal(props.tab.id);
}
async function refreshRemote(): Promise<void> {
  await tabs.refreshRemote(props.tab.id);
}
function selectLocal(p: string): void {
  focusedPane.value = "local";
  tabs.setSelectedLocal(props.tab.id, p);
}
function selectRemote(p: string): void {
  focusedPane.value = "remote";
  tabs.setSelectedRemote(props.tab.id, p);
}
async function activateLocal(
  entry: LocalListEntry | RemoteListEntry,
): Promise<void> {
  focusedPane.value = "local";
  if (entry.type === "dir") {
    await tabs.navigateLocal(props.tab.id, entry.path);
    return;
  }
  if (entry.type === "file") {
    const r = await window.api.shell.openPath(entry.path);
    if (!r.ok) emit("toast", `Open: ${r.error.message}`);
  }
}
async function activateRemote(
  entry: LocalListEntry | RemoteListEntry,
): Promise<void> {
  focusedPane.value = "remote";
  if (entry.type === "dir") {
    await tabs.navigateRemote(props.tab.id, entry.path);
    return;
  }
  if (entry.type !== "file") return;
  if (!props.tab.connectionId) {
    emit("toast", "Connect to a server first.");
    return;
  }
  emit("toast", `Opening ${entry.name}…`);
  const r = await window.api.sftp.openRemote(
    props.tab.connectionId,
    entry.path,
  );
  if (!r.ok) emit("toast", `Open: ${r.error.message}`);
}

async function uploadSelected(): Promise<void> {
  focusedPane.value = "local";
  const t = props.tab;
  if (!t.connectionId || !t.selectedLocal) return;
  const entry = t.localEntries.find((e) => e.path === t.selectedLocal);
  if (!entry || entry.type !== "file") return;
  const inputs: JobInput[] = [
    {
      connectionId: t.connectionId,
      kind: "upload",
      src: entry.path,
      dst: joinRemotePath(t.remotePath, fileName(entry.path)),
      size: entry.size,
      priority: "normal",
    },
  ];
  await confirmAndEnqueue(inputs);
}
async function downloadSelected(localDst: string): Promise<void> {
  focusedPane.value = "remote";
  const t = props.tab;
  if (!t.connectionId || !t.selectedRemote) return;
  const entry = t.remoteEntries.find((e) => e.path === t.selectedRemote);
  if (!entry || entry.type !== "file") return;
  const inputs: JobInput[] = [
    {
      connectionId: t.connectionId,
      kind: "download",
      src: entry.path,
      dst: localDst,
      size: entry.size,
      priority: "normal",
    },
  ];
  await confirmAndEnqueue(inputs);
}

/* --- Overwrite-warning machinery -----------------------------------------
 * We never silently clobber a destination file. Before any enqueue we stat
 * each `dst`; if any already exists we show a 3-way modal:
 *
 *   • Cancel        — drop the whole batch
 *   • Skip existing — enqueue only the non-conflicting inputs
 *   • Overwrite all — enqueue everything, the SFTP client will overwrite
 *
 * Stat calls run in parallel because for a multi-file selection the
 * sequential round-trip cost dominates, but we cap at 8 concurrent calls
 * so a 100-file drag doesn't spam the server with stat requests. */
const overwrite = reactive<{
  open: boolean;
  conflicts: OverwriteConflict[];
  totalCount: number;
  resolver: ((c: OverwriteChoice) => void) | null;
}>({ open: false, conflicts: [], totalCount: 0, resolver: null });

function askOverwrite(
  conflicts: OverwriteConflict[],
  totalCount: number,
): Promise<OverwriteChoice> {
  return new Promise((resolve) => {
    overwrite.conflicts = conflicts;
    overwrite.totalCount = totalCount;
    overwrite.resolver = resolve;
    overwrite.open = true;
  });
}

function onOverwriteClose(choice: OverwriteChoice): void {
  const r = overwrite.resolver;
  overwrite.open = false;
  overwrite.resolver = null;
  overwrite.conflicts = [];
  overwrite.totalCount = 0;
  r?.(choice);
}

const STAT_CONCURRENCY = 8;

/** Three-valued result so we don't conflate "destination is missing" with
 *  "we couldn't find out". Treating an error as `false` (the previous
 *  behaviour) silently bypassed the overwrite dialog whenever the SFTP
 *  client was in a transient bad state. */
type ExistResult = "yes" | "no" | "unknown";

async function destinationExists(input: JobInput): Promise<ExistResult> {
  try {
    if (input.kind === "upload") {
      const r = await api.sftp.stat(input.connectionId, input.dst);
      if (r.ok) return "yes";
      const msg = (r.error?.message ?? "").toLowerCase();
      if (
        msg.includes("no such file") ||
        msg.includes("not found") ||
        msg.includes("does not exist") ||
        msg.includes("enoent") ||
        msg.includes("no_such_file")
      ) {
        return "no";
      }
      console.warn("[overwrite] sftp.stat error", input.dst, r.error);
      return "unknown";
    }
    const r = await api.fs.local.stat(input.dst);
    if (r.ok) return "yes";
    const msg = (r.error?.message ?? "").toLowerCase();
    if (
      msg.includes("no such file") ||
      msg.includes("enoent") ||
      msg.includes("not found")
    ) {
      return "no";
    }
    console.warn("[overwrite] local stat error", input.dst, r.error);
    return "unknown";
  } catch (err) {
    console.warn("[overwrite] stat threw", input.dst, err);
    return "unknown";
  }
}

/** Run `destinationExists` over every input with bounded concurrency. */
async function findConflicts(inputs: JobInput[]): Promise<JobInput[]> {
  const conflicts: JobInput[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < inputs.length) {
      const i = cursor++;
      const input = inputs[i];
      const result = await destinationExists(input);
      if (result === "yes") conflicts.push(input);
    }
  }
  const workers = Array.from(
    { length: Math.min(STAT_CONCURRENCY, inputs.length) },
    worker,
  );
  await Promise.all(workers);
  return conflicts;
}

/** Single entry point for every transfer-enqueue site. Stats destinations,
 *  optionally prompts the user, then issues one batched IPC enqueue.
 *  Returns the created jobs (empty if cancelled or all skipped). */
async function confirmAndEnqueue(inputs: JobInput[]): Promise<Job[]> {
  if (inputs.length === 0) return [];

  const conflicts = await findConflicts(inputs);
  console.log("[overwrite] confirmAndEnqueue", {
    inputCount: inputs.length,
    conflictCount: conflicts.length,
    sampleDst: inputs[0]?.dst,
    kind: inputs[0]?.kind,
  });
  let toEnqueue = inputs;
  if (conflicts.length > 0) {
    const side: "local" | "remote" =
      conflicts[0].kind === "upload" ? "remote" : "local";
    const choice = await askOverwrite(
      conflicts.map((c) => ({ dst: c.dst, side })),
      inputs.length,
    );
    if (choice === "cancel") return [];
    if (choice === "skip") {
      const conflictKeys = new Set(
        conflicts.map((c) => `${c.kind}:${c.dst}`),
      );
      toEnqueue = inputs.filter(
        (i) => !conflictKeys.has(`${i.kind}:${i.dst}`),
      );
      if (toEnqueue.length === 0) {
        emit("toast", "All transfers skipped — destinations already exist.");
        return [];
      }
    }
  }

  const r = await api.transfer.enqueue(toEnqueue);
  if (!r.ok) {
    emit("toast", `Transfer: ${r.error.message}`);
    return [];
  }
  return r.data;
}

/* --- Recursive directory expansion ----------------------------------------
 * The transfer engine speaks one-file-per-job. To support directory uploads
 * and downloads we expand the user's selection here in the renderer:
 *
 *   1. Walk each selected directory via the platform-appropriate walker
 *      (`fs.local.walk` for upload sources, `sftp.walk` for download sources).
 *   2. Re-join every walked file's POSIX-relative path onto the destination
 *      root, preserving the directory tree.
 *   3. Pre-create the unique set of destination directories with `mkdir -p`
 *      so the per-file workers in the engine don't race on creating parents.
 *   4. Hand the flat JobInput list to `confirmAndEnqueue` — it still does
 *      the conflict prompt and batched enqueue.
 *
 * Symlinks are skipped on both sides (the walkers exclude them) to avoid
 * cycles. Selection paths are deduped so picking parent + child doesn't
 * double-enqueue a file.
 */
type Expanded = {
  inputs: JobInput[];
  dstDirs: Set<string>;
  walkErrors: string[];
};

function joinLocalPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/** Filter `dstDirs` down to the deepest paths only — recursive `mkdir`
 *  already creates parents, so creating both `a/b` and `a/b/c` is wasteful. */
function leafDirs(dirs: Set<string>): string[] {
  const arr = [...dirs].sort();
  const out: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const next = arr[i + 1];
    if (next && next.startsWith(arr[i] + "/")) continue;
    out.push(arr[i]);
  }
  return out;
}

async function expandSelection(args: {
  direction: "toRemote" | "toLocal";
  connectionId: string;
  selection: string[];
  source: PaneEntry[];
  remoteRoot: string;
  localRoot: string;
}): Promise<Expanded> {
  const { direction, connectionId, selection, source, remoteRoot, localRoot } =
    args;
  const byPath = new Map(source.map((e) => [e.path, e]));
  const inputs: JobInput[] = [];
  const dstDirs = new Set<string>();
  const walkErrors: string[] = [];
  const seenSrc = new Set<string>();

  for (const p of selection) {
    const entry = byPath.get(p);
    if (!entry) continue;

    if (entry.type === "file") {
      if (seenSrc.has(entry.path)) continue;
      seenSrc.add(entry.path);
      const name = fileName(entry.path);
      const dst =
        direction === "toRemote"
          ? joinRemotePath(remoteRoot, name)
          : joinLocalPath(localRoot, name);
      inputs.push({
        connectionId,
        kind: direction === "toRemote" ? "upload" : "download",
        src: entry.path,
        dst,
        size: entry.size,
        priority: "normal",
      });
      continue;
    }

    if (entry.type !== "dir") continue;

    // Directory: walk it and emit one job per file inside, preserving the
    // sub-tree under <dstRoot>/<dirName>/...
    const dstSubRoot =
      direction === "toRemote"
        ? joinRemotePath(remoteRoot, entry.name)
        : joinLocalPath(localRoot, entry.name);

    const walked =
      direction === "toRemote"
        ? await api.fs.local.walk(entry.path)
        : await api.sftp.walk(connectionId, entry.path);

    if (!walked.ok) {
      walkErrors.push(`${entry.name}: ${walked.error.message}`);
      continue;
    }

    // Always make sure the new top-level directory exists, even if the dir
    // is empty — that matches the user's mental model of "I uploaded foo/".
    dstDirs.add(dstSubRoot);

    const srcRoot = entry.path;
    for (const w of walked.data) {
      // Source paths use the same separator scheme as the source root: SFTP
      // returns forward slashes; on local macOS/Linux Node accepts forward
      // slashes too; on Windows Node also accepts them (mixed-separator
      // paths work for fs ops). We deliberately keep `/` everywhere here.
      const childSrc = `${srcRoot.replace(/[\\/]+$/, "")}/${w.relPath}`;
      if (seenSrc.has(childSrc)) continue;
      seenSrc.add(childSrc);

      const childDst = `${dstSubRoot}/${w.relPath}`;
      const lastSlash = childDst.lastIndexOf("/");
      if (lastSlash > 0) dstDirs.add(childDst.slice(0, lastSlash));

      inputs.push({
        connectionId,
        kind: direction === "toRemote" ? "upload" : "download",
        src: childSrc,
        dst: childDst,
        size: w.size,
        priority: "normal",
      });
    }
  }

  return { inputs, dstDirs, walkErrors };
}

/** Create every required destination directory before enqueueing. Both
 *  `sftp.mkdir` and `fs.local.mkdir` are already recursive, so we only
 *  bother creating the leaf nodes. Failures are reported but don't block
 *  the transfer — the per-file worker will surface a clearer error if a
 *  parent really is missing. */
async function ensureDestinationDirs(
  direction: "toRemote" | "toLocal",
  connectionId: string,
  dirs: Set<string>,
): Promise<string[]> {
  const errors: string[] = [];
  const targets = leafDirs(dirs);
  for (const dir of targets) {
    const r =
      direction === "toRemote"
        ? await api.sftp.mkdir(connectionId, dir)
        : await api.fs.local.mkdir(dir);
    if (!r.ok) errors.push(`${dir}: ${r.error.message}`);
  }
  return errors;
}

/* --- Multi-select cross-pane transfer (no dialog) -------------------------
 * Fired by the context menu's primary action (Download / Upload). Builds
 * JobInputs for the entire selection — including any directories, which are
 * expanded recursively — and enqueues them in a single IPC call. */
async function transferAllSelected(
  direction: "toRemote" | "toLocal",
): Promise<void> {
  const t = props.tab;
  if (!t.connectionId) {
    emit("toast", "Connect to a server first.");
    return;
  }
  const connectionId = t.connectionId;

  const selection: string[] =
    direction === "toRemote"
      ? (t.selectedLocalSet?.length ?? 0) > 0
        ? (t.selectedLocalSet as string[])
        : t.selectedLocal
          ? [t.selectedLocal]
          : []
      : (t.selectedRemoteSet?.length ?? 0) > 0
        ? (t.selectedRemoteSet as string[])
        : t.selectedRemote
          ? [t.selectedRemote]
          : [];

  if (selection.length === 0) return;
  focusedPane.value = direction === "toRemote" ? "local" : "remote";

  const source: PaneEntry[] =
    direction === "toRemote" ? t.localEntries : t.remoteEntries;

  // For multi-item or any directory selections, surface a "scanning" toast
  // so big trees don't feel hung. Single-file picks skip the toast.
  const hasDir = selection.some((p) => {
    const e = source.find((x) => x.path === p);
    return e?.type === "dir";
  });
  if (hasDir) emit("toast", "Scanning directory…");

  const expanded = await expandSelection({
    direction,
    connectionId,
    selection,
    source,
    remoteRoot: t.remotePath,
    localRoot: t.localPath,
  });

  for (const w of expanded.walkErrors) emit("toast", `Walk: ${w}`);

  if (expanded.inputs.length === 0) {
    emit("toast", "Nothing to transfer.");
    return;
  }

  const mkdirErrors = await ensureDestinationDirs(
    direction,
    connectionId,
    expanded.dstDirs,
  );
  for (const e of mkdirErrors) emit("toast", `mkdir: ${e}`);

  const created = await confirmAndEnqueue(expanded.inputs);
  if (created.length === 0) return;
  const verb = direction === "toRemote" ? "upload" : "download";
  emit(
    "toast",
    `Queued ${created.length} ${verb}${created.length === 1 ? "" : "s"}.`,
  );
}

/* --- Public actions for keyboard shortcuts (F5 Copy / F6 Move) ----------
 * HomeView holds a ref to this component and calls these on F-key presses.
 * Direction is derived from `focusedPane`. F5 mirrors the primary
 * "Upload N / Download N" action in the pane context menu — straight to the
 * opposite pane's current directory, no destination dialog. The "Save as…"
 * variant for remote-pane single-file rename stays accessible via the
 * context menu only. */
async function copyFocusedSelection(): Promise<void> {
  if (!props.tab.isConnected) {
    emit("toast", "Connect to a server first.");
    return;
  }
  await transferAllSelected(
    focusedPane.value === "local" ? "toRemote" : "toLocal",
  );
}
async function moveFocusedSelection(): Promise<void> {
  if (!props.tab.isConnected) {
    emit("toast", "Connect to a server first.");
    return;
  }
  await moveSelected(
    focusedPane.value === "local" ? "toRemote" : "toLocal",
  );
}

defineExpose({
  copy: copyFocusedSelection,
  move: moveFocusedSelection,
  refresh: refreshBoth,
  sync: openSync,
});

async function refreshBoth(): Promise<void> {
  await Promise.all([refreshLocal(), refreshRemote()]);
}

/* --- Move (F6) ----------------------------------------------------------
 * Move = transfer + delete-source-on-success. Implemented in the renderer
 * by tracking each move-spawned job ID; when its TransferEvent transitions
 * to "completed" we issue the source delete via the same fs / sftp APIs
 * `tabs.deleteLocalSelection` / `tabs.deleteRemoteSelection` use.
 *
 * We subscribe once per tab instance (onMounted/onBeforeUnmount). */

type PendingMove = { kind: "upload" | "download"; src: string };
const pendingMoves = new Map<string, PendingMove>();
let unsubscribeTransfer: (() => void) | null = null;

async function moveSelected(direction: "toRemote" | "toLocal"): Promise<void> {
  const t = props.tab;
  if (!t.connectionId) {
    emit("toast", "Connect to a server first.");
    return;
  }
  const connectionId = t.connectionId;

  const selection: string[] =
    direction === "toRemote"
      ? (t.selectedLocalSet?.length ?? 0) > 0
        ? (t.selectedLocalSet as string[])
        : t.selectedLocal
          ? [t.selectedLocal]
          : []
      : (t.selectedRemoteSet?.length ?? 0) > 0
        ? (t.selectedRemoteSet as string[])
        : t.selectedRemote
          ? [t.selectedRemote]
          : [];
  if (selection.length === 0) return;

  const source: PaneEntry[] =
    direction === "toRemote" ? t.localEntries : t.remoteEntries;
  const hasDir = selection.some(
    (p) => source.find((x) => x.path === p)?.type === "dir",
  );
  if (hasDir) emit("toast", "Scanning directory…");

  const expanded = await expandSelection({
    direction,
    connectionId,
    selection,
    source,
    remoteRoot: t.remotePath,
    localRoot: t.localPath,
  });

  for (const w of expanded.walkErrors) emit("toast", `Walk: ${w}`);

  if (expanded.inputs.length === 0) {
    emit("toast", "Nothing to move.");
    return;
  }

  const mkdirErrors = await ensureDestinationDirs(
    direction,
    connectionId,
    expanded.dstDirs,
  );
  for (const e of mkdirErrors) emit("toast", `mkdir: ${e}`);

  const created = await confirmAndEnqueue(expanded.inputs);
  if (created.length === 0) return;
  // Only flag the actually-created jobs as pending moves so the deletion
  // step runs once each — and do it BEFORE we toast so the listener that
  // fires on completion finds the entry.
  for (const job of created) {
    pendingMoves.set(job.id, { kind: job.kind, src: job.src });
  }
  emit(
    "toast",
    `Move queued (${created.length} item${created.length === 1 ? "" : "s"}).`,
  );
}

async function deleteMovedSource(move: PendingMove): Promise<void> {
  if (move.kind === "upload") {
    const r = await api.fs.local.remove(move.src, false);
    if (!r.ok) emit("toast", `Move cleanup: ${r.error.message}`);
    else await tabs.refreshLocal(props.tab.id);
  } else {
    if (!props.tab.connectionId) return;
    const r = await api.sftp.remove(props.tab.connectionId, move.src, false);
    if (!r.ok) emit("toast", `Move cleanup: ${r.error.message}`);
    else await tabs.refreshRemote(props.tab.id);
  }
}

/* --- Auto-refresh panes when transfers land --------------------------------
 * Whenever a transfer completes we want the destination pane to reflect the
 * new file without requiring a manual refresh. Two subtleties:
 *
 *  1. Burst uploads of N files would cause N back-to-back directory listings
 *     against the same dir. We coalesce by setting a 250ms debounce timer
 *     per pane — the actual refresh fires once after the last completion.
 *  2. The user might have navigated away mid-transfer. We refresh only when
 *     the job's destination file path still lies under the pane's *current*
 *     directory (prefix match), so we don't list an irrelevant folder.
 */
let remoteRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let localRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeDir(p: string): string {
  return p.replace(/[\\/]+$/, "") || "/";
}

/**
 * True when `completedDst` (a finished transfer destination file path) lies
 * inside the directory currently shown in the pane (`viewRoot`). Single-file
 * uploads use equality on the parent dir; directory uploads land in
 * subfolders (`…/proj/a/b.txt`) so the parent listing never matched the old
 * `remoteDirOf(job.dst) === remotePath` check and the pane stayed stale.
 */
function pathIsInsideViewRoot(viewRoot: string, completedDst: string): boolean {
  const root = normalizeDir(viewRoot).replace(/\\/g, "/");
  const dst = completedDst.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (root === "/") return dst === "/" || dst.startsWith("/");
  return dst === root || dst.startsWith(root + "/");
}

function scheduleRemoteRefresh(): void {
  if (remoteRefreshTimer) clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(() => {
    remoteRefreshTimer = null;
    if (!props.tab.connectionId) return;
    void tabs.refreshRemote(props.tab.id);
  }, 250);
}
function scheduleLocalRefresh(): void {
  if (localRefreshTimer) clearTimeout(localRefreshTimer);
  localRefreshTimer = setTimeout(() => {
    localRefreshTimer = null;
    void tabs.refreshLocal(props.tab.id);
  }, 250);
}

onMounted(() => {
  unsubscribeTransfer = api.transfer.onEvent((evt) => {
    if (evt.type !== "updated") return;
    const job = evt.job;

    // Move feature: delete the source file once its transfer completes.
    const move = pendingMoves.get(job.id);
    if (move) {
      if (job.status === "completed") {
        pendingMoves.delete(job.id);
        void deleteMovedSource(move);
      } else if (job.status === "failed" || job.status === "cancelled") {
        pendingMoves.delete(job.id);
      }
    }

    // Auto-refresh the destination pane on a successful transfer when its
    // landing directory matches what's currently displayed. The connection
    // id check makes this scoped per-tab — uploads on a different tab's
    // connection won't trigger a refresh here.
    if (job.status !== "completed") return;
    if (job.connectionId !== props.tab.connectionId) return;
    if (job.kind === "upload") {
      if (pathIsInsideViewRoot(props.tab.remotePath, job.dst)) {
        scheduleRemoteRefresh();
      }
    } else if (pathIsInsideViewRoot(props.tab.localPath, job.dst)) {
      scheduleLocalRefresh();
    }
  });
});

onBeforeUnmount(() => {
  unsubscribeTransfer?.();
  unsubscribeTransfer = null;
  pendingMoves.clear();
  if (remoteRefreshTimer) clearTimeout(remoteRefreshTimer);
  if (localRefreshTimer) clearTimeout(localRefreshTimer);
  remoteRefreshTimer = null;
  localRefreshTimer = null;
});

/* --- Drag-drop multi upload ---
 * Build all upload jobs in one shot and enqueue them in a single IPC call.
 * The previous loop-then-enqueue approach mutated `selectedLocal` between
 * round-trips, which raced badly when the user dropped while another upload
 * trigger (button click, F5) was already in flight — the queue would end up
 * with twin entries for the same file.
 *
 * Dropped directories are walked recursively (mirrors the multi-select
 * Upload action). Paths can come from outside the current pane, so we
 * `stat` each one to learn whether it's a file or directory rather than
 * relying on the cached pane entries.
 */
async function dropFiles(localPaths: string[]): Promise<void> {
  const t = props.tab;
  if (!t.connectionId) {
    emit("toast", "Connect to a server first.");
    return;
  }
  const connectionId = t.connectionId;
  const seen = new Set<string>();
  const inputs: JobInput[] = [];
  const dstDirs = new Set<string>();
  const walkErrors: string[] = [];
  let scanningToasted = false;

  for (const p of localPaths) {
    if (seen.has(p)) continue;
    seen.add(p);

    const st = await api.fs.local.stat(p);
    if (!st.ok) {
      walkErrors.push(`${p}: ${st.error.message}`);
      continue;
    }
    const name = fileName(p);

    if (st.data.isDirectory) {
      if (!scanningToasted) {
        emit("toast", "Scanning directory…");
        scanningToasted = true;
      }
      const walked = await api.fs.local.walk(p);
      if (!walked.ok) {
        walkErrors.push(`${name}: ${walked.error.message}`);
        continue;
      }
      const dstSubRoot = joinRemotePath(t.remotePath, name);
      dstDirs.add(dstSubRoot);
      for (const w of walked.data) {
        const childSrc = `${p.replace(/[\\/]+$/, "")}/${w.relPath}`;
        if (seen.has(childSrc)) continue;
        seen.add(childSrc);
        const childDst = `${dstSubRoot}/${w.relPath}`;
        const lastSlash = childDst.lastIndexOf("/");
        if (lastSlash > 0) dstDirs.add(childDst.slice(0, lastSlash));
        inputs.push({
          connectionId,
          kind: "upload",
          src: childSrc,
          dst: childDst,
          size: w.size,
          priority: "normal",
        });
      }
      continue;
    }

    if (!st.data.isFile) continue;
    inputs.push({
      connectionId,
      kind: "upload",
      src: p,
      dst: joinRemotePath(t.remotePath, name),
      size: st.data.size,
      priority: "normal",
    });
  }

  for (const w of walkErrors) emit("toast", `Walk: ${w}`);
  if (inputs.length === 0) return;

  const mkdirErrors = await ensureDestinationDirs(
    "toRemote",
    connectionId,
    dstDirs,
  );
  for (const e of mkdirErrors) emit("toast", `mkdir: ${e}`);

  const created = await confirmAndEnqueue(inputs);
  if (created.length === 0) return;
  emit(
    "toast",
    `Queued ${created.length} upload${created.length === 1 ? "" : "s"}.`,
  );
}

function openLogin(): void {
  emit("open-login");
}

/* --- Synchronize (WinSCP-style) ---------------------------------------- *
 * Compares the current local and remote directories and lets the user
 * apply a tailored set of uploads, downloads, and (optionally) deletions
 * to bring them in sync. The dialog itself owns the form state, walks both
 * trees, builds the diff, and lets the user toggle individual rows. Here
 * we just open it and translate the resulting plan into work for the
 * existing transfer engine + delete IPCs.
 */
const syncDialog = reactive<{ open: boolean }>({ open: false });

function openSync(): void {
  if (!props.tab.connectionId) {
    emit("toast", "Connect to a server first.");
    return;
  }
  syncDialog.open = true;
}

async function applySyncPlan(plan: SyncPlan): Promise<void> {
  const t = props.tab;
  if (!t.connectionId) return;
  const connectionId = t.connectionId;

  // 1. Pre-create all destination directories so worker concurrency can't
  //    race on parent creation. mkdir is recursive on both sides so we
  //    only need the deepest paths — reuse leafDirs() already in scope.
  if (plan.uploadDirs.length > 0) {
    const dirs = new Set(plan.uploadDirs);
    const errs = await ensureDestinationDirs("toRemote", connectionId, dirs);
    for (const e of errs) emit("toast", `mkdir: ${e}`);
  }
  if (plan.downloadDirs.length > 0) {
    const dirs = new Set(plan.downloadDirs);
    const errs = await ensureDestinationDirs("toLocal", connectionId, dirs);
    for (const e of errs) emit("toast", `mkdir: ${e}`);
  }

  // 2. Build a single JobInput batch so the overwrite dialog (if any)
  //    pops once and the queue order matches the comparison order.
  const inputs: JobInput[] = [];
  for (const u of plan.uploads) {
    inputs.push({
      connectionId,
      kind: "upload",
      src: u.src,
      dst: u.dst,
      size: u.size,
      priority: "normal",
    });
  }
  for (const d of plan.downloads) {
    inputs.push({
      connectionId,
      kind: "download",
      src: d.src,
      dst: d.dst,
      size: d.size,
      priority: "normal",
    });
  }

  let queuedCount = 0;
  if (inputs.length > 0) {
    const created = await confirmAndEnqueue(inputs);
    queuedCount = created.length;
  }

  // 3. Mirror deletions. Run sequentially (small N typically; avoids
  //    surprising parallel server load when mirror picks up an unexpected
  //    extra file). Failures don't abort — they're toasted individually.
  let deletedLocal = 0;
  let deletedRemote = 0;
  for (const p of plan.deleteLocal) {
    const r = await api.fs.local.remove(p, false);
    if (r.ok) deletedLocal++;
    else emit("toast", `delete (local): ${r.error.message}`);
  }
  for (const p of plan.deleteRemote) {
    const r = await api.sftp.remove(connectionId, p, false);
    if (r.ok) deletedRemote++;
    else emit("toast", `delete (remote): ${r.error.message}`);
  }

  // 4. Refresh both panes so the new state is reflected without a manual
  //    F5 — at least once at the end. The transfer-completion auto-refresh
  //    will handle subsequent re-listings as transfers actually land.
  if (deletedLocal > 0) await tabs.refreshLocal(t.id);
  if (deletedRemote > 0) await tabs.refreshRemote(t.id);

  // 5. Toast a single concise summary so the user can see what just got
  //    kicked off without staring at the queue panel.
  const parts: string[] = [];
  if (queuedCount > 0)
    parts.push(`${queuedCount} transfer${queuedCount === 1 ? "" : "s"} queued`);
  if (deletedLocal > 0)
    parts.push(`${deletedLocal} local deleted`);
  if (deletedRemote > 0)
    parts.push(`${deletedRemote} remote deleted`);
  emit("toast", parts.length > 0 ? `Sync: ${parts.join(", ")}.` : "Sync: nothing to do.");
}

function onSyncClose(
  result:
    | { action: "cancel" }
    | { action: "apply"; plan: SyncPlan },
): void {
  syncDialog.open = false;
  if (result.action === "cancel") return;
  void applySyncPlan(result.plan);
}
</script>

<template>
  <div class="commander">
    <div ref="containerEl" class="commander__split" :style="splitGridStyle">
      <div class="commander__pane-wrap">
        <FilePane
          pane="local"
          :tab="tab"
          @navigate="navigateLocal"
          @go-up="goUpLocal"
          @go-home="goHomeLocal"
          @refresh="refreshLocal"
          @select="selectLocal"
          @activate="activateLocal"
          @upload="uploadSelected"
          @download="downloadSelected"
          @move="moveSelected('toRemote')"
          @transfer-now="transferAllSelected('toRemote')"
          @pane-drop="transferAllSelected('toLocal')"
          @drop-files="dropFiles"
          @toast="(m) => emit('toast', m)"
          @request-delete-selection="emit('request-delete', 'local')"
          @request-properties="
            (entry) => emit('request-properties', { pane: 'local', entry })
          "
          @request-edit="
            (entry) => emit('request-edit', { pane: 'local', entry })
          "
        />
      </div>

      <div
        class="bt-splitter-h"
        :class="{ 'is-dragging': isSplitterDragging }"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize • Double-click to center"
        @mousedown="startSplitDrag"
        @dblclick="resetSplit"
      />

      <div class="commander__center">
        <button
          type="button"
          class="bt-iconbtn"
          data-tooltip="Upload selection → remote folder (F5 / context menu)"
          :disabled="!tab.isConnected || !hasLocalSelection"
          @click="transferAllSelected('toRemote')"
        >
          <ChevronRight :size="14" />
        </button>
        <button
          type="button"
          class="bt-iconbtn"
          data-tooltip="← Download selection to local folder (F5 / context menu)"
          :disabled="!tab.isConnected || !hasRemoteSelection"
          @click="transferAllSelected('toLocal')"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          type="button"
          class="bt-iconbtn"
          data-tooltip="Refresh both panes (Ctrl/Cmd+R)"
          @click="refreshBoth"
        >
          <RefreshCw :size="14" />
        </button>
        <button
          type="button"
          class="bt-iconbtn"
          data-tooltip="Synchronize directories…"
          :disabled="!tab.isConnected"
          @click="openSync"
        >
          <FolderSync :size="14" />
        </button>
      </div>

      <div v-if="tab.isConnected" class="commander__pane-wrap">
        <FilePane
          pane="remote"
          :tab="tab"
          @navigate="navigateRemote"
          @go-up="goUpRemote"
          @go-home="goHomeRemote"
          @refresh="refreshRemote"
          @select="selectRemote"
          @activate="activateRemote"
          @upload="uploadSelected"
          @download="downloadSelected"
          @move="moveSelected('toLocal')"
          @transfer-now="transferAllSelected('toLocal')"
          @pane-drop="transferAllSelected('toRemote')"
          @drop-files="dropFiles"
          @toast="(m) => emit('toast', m)"
          @request-delete-selection="emit('request-delete', 'remote')"
          @request-properties="
            (entry) => emit('request-properties', { pane: 'remote', entry })
          "
          @request-edit="
            (entry) => emit('request-edit', { pane: 'remote', entry })
          "
          @request-reconnect="emit('request-reconnect')"
        />
      </div>

      <div v-else class="disconnected" aria-label="Not connected">
        <Server :size="40" class="disconnected__icon" />
        <h3>Not connected</h3>
        <p>Open the Login dialog to connect to a server.</p>
        <button
          type="button"
          class="bt-btn bt-btn--primary disconnected__cta"
          :disabled="tab.isConnecting"
          @click="openLogin"
        >
          <Plug :size="13" />
          <span>{{ tab.isConnecting ? "Connecting…" : "Login…" }}</span>
        </button>
        <p v-if="tab.statusMessage" class="disconnected__msg">
          {{ tab.statusMessage }}
        </p>
      </div>
    </div>

    <OverwriteDialog
      :open="overwrite.open"
      :conflicts="overwrite.conflicts"
      :total-count="overwrite.totalCount"
      @close="onOverwriteClose"
    />

    <SyncDialog
      :open="syncDialog.open"
      :connection-id="tab.connectionId"
      :local-root="tab.localPath"
      :remote-root="tab.remotePath"
      @close="onSyncClose"
    />
  </div>
</template>

<style scoped>
.commander {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--bt-bg);
}

.commander__split {
  /* `grid-template-columns` comes from `splitGridStyle` (inline). */
  display: grid;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  align-items: stretch;
}

.commander__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 2px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  background: var(--bt-bg);
  border-left: 1px solid var(--bt-border);
  border-right: 1px solid var(--bt-border);
}
.commander__pane-wrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.disconnected {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  background: var(--bt-bg);
  padding: 32px;
  min-width: 0;
  color: var(--bt-text-muted);
  gap: 6px;
}
.disconnected__icon {
  color: var(--bt-text-muted);
  margin-bottom: 6px;
  opacity: 0.7;
}
.disconnected h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--bt-text);
}
.disconnected p {
  margin: 0;
  font-size: var(--bt-fs-sm);
}
.disconnected__cta {
  margin-top: 12px;
}
.disconnected__msg {
  margin-top: 8px;
  padding: 6px 10px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-sm);
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-xs);
}
</style>
