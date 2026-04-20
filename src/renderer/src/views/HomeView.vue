<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import AppMenuBar from "@renderer/components/AppMenuBar.vue";
import TabBar from "@renderer/components/TabBar.vue";
import ConnectDialog from "@renderer/components/ConnectDialog.vue";
import CommanderTab from "@renderer/components/CommanderTab.vue";
import QueuePanel from "@renderer/components/QueuePanel.vue";
import StatusBar from "@renderer/components/StatusBar.vue";
import TransferProgressDialog from "@renderer/components/TransferProgressDialog.vue";
import ConfirmDialog from "@renderer/components/ConfirmDialog.vue";
import PropertiesDialog from "@renderer/components/PropertiesDialog.vue";
import TextEditorDialog from "@renderer/components/TextEditorDialog.vue";
import UpdateDialog from "@renderer/components/UpdateDialog.vue";
import type { LocalListEntry, MenuCommand, RemoteListEntry } from "@shared/types";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useTabsStore } from "@renderer/stores/tabs";
import { useQueueStore } from "@renderer/stores/queue";
import { useSplitter } from "@renderer/composables/useSplitter";
import { useShortcuts } from "@renderer/composables/useShortcuts";
import { useTheme } from "@renderer/composables/useTheme";
import { useUpdater } from "@renderer/composables/useUpdater";
import { Server } from "@renderer/lib/icons";

type PaneEntry = LocalListEntry | RemoteListEntry;

const sessionsStore = useSessionsStore();
const tabsStore = useTabsStore();
const queueStore = useQueueStore();
const { cycle: cycleTheme } = useTheme();
const updater = useUpdater();

/* When the user explicitly opens the dialog (menu / toast click) we also
 * fire a fresh check so the dialog never sits on stale state. */
function openUpdateDialog(triggerCheck: boolean): void {
  updater.openDialog();
  if (triggerCheck && updater.state.value.status !== "downloading") {
    void updater.check();
  }
}

/* Toast newly-available updates so the user notices even if the dialog
 * was dismissed earlier in the session. */
let lastToastedVersion: string | null = null;
watch(
  () => updater.state.value,
  (s) => {
    if (s.status === "available" && s.version !== lastToastedVersion) {
      lastToastedVersion = s.version;
      showToast(`Update available: ${s.version}. Click the menu → Check for updates…`);
    }
  },
);

// On macOS the OS owns the menu bar — hide our in-window one and rely on
// `app-menu.ts` to drive the same commands through `app.onMenuCommand`.
const isMac = window.api.app.platform === "darwin";

/* Ref to the active CommanderTab so global shortcuts (F5/F6) can drive
 * its copy/move actions. Typed loosely because the exposed methods aren't
 * declared on a script-setup component instance. */
const commanderRef = ref<{
  copy: () => void | Promise<void>;
  move: () => void | Promise<void>;
  refresh: () => void | Promise<void>;
  sync: () => void;
} | null>(null);

const queueSplit = useSplitter({
  storageKey: "bt:queue:height",
  defaultSize: 220,
  min: 120,
  max: 600,
  axis: "y",
  invert: true,
});

const showQueue = ref<boolean>(loadFlag("bt:queue:visible", true));

watch(showQueue, (v) => saveFlag("bt:queue:visible", v));

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* ignore */
  }
  return fallback;
}
function saveFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function loadInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
    }
  } catch {
    /* ignore */
  }
  return fallback;
}
function saveInt(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* ignore */
  }
}

/* --- Connect (Login) dialog state --- */
const connectDialog = reactive<{
  open: boolean;
  initialSessionId: string | null;
}>({ open: false, initialSessionId: null });

function openLoginDialog(initialSessionId: string | null = null): void {
  connectDialog.initialSessionId = initialSessionId;
  connectDialog.open = true;
}

async function onConnectDialogClose(
  result:
    | { action: "cancel" }
    | {
        action: "login";
        input: {
          host: string;
          port: number;
          username: string;
          privateKeyPath?: string;
        };
        password?: string;
        sessionId?: string;
      },
): Promise<void> {
  connectDialog.open = false;
  if (result.action === "cancel") return;

  // Use the active tab if it's empty/disconnected; otherwise open a new tab.
  const active = tabsStore.activeTab;
  let tabId: string;
  if (active && !active.isConnected && !active.isConnecting) {
    tabId = active.id;
    if (result.sessionId) {
      const s = sessionsStore.sessions.find((x) => x.id === result.sessionId);
      if (s) {
        active.sessionId = s.id;
        active.title = s.name;
      }
    }
    active.draft.host = result.input.host;
    active.draft.port = result.input.port;
    active.draft.username = result.input.username;
    active.draft.privateKeyPath = result.input.privateKeyPath;
  } else {
    tabId = tabsStore.openFromSession(result.sessionId ?? null);
    const t = tabsStore.byId(tabId);
    if (t) {
      t.draft.host = result.input.host;
      t.draft.port = result.input.port;
      t.draft.username = result.input.username;
      t.draft.privateKeyPath = result.input.privateKeyPath;
    }
  }

  tabsStore.activate(tabId);
  const r = await tabsStore.connect(tabId, { password: result.password });
  if (!r.ok) showToast(r.error.message);
}

/* --- Tab handlers --- */
function newTab(openLogin = true): void {
  const tabId = tabsStore.openFromSession(null);
  tabsStore.activate(tabId);
  if (openLogin) openLoginDialog(null);
}
async function closeTab(id: string): Promise<void> {
  await tabsStore.close(id);
}

/* --- Toast --- */
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string): void {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 3500);
}

/* --- Confirm-delete / Properties / Editor dialogs --- */
const confirmDelete = reactive<{
  open: boolean;
  pane: "local" | "remote";
  details: string[];
  busy: boolean;
}>({ open: false, pane: "local", details: [], busy: false });

const propertiesDialog = reactive<{
  open: boolean;
  pane: "local" | "remote";
  entry: PaneEntry | null;
}>({ open: false, pane: "local", entry: null });

const editorDialog = reactive<{
  open: boolean;
  pane: "local" | "remote";
  entry: PaneEntry | null;
}>({ open: false, pane: "local", entry: null });

const activeConnectionId = computed<string | null>(
  () => tabsStore.activeTab?.connectionId ?? null,
);

function selectedPathsFor(pane: "local" | "remote"): string[] {
  const t = tabsStore.activeTab;
  if (!t) return [];
  if (pane === "local") {
    const set = t.selectedLocalSet;
    if (set && set.length > 0) return set;
    return t.selectedLocal ? [t.selectedLocal] : [];
  }
  const set = t.selectedRemoteSet;
  if (set && set.length > 0) return set;
  return t.selectedRemote ? [t.selectedRemote] : [];
}

function basenameOf(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

function onRequestDelete(pane: "local" | "remote"): void {
  const paths = selectedPathsFor(pane);
  if (paths.length === 0) {
    showToast("Nothing selected to delete.");
    return;
  }
  confirmDelete.pane = pane;
  confirmDelete.details = paths.map(basenameOf);
  confirmDelete.busy = false;
  confirmDelete.open = true;
}

async function onConfirmDeleteClose(result: {
  confirmed: boolean;
}): Promise<void> {
  if (!result.confirmed) {
    confirmDelete.open = false;
    return;
  }
  const t = tabsStore.activeTab;
  if (!t) {
    confirmDelete.open = false;
    return;
  }
  confirmDelete.busy = true;
  const r =
    confirmDelete.pane === "local"
      ? await tabsStore.deleteLocalSelection(t.id)
      : await tabsStore.deleteRemoteSelection(t.id);
  confirmDelete.busy = false;
  confirmDelete.open = false;
  if (r.ok) {
    showToast(
      `Deleted ${r.data.deleted} item${r.data.deleted === 1 ? "" : "s"}.`,
    );
  } else {
    showToast(`Delete failed: ${r.error.message}`);
  }
}

function onRequestProperties(p: {
  pane: "local" | "remote";
  entry: PaneEntry;
}): void {
  if (p.pane === "remote" && !activeConnectionId.value) {
    showToast("Connect to a server first.");
    return;
  }
  propertiesDialog.pane = p.pane;
  propertiesDialog.entry = p.entry;
  propertiesDialog.open = true;
}

function onPropertiesClose(result: { changed: boolean }): void {
  propertiesDialog.open = false;
  propertiesDialog.entry = null;
  if (result.changed) {
    const t = tabsStore.activeTab;
    if (!t) return;
    if (propertiesDialog.pane === "local") void tabsStore.refreshLocal(t.id);
    else void tabsStore.refreshRemote(t.id);
  }
}

function onRequestEdit(p: {
  pane: "local" | "remote";
  entry: PaneEntry;
}): void {
  if (p.entry.type !== "file") {
    showToast("Only files can be edited.");
    return;
  }
  if (p.pane === "remote" && !activeConnectionId.value) {
    showToast("Connect to a server first.");
    return;
  }
  editorDialog.pane = p.pane;
  editorDialog.entry = p.entry;
  editorDialog.open = true;
}

function onEditorClose(_result: { saved: boolean }): void {
  editorDialog.open = false;
  editorDialog.entry = null;
}

function onRequestReconnect(): void {
  const t = tabsStore.activeTab;
  openLoginDialog(t?.sessionId ?? null);
}

/* --- Menu definitions --- */
const menus = computed(() => [
  {
    id: "file",
    label: "File",
    items: [
      {
        label: "New window",
        shortcut: "Ctrl+N",
        onSelect: () => void window.api.app.newWindow(),
      },
      {
        label: "New tab",
        shortcut: "Ctrl+T",
        onSelect: () => newTab(true),
      },
      {
        label: "Close tab",
        shortcut: "Ctrl+W",
        disabled: !tabsStore.activeTabId,
        onSelect: () => {
          const id = tabsStore.activeTabId;
          if (id) void closeTab(id);
        },
      },
      { type: "separator" as const },
      { label: "Quit", onSelect: () => window.close() },
    ],
  },
  {
    id: "session",
    label: "Session",
    items: [
      {
        label: "Login…",
        shortcut: "Ctrl+L",
        onSelect: () => openLoginDialog(null),
      },
      {
        label: "Disconnect",
        disabled: !tabsStore.activeTab?.isConnected,
        onSelect: () => {
          const id = tabsStore.activeTabId;
          if (id) void tabsStore.disconnect(id);
        },
      },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    items: [
      { label: "Cut", disabled: true },
      { label: "Copy", disabled: true },
      { label: "Paste", disabled: true },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      {
        label: "Toggle theme",
        onSelect: () => cycleTheme(),
      },
      {
        label: showQueue.value ? "Hide queue panel" : "Show queue panel",
        onSelect: () => (showQueue.value = !showQueue.value),
      },
    ],
  },
  {
    id: "commands",
    label: "Commands",
    items: [
      {
        label: "Copy",
        shortcut: "F5",
        disabled: !tabsStore.activeTab?.isConnected,
        onSelect: () => commanderRef.value?.copy(),
      },
      {
        label: "Move",
        shortcut: "F6",
        disabled: !tabsStore.activeTab?.isConnected,
        onSelect: () => commanderRef.value?.move(),
      },
      {
        label: "Refresh both panes",
        shortcut: isMac ? "Cmd+R" : "Ctrl+R",
        disabled: !tabsStore.activeTab,
        onSelect: () => refreshActiveBoth(),
      },
      {
        label: "Synchronize…",
        shortcut: "Ctrl+S",
        disabled: !tabsStore.activeTab?.isConnected,
        onSelect: () => commanderRef.value?.sync(),
      },
      {
        label: "Parent directory",
        shortcut: "Backspace",
        disabled: !tabsStore.activeTab,
        onSelect: () => parentDirActive(),
      },
    ],
  },
  {
    id: "queue",
    label: "Queue",
    items: [
      {
        label: showTransferDialog.value
          ? "Hide transfer window"
          : "Show transfer window",
        disabled: queueStore.jobs.length === 0,
        onSelect: () =>
          (showTransferDialog.value = !showTransferDialog.value),
      },
      { type: "separator" as const },
      { label: "Pause all", onSelect: () => queueStore.pauseAll() },
      { label: "Resume all", onSelect: () => queueStore.resumeAll() },
      {
        label: "Clear completed",
        onSelect: () => queueStore.clearCompleted(),
      },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      {
        label: "Check for Updates…",
        onSelect: () => openUpdateDialog(true),
      },
      { type: "separator" as const },
      {
        label: "About FlowSFTP",
        onSelect: () =>
          showToast("FlowSFTP — modern WinSCP-class SFTP client."),
      },
    ],
  },
]);

/* --- Shortcut wiring --- */

async function refreshActiveBoth(): Promise<void> {
  const t = tabsStore.activeTab;
  if (!t) return;
  await Promise.all([
    tabsStore.refreshLocal(t.id),
    tabsStore.refreshRemote(t.id),
  ]);
}
function parentDirActive(): void {
  const t = tabsStore.activeTab;
  if (!t) return;
  void tabsStore.goUpRemote(t.id);
}

useShortcuts({
  newTab: () => newTab(true),
  closeTab: () => {
    const id = tabsStore.activeTabId;
    if (id) void closeTab(id);
  },
  newWindow: () => void window.api.app.newWindow(),
  refreshAll: () => void refreshActiveBoth(),
  copySelection: () => void commanderRef.value?.copy(),
  moveSelection: () => void commanderRef.value?.move(),
  goUp: () => {
    const t = tabsStore.activeTab;
    if (!t) return;
    void tabsStore.goUpLocal(t.id);
  },
  openLogin: () => openLoginDialog(null),
  openSync: () => commanderRef.value?.sync(),
});

const activeTab = computed(() => tabsStore.activeTab);

const queueStats = computed(
  () => queueStore.stats ?? { active: 0, queued: 0, completed: 0, failed: 0 },
);

const overallSpeed = computed<number>(
  () => queueStore.overallBytesPerSecond ?? 0,
);

/* Drives the status-bar activity indicator: the most recently-running job's
 * filename and per-file progress. Falls back to the first queued job when
 * nothing's actively running yet so the user sees "Queued: foo  0%" rather
 * than a misleading "Idle". */
const currentTransferJob = computed(() => {
  return (
    queueStore.jobs.find((j) => j.status === "running") ??
    queueStore.jobs.find((j) => j.status === "queued") ??
    null
  );
});
const currentTransferName = computed<string | null>(() => {
  const j = currentTransferJob.value;
  if (!j) return null;
  const path = j.kind === "upload" ? j.src : j.dst;
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
});
const currentTransferPercent = computed<number>(() => {
  const j = currentTransferJob.value;
  if (!j || !j.size) return 0;
  return Math.round((j.transferred / j.size) * 100);
});

// Auto-pop the queue panel open as soon as a transfer is enqueued so the user
// never has to wonder where their job went.
watch(
  () => queueStore.jobs.length,
  (n, prev) => {
    if (n > 0 && (prev ?? 0) === 0 && !showQueue.value) {
      showQueue.value = true;
    }
  },
);

/* Auto-clear completed transfers from the queue.
 *
 * Default ON — keeps the queue tight as a "what's happening now" view rather
 * than a transfer history. We wait ~1.5s after a job finishes so the user
 * sees the 100% bar before the row disappears. clearCompleted() is debounced
 * with a single timer so a burst of completions only triggers one cleanup. */
const autoClearCompleted = ref<boolean>(loadFlag("bt:queue:autoClear", true));
function setAutoClearCompleted(v: boolean): void {
  autoClearCompleted.value = v;
  saveFlag("bt:queue:autoClear", v);
}

/* "Max parallel transfers" — a single user-facing knob that drives both
 * the engine's global cap and per-session cap. We seed from localStorage so
 * a fresh window starts on the user's preferred value; once the queue store
 * initialises it'll push the same value to main and reconcile against
 * whatever main ultimately clamped to. */
const QUEUE_CONCURRENCY_KEY = "bt:queue:concurrency";
const QUEUE_CONCURRENCY_MIN = 1;
const QUEUE_CONCURRENCY_MAX = 8;
const initialConcurrency = loadInt(
  QUEUE_CONCURRENCY_KEY,
  4,
  QUEUE_CONCURRENCY_MIN,
  QUEUE_CONCURRENCY_MAX,
);
queueStore.concurrency = initialConcurrency;
void queueStore.setConcurrency(initialConcurrency);
function onConcurrencyChange(n: number): void {
  saveInt(QUEUE_CONCURRENCY_KEY, n);
  void queueStore.setConcurrency(n);
}
const seenCompleted = new Set<string>();
let autoClearTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => queueStore.jobs.map((j) => ({ id: j.id, status: j.status })),
  (jobs) => {
    let anyNew = false;
    for (const j of jobs) {
      if (j.status === "completed" && !seenCompleted.has(j.id)) {
        seenCompleted.add(j.id);
        anyNew = true;
      }
    }
    if (!anyNew || !autoClearCompleted.value) return;
    if (autoClearTimer) clearTimeout(autoClearTimer);
    autoClearTimer = setTimeout(() => {
      autoClearTimer = null;
      void queueStore.clearCompleted();
    }, 1500);
  },
  { deep: true },
);
onBeforeUnmount(() => {
  if (autoClearTimer) clearTimeout(autoClearTimer);
});

// Toast any newly-failed transfer so the user notices even if the queue panel
// is collapsed or scrolled. Track the set of IDs we've already toasted to
// avoid spamming on every queue update.
const toastedFailureIds = new Set<string>();
watch(
  () => queueStore.jobs.map((j) => ({ id: j.id, status: j.status, error: j.error, dst: j.dst })),
  (jobs) => {
    for (const j of jobs) {
      if (j.status === "failed" && !toastedFailureIds.has(j.id)) {
        toastedFailureIds.add(j.id);
        const reason = j.error ?? "Transfer failed";
        showToast(`Failed → ${j.dst}: ${reason}`);
      }
    }
  },
  { deep: true },
);

/* --- Transfer progress dialog (WinSCP-style modal) ---
 * Pops automatically the moment the first transfer becomes active and stays
 * visible until the user dismisses it. If "Close when finished" is checked
 * (default), it auto-hides once every job is in a terminal state. */
const showTransferDialog = ref<boolean>(false);
const transferAutoClose = ref<boolean>(loadFlag("bt:transfer:autoClose", true));

const hasActiveTransfer = computed(() =>
  queueStore.jobs.some(
    (j) => j.status === "running" || j.status === "queued" || j.status === "paused",
  ),
);

watch(
  hasActiveTransfer,
  (active, wasActive) => {
    if (active && !wasActive) {
      showTransferDialog.value = true;
    } else if (!active && wasActive && transferAutoClose.value) {
      // brief delay so users see the final 100% before it closes
      setTimeout(() => {
        if (!hasActiveTransfer.value) showTransferDialog.value = false;
      }, 1200);
    }
  },
);

function onTransferDialogClose(): void {
  showTransferDialog.value = false;
}
function onTransferAutoCloseChange(v: boolean): void {
  transferAutoClose.value = v;
}
function cancelAllTransfers(): void {
  for (const j of queueStore.jobs) {
    if (j.status === "running" || j.status === "queued" || j.status === "paused") {
      void queueStore.cancel(j.id);
    }
  }
}

/* --- Native (OS) menu bridge ---
 * On macOS the menu lives in the system menu bar; everywhere else it lives
 * here AND in the OS menu. Either way, `app-menu.ts` dispatches commands as
 * IPC events that we route to the same handlers the in-window menu uses. */
let unsubscribeMenu: (() => void) | null = null;

function handleMenuCommand(cmd: MenuCommand): void {
  switch (cmd) {
    case "newWindow":
      void window.api.app.newWindow();
      return;
    case "newTab":
      newTab(true);
      return;
    case "closeTab": {
      const id = tabsStore.activeTabId;
      if (id) void closeTab(id);
      return;
    }
    case "login":
      openLoginDialog(null);
      return;
    case "disconnect": {
      const id = tabsStore.activeTabId;
      if (id && tabsStore.activeTab?.isConnected) void tabsStore.disconnect(id);
      return;
    }
    case "toggleTheme":
      cycleTheme();
      return;
    case "toggleQueuePanel":
      showQueue.value = !showQueue.value;
      return;
    case "toggleTransferDialog":
      showTransferDialog.value = !showTransferDialog.value;
      return;
    case "refreshBoth":
      void refreshActiveBoth();
      return;
    case "parentDir":
      parentDirActive();
      return;
    case "pauseAll":
      queueStore.pauseAll();
      return;
    case "resumeAll":
      queueStore.resumeAll();
      return;
    case "clearCompleted":
      queueStore.clearCompleted();
      return;
    case "about":
      showToast("FlowSFTP — modern WinSCP-class SFTP client.");
      return;
    case "checkForUpdates":
      openUpdateDialog(true);
      return;
  }
}

onMounted(() => {
  unsubscribeMenu = window.api.app.onMenuCommand(handleMenuCommand);
  // Open a starter empty tab so the workspace isn't fully blank on first run,
  // and pop the Login dialog right away — it's the natural first action.
  if (tabsStore.tabs.length === 0) newTab(true);
});

onBeforeUnmount(() => {
  unsubscribeMenu?.();
  unsubscribeMenu = null;
});
</script>

<template>
  <div class="home">
    <AppMenuBar v-if="!isMac" :menus="menus" />
    <TabBar
      :tabs="
        tabsStore.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          isConnecting: t.isConnecting,
          isConnected: t.isConnected,
          sessionId: t.sessionId,
        }))
      "
      :active-tab-id="tabsStore.activeTabId"
      @activate="tabsStore.activate"
      @close="closeTab"
      @new="newTab"
    />

    <div class="home__body">
      <main class="home__main">
        <div class="home__main-content">
          <CommanderTab
            v-if="activeTab"
            ref="commanderRef"
            :tab="activeTab"
            @toast="showToast"
            @open-login="openLoginDialog(activeTab.sessionId)"
            @request-delete="onRequestDelete"
            @request-properties="onRequestProperties"
            @request-edit="onRequestEdit"
            @request-reconnect="onRequestReconnect"
          />
          <div v-else class="home__placeholder">
            <Server :size="40" />
            <h2>Welcome to FlowSFTP</h2>
            <p>
              Press <kbd>Ctrl/Cmd</kbd>+<kbd>L</kbd> to open the Login dialog,
              or <kbd>Ctrl/Cmd</kbd>+<kbd>T</kbd> for a new tab.
            </p>
          </div>
        </div>

        <template v-if="showQueue">
          <div
            class="bt-splitter-v"
            :class="{ 'is-dragging': queueSplit.isDragging.value }"
            role="separator"
            aria-orientation="horizontal"
            @mousedown="queueSplit.startDrag"
          />
          <div
            class="home__queue"
            :style="{ height: (queueSplit.size.value ?? 220) + 'px' }"
          >
            <QueuePanel
              :jobs="queueStore.jobs"
              :collapsed="false"
              :stats="queueStats"
              :bytes-per-sec="overallSpeed"
              :auto-clear="autoClearCompleted"
              :concurrency="queueStore.concurrency"
              :concurrency-min="QUEUE_CONCURRENCY_MIN"
              :concurrency-max="QUEUE_CONCURRENCY_MAX"
              @toggle-collapse="showQueue = false"
              @pause-all="queueStore.pauseAll"
              @resume-all="queueStore.resumeAll"
              @clear-completed="queueStore.clearCompleted"
              @update:auto-clear="setAutoClearCompleted"
              @update:concurrency="onConcurrencyChange"
              @pause="(id) => queueStore.pause(id)"
              @resume="(id) => queueStore.resume(id)"
              @cancel="(id) => queueStore.cancel(id)"
              @remove="(id) => queueStore.remove(id)"
              @reorder="(ids) => queueStore.reorder(ids)"
            />
          </div>
        </template>
      </main>
    </div>

    <StatusBar
      :is-connected="!!activeTab?.isConnected"
      :is-connecting="!!activeTab?.isConnecting"
      :username="activeTab?.draft?.username"
      :host="activeTab?.draft?.host"
      :remote-path="activeTab?.remotePath"
      :bytes-per-sec="overallSpeed"
      :active="queueStats.active"
      :queued="queueStats.queued"
      :current-name="currentTransferName"
      :current-percent="currentTransferPercent"
      :queue-visible="showQueue"
      @toggle-queue="showQueue = !showQueue"
    />

    <ConnectDialog
      :open="connectDialog.open"
      :initial-session-id="connectDialog.initialSessionId"
      @close="onConnectDialogClose"
    />

    <TransferProgressDialog
      :jobs="queueStore.jobs"
      :bytes-per-sec="overallSpeed"
      :visible="showTransferDialog"
      @close="onTransferDialogClose"
      @pause="(id) => queueStore.pause(id)"
      @resume="(id) => queueStore.resume(id)"
      @cancel="(id) => queueStore.cancel(id)"
      @cancel-all="cancelAllTransfers"
      @update:auto-close="onTransferAutoCloseChange"
    />

    <ConfirmDialog
      :open="confirmDelete.open"
      title="Delete selected?"
      :message="
        confirmDelete.details.length === 1
          ? `Delete “${confirmDelete.details[0]}”? This cannot be undone.`
          : `Delete ${confirmDelete.details.length} items? This cannot be undone.`
      "
      :details="confirmDelete.details.length > 1 ? confirmDelete.details : []"
      confirm-text="Delete"
      busy-text="Deleting…"
      :busy="confirmDelete.busy"
      variant="danger"
      icon="danger"
      @close="onConfirmDeleteClose"
    />

    <PropertiesDialog
      :open="propertiesDialog.open"
      :pane="propertiesDialog.pane"
      :connection-id="activeConnectionId"
      :entry="propertiesDialog.entry"
      @close="onPropertiesClose"
      @toast="showToast"
    />

    <TextEditorDialog
      :open="editorDialog.open"
      :pane="editorDialog.pane"
      :connection-id="activeConnectionId"
      :entry="
        editorDialog.entry && editorDialog.entry.type === 'file'
          ? {
              name: editorDialog.entry.name,
              path: editorDialog.entry.path,
              size: editorDialog.entry.size,
            }
          : null
      "
      @close="onEditorClose"
      @toast="showToast"
    />

    <UpdateDialog
      :open="updater.dialogOpen.value"
      :state="updater.state.value"
      @close="updater.closeDialog()"
      @check="updater.check()"
      @download="updater.download()"
      @install="updater.install()"
    />

    <transition name="bt-toast">
      <div v-if="toast" class="home__toast" role="status">{{ toast }}</div>
    </transition>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--bt-bg);
  color: var(--bt-text);
}

.home__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.home__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bt-bg);
}

.home__main-content {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.home__queue {
  flex: 0 0 auto;
  min-height: 80px;
  overflow: hidden;
  display: flex;
}

.home__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  flex: 1 1 auto;
  color: var(--bt-text-muted);
  padding: 32px;
}
.home__placeholder h2 {
  margin: 12px 0 4px;
  font-size: 20px;
  font-weight: 600;
  color: var(--bt-text);
}
.home__placeholder p {
  margin: 0;
  font-size: var(--bt-fs-md);
}
.home__placeholder kbd {
  background: var(--bt-bg-elevated);
  color: var(--bt-text);
  padding: 1px 6px;
  border: 1px solid var(--bt-border);
  border-radius: 3px;
  font-family: var(--bt-font-mono);
  font-size: var(--bt-fs-xs);
  margin: 0 2px;
}

.home__toast {
  position: fixed;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  z-index: 9000;
  padding: 8px 14px;
  background: var(--bt-bg-elevated);
  color: var(--bt-text);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius);
  box-shadow: var(--bt-shadow-md);
  font-size: var(--bt-fs-sm);
}

.bt-toast-enter-active,
.bt-toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.bt-toast-enter-from,
.bt-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>
