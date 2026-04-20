<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Copy,
  FolderOpen,
  KeyRound,
  Loader2,
  Network,
  Plug,
  Plus,
  Search,
  Server,
  Star,
  Trash2,
  X,
  XCircle,
} from "@renderer/lib/icons";
import { useSessionsStore } from "@renderer/stores/sessions";
import type { Session, SessionInput } from "@shared/types";

type Draft = {
  id?: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKeyPath: string;
};

const props = defineProps<{
  open: boolean;
  /** When provided, the dialog opens with this session pre-selected. */
  initialSessionId?: string | null;
}>();

const emit = defineEmits<{
  (
    e: "close",
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
          /** Set if the form was loaded from a saved session. */
          sessionId?: string;
        },
  ): void;
}>();

const sessions = useSessionsStore();

const draft = ref<Draft>(blankDraft());
const selectedId = ref<string | null>(null);
const search = ref("");
const isDirty = ref(false);
const errorMsg = ref<string>("");
const ioBusy = ref<"import" | "export" | null>(null);
const ioMsg = ref<string>("");

/* Test-connection state. We don't surface a numeric latency or banner
 * info — the goal is a binary "yes the credentials/host work" answer
 * that catches typos before the user clicks Login and gets dropped
 * into a half-broken tab. */
type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; cwd: string; ms: number }
  | { status: "fail"; message: string };
const testState = ref<TestState>({ status: "idle" });

const hostInputRef = ref<HTMLInputElement | null>(null);

function blankDraft(): Draft {
  return {
    id: undefined,
    name: "",
    group: "",
    host: "",
    port: 22,
    username: "",
    password: "",
    privateKeyPath: "",
  };
}

function loadFromSession(s: Session): void {
  draft.value = {
    id: s.id,
    name: s.name,
    group: s.group ?? "",
    host: s.host,
    port: s.port,
    username: s.username,
    password: "",
    privateKeyPath: s.privateKeyPath ?? "",
  };
  isDirty.value = false;
  errorMsg.value = "";
}

function pickSession(id: string): void {
  selectedId.value = id;
  const s = sessions.byId(id);
  if (s) loadFromSession(s);
}

function newSite(): void {
  selectedId.value = null;
  draft.value = blankDraft();
  draft.value.name = "New Site";
  isDirty.value = false;
  errorMsg.value = "";
  void nextTick(() => hostInputRef.value?.focus());
}

const filteredGroups = computed(() => {
  const q = search.value.trim().toLowerCase();
  const groups = sessions.grouped;
  if (!q) return groups;
  return groups
    .map((g) => ({
      group: g.group,
      items: g.items.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.host.toLowerCase().includes(q) ||
          s.username.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.items.length > 0);
});

const canLogin = computed(
  () =>
    draft.value.host.trim().length > 0 &&
    draft.value.username.trim().length > 0 &&
    draft.value.port >= 1 &&
    draft.value.port <= 65535,
);

const canSave = computed(() => canLogin.value && draft.value.name.trim().length > 0);

watch(
  draft,
  () => {
    isDirty.value = true;
    /* Any field edit invalidates the previous test result — keeping a
     * stale "OK" badge after the user mutates host/credentials would
     * be misleading. */
    if (testState.value.status !== "running") {
      testState.value = { status: "idle" };
    }
  },
  { deep: true },
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    errorMsg.value = "";
    if (!sessions.loaded) await sessions.load();
    const initial = props.initialSessionId ?? null;
    if (initial) {
      pickSession(initial);
    } else if (sessions.sessions.length > 0 && !selectedId.value) {
      pickSession(sessions.sessions[0].id);
    } else if (!selectedId.value) {
      newSite();
    }
    void nextTick(() => hostInputRef.value?.focus());
  },
  { immediate: true },
);

async function browseKey(): Promise<void> {
  const r = await window.api.dialog.openFile();
  if (r.ok && r.data) draft.value.privateKeyPath = r.data;
}

function toSessionInput(d: Draft): SessionInput {
  return {
    name: d.name.trim() || `${d.username}@${d.host}`,
    group: d.group.trim() || undefined,
    protocol: "sftp",
    host: d.host.trim(),
    port: d.port,
    username: d.username.trim(),
    privateKeyPath: d.privateKeyPath.trim() || undefined,
  };
}

async function saveSite(): Promise<void> {
  if (!canSave.value) {
    errorMsg.value = "Name, host and username are required.";
    return;
  }
  errorMsg.value = "";
  const input = toSessionInput(draft.value);
  if (draft.value.id) {
    const updated = await sessions.update(draft.value.id, input);
    if (updated) {
      isDirty.value = false;
      selectedId.value = updated.id;
    }
  } else {
    const created = await sessions.create(input);
    if (created) {
      draft.value.id = created.id;
      isDirty.value = false;
      selectedId.value = created.id;
    }
  }
}

async function duplicateSite(): Promise<void> {
  if (!selectedId.value) return;
  const dup = await sessions.duplicate(selectedId.value);
  if (dup) {
    selectedId.value = dup.id;
    loadFromSession(dup);
  }
}

async function deleteSite(): Promise<void> {
  if (!selectedId.value) return;
  const ok = await sessions.remove(selectedId.value);
  if (ok) {
    selectedId.value = null;
    newSite();
  }
}

async function exportSites(): Promise<void> {
  if (ioBusy.value) return;
  if (sessions.sessions.length === 0) {
    ioMsg.value = "No sites to export.";
    return;
  }
  ioBusy.value = "export";
  ioMsg.value = "";
  try {
    const r = await sessions.exportToFile();
    if (!r) {
      ioMsg.value = sessions.error ?? "Export failed.";
      return;
    }
    if (!r.path) {
      ioMsg.value = "";
      return;
    }
    ioMsg.value = `Exported ${r.count} ${r.count === 1 ? "site" : "sites"}.`;
  } finally {
    ioBusy.value = null;
  }
}

async function importSites(): Promise<void> {
  if (ioBusy.value) return;
  ioBusy.value = "import";
  ioMsg.value = "";
  try {
    const r = await sessions.importFromFile();
    if (!r) {
      ioMsg.value = sessions.error ?? "Import failed.";
      return;
    }
    if (!r.path) {
      ioMsg.value = "";
      return;
    }
    const parts: string[] = [];
    parts.push(`${r.added} added`);
    if (r.skipped > 0) parts.push(`${r.skipped} skipped (duplicate)`);
    if (r.invalid > 0) parts.push(`${r.invalid} invalid`);
    ioMsg.value = `Imported: ${parts.join(", ")}.`;
    /* If import landed at least one site and nothing is selected yet,
     * select the first imported one so the form isn't sitting on an
     * empty draft. */
    if (r.added > 0 && !selectedId.value && sessions.sessions.length > 0) {
      pickSession(sessions.sessions[0].id);
    }
  } finally {
    ioBusy.value = null;
  }
}

/**
 * Open a throwaway SFTP session purely to verify the host/credentials,
 * then immediately tear it down. Reports a friendly success/failure
 * message inline so the user can iterate on a typo without round-
 * tripping through a real connection attempt that would commit a tab.
 */
async function testConnection(): Promise<void> {
  if (!canLogin.value) {
    testState.value = {
      status: "fail",
      message: "Host and username are required.",
    };
    return;
  }
  testState.value = { status: "running" };
  errorMsg.value = "";
  const started = performance.now();
  const input = {
    host: draft.value.host.trim(),
    port: draft.value.port,
    username: draft.value.username.trim(),
    password: draft.value.password || undefined,
    privateKeyPath: draft.value.privateKeyPath.trim() || undefined,
  };
  const r = await window.api.sftp.connect(input);
  if (!r.ok) {
    testState.value = {
      status: "fail",
      message: r.error.message || "Connection failed.",
    };
    return;
  }
  const { connectionId } = r.data;
  try {
    /* `cwd` is the cheapest round-trip we can do that proves the
     * SFTP subsystem actually came up — `connect` alone only proves
     * the SSH transport handshake succeeded. */
    const cwd = await window.api.sftp.cwd(connectionId);
    if (!cwd.ok) {
      testState.value = {
        status: "fail",
        message: cwd.error.message || "SFTP subsystem unreachable.",
      };
      return;
    }
    testState.value = {
      status: "ok",
      cwd: cwd.data,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    /* Always release the throwaway session — keeping it open would
     * leak a TCP connection per click of Test. */
    await window.api.sftp.disconnect(connectionId).catch(() => {
      /* Disconnect failures here are non-fatal; the main process will
       * GC the client when its socket eventually times out. */
    });
  }
}

function login(): void {
  if (!canLogin.value) {
    errorMsg.value = "Host and username are required.";
    return;
  }
  emit("close", {
    action: "login",
    input: {
      host: draft.value.host.trim(),
      port: draft.value.port,
      username: draft.value.username.trim(),
      privateKeyPath: draft.value.privateKeyPath.trim() || undefined,
    },
    password: draft.value.password || undefined,
    sessionId: draft.value.id,
  });
}

function cancel(): void {
  emit("close", { action: "cancel" });
}

function onBackdropMouseDown(e: MouseEvent): void {
  if (e.target === e.currentTarget) cancel();
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    login();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <transition name="bt-cd">
    <div
      v-if="open"
      class="cd-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cd-title"
      @mousedown="onBackdropMouseDown"
    >
      <div class="cd">
        <header class="cd__head">
          <div class="cd__title" id="cd-title">
            <Plug :size="16" />
            <span>Login</span>
          </div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Close"
            @click="cancel"
          >
            <X :size="14" />
          </button>
        </header>

        <div class="cd__body">
          <!-- LEFT: saved sessions -->
          <aside class="cd__list">
            <div class="cd__list-toolbar">
              <button
                type="button"
                class="bt-btn bt-btn--primary cd__new"
                @click="newSite"
              >
                <Plus :size="13" />
                <span>New Site</span>
              </button>
              <div class="cd__io">
                <button
                  type="button"
                  class="bt-btn cd__io-btn"
                  data-tooltip="Import sites from file"
                  :disabled="ioBusy !== null"
                  :aria-busy="ioBusy === 'import'"
                  @click="importSites"
                >
                  <ArrowDownToLine :size="13" />
                  <span>Import</span>
                </button>
                <button
                  type="button"
                  class="bt-btn cd__io-btn"
                  data-tooltip="Export sites to file (no passwords)"
                  :disabled="ioBusy !== null || sessions.sessions.length === 0"
                  :aria-busy="ioBusy === 'export'"
                  @click="exportSites"
                >
                  <ArrowUpFromLine :size="13" />
                  <span>Export</span>
                </button>
              </div>
            </div>

            <label class="cd__search bt-field">
              <Search :size="13" class="cd__search-icon" />
              <input
                v-model="search"
                class="bt-input"
                type="search"
                spellcheck="false"
                placeholder="Search sites…"
              />
            </label>

            <div class="cd__list-scroll" role="listbox" aria-label="Saved sites">
              <div
                v-if="!sessions.loaded || sessions.sessions.length === 0"
                class="cd__empty"
              >
                <Star :size="16" />
                <p>No saved sites yet.</p>
                <p class="cd__empty-sub">
                  Fill the form on the right and click <strong>Save</strong>.
                </p>
              </div>

              <template v-else>
                <div v-for="g in filteredGroups" :key="g.group" class="cd__group">
                  <div class="cd__group-head">
                    <Network :size="11" />
                    <span>{{ g.group }}</span>
                  </div>
                  <button
                    v-for="s in g.items"
                    :key="s.id"
                    type="button"
                    role="option"
                    class="cd__item"
                    :class="{ 'cd__item--sel': s.id === selectedId }"
                    :aria-selected="s.id === selectedId"
                    @click="pickSession(s.id)"
                    @dblclick="
                      pickSession(s.id);
                      login();
                    "
                  >
                    <Server :size="13" class="cd__item-icon" />
                    <span class="cd__item-main">
                      <span class="cd__item-name bt-truncate" :title="s.name">
                        {{ s.name }}
                      </span>
                      <span class="cd__item-sub bt-truncate">
                        {{ s.username }}@{{ s.host }}<span v-if="s.port !== 22">:{{ s.port }}</span>
                      </span>
                    </span>
                  </button>
                </div>
              </template>
            </div>

            <div v-if="ioMsg" class="cd__io-msg" role="status">{{ ioMsg }}</div>
          </aside>

          <div class="cd__splitter" aria-hidden="true" />

          <!-- RIGHT: form -->
          <section class="cd__form">
            <div class="cd__form-grid">
              <label class="bt-field bt-field--col cd__col-name">
                <span class="bt-label">Site name</span>
                <input
                  v-model="draft.name"
                  class="bt-input"
                  spellcheck="false"
                  placeholder="My production server"
                  autocomplete="off"
                />
              </label>

              <label class="bt-field bt-field--col cd__col-group">
                <span class="bt-label">Group (optional)</span>
                <input
                  v-model="draft.group"
                  class="bt-input"
                  spellcheck="false"
                  placeholder="e.g. Staging"
                  autocomplete="off"
                />
              </label>

              <label class="bt-field bt-field--col cd__col-host">
                <span class="bt-label">Host name</span>
                <input
                  ref="hostInputRef"
                  v-model="draft.host"
                  class="bt-input"
                  spellcheck="false"
                  placeholder="example.com"
                  autocomplete="off"
                />
              </label>

              <label class="bt-field bt-field--col cd__col-port">
                <span class="bt-label">Port</span>
                <input
                  v-model.number="draft.port"
                  type="number"
                  min="1"
                  max="65535"
                  class="bt-input"
                  placeholder="22"
                />
              </label>

              <label class="bt-field bt-field--col cd__col-user">
                <span class="bt-label">User name</span>
                <input
                  v-model="draft.username"
                  class="bt-input"
                  spellcheck="false"
                  placeholder="root"
                  autocomplete="off"
                />
              </label>

              <label class="bt-field bt-field--col cd__col-pwd">
                <span class="bt-label">Password</span>
                <input
                  v-model="draft.password"
                  type="password"
                  class="bt-input"
                  autocomplete="new-password"
                  placeholder="Optional if using key"
                />
              </label>

              <label class="bt-field bt-field--col cd__col-key">
                <span class="bt-label">Private key file</span>
                <div class="cd__filerow">
                  <input
                    v-model="draft.privateKeyPath"
                    class="bt-input"
                    spellcheck="false"
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <button type="button" class="bt-btn" @click="browseKey">
                    <FolderOpen :size="13" />
                    <span>Browse…</span>
                  </button>
                </div>
              </label>
            </div>

            <div class="cd__hint">
              <KeyRound :size="13" />
              <span>Passwords are not saved to disk.</span>
            </div>

            <div v-if="errorMsg" class="cd__error" role="alert">
              {{ errorMsg }}
            </div>

            <div
              v-if="testState.status === 'ok'"
              class="cd__test-result cd__test-result--ok"
              role="status"
            >
              <CheckCircle2 :size="14" />
              <span>
                Connected to <strong>{{ draft.host }}</strong> in
                {{ testState.ms }} ms (cwd: {{ testState.cwd }}).
              </span>
            </div>
            <div
              v-else-if="testState.status === 'fail'"
              class="cd__test-result cd__test-result--fail"
              role="alert"
            >
              <XCircle :size="14" />
              <span>{{ testState.message }}</span>
            </div>
          </section>
        </div>

        <footer class="cd__foot">
          <div class="cd__foot-left">
            <button
              type="button"
              class="bt-btn"
              :disabled="!canSave"
              @click="saveSite"
            >
              <Star :size="13" />
              <span>{{ draft.id ? "Save" : "Save as site" }}</span>
            </button>
            <button
              type="button"
              class="bt-btn"
              :disabled="!selectedId"
              @click="duplicateSite"
            >
              <Copy :size="13" />
              <span>Duplicate</span>
            </button>
            <button
              type="button"
              class="bt-btn bt-btn--danger"
              :disabled="!selectedId"
              @click="deleteSite"
            >
              <Trash2 :size="13" />
              <span>Delete</span>
            </button>
          </div>
          <div class="cd__foot-right">
            <button
              type="button"
              class="bt-btn"
              data-tooltip="Verify host & credentials without opening a tab"
              :disabled="!canLogin || testState.status === 'running'"
              :aria-busy="testState.status === 'running'"
              @click="testConnection"
            >
              <Loader2
                v-if="testState.status === 'running'"
                :size="13"
                class="cd__spin"
              />
              <Activity v-else :size="13" />
              <span>{{
                testState.status === "running" ? "Testing…" : "Test"
              }}</span>
            </button>
            <button type="button" class="bt-btn" @click="cancel">Cancel</button>
            <button
              type="button"
              class="bt-btn bt-btn--primary"
              :disabled="!canLogin"
              @click="login"
            >
              <Plug :size="13" />
              <span>Login</span>
            </button>
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
  z-index: 7500;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.cd {
  /* Sized to feel proportional to a typical FlowSFTP window
   * (~1000–1200px wide). The clamps keep it compact on small windows
   * without growing past usable proportions on huge displays. */
  width: min(100%, 720px);
  max-width: calc(100vw - 32px);
  height: min(520px, calc(100vh - 48px));
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cd__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.cd__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
}

.cd__body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.cd__list {
  flex: 0 0 220px;
  display: flex;
  flex-direction: column;
  background: var(--bt-bg);
  border-right: 1px solid var(--bt-border);
  min-height: 0;
}
.cd__list-toolbar {
  padding: 10px;
  border-bottom: 1px solid var(--bt-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cd__new {
  width: 100%;
  justify-content: center;
}
.cd__io {
  display: flex;
  gap: 6px;
}
.cd__io-btn {
  flex: 1 1 0;
  justify-content: center;
  padding-inline: 6px;
}
.cd__io-msg {
  padding: 6px 10px 8px;
  border-top: 1px solid var(--bt-border-subtle);
  background: var(--bt-bg);
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-xs);
  line-height: 1.3;
}

.cd__search {
  position: relative;
  margin: 8px 10px;
}
.cd__search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--bt-text-muted);
  pointer-events: none;
}
.cd__search .bt-input {
  padding-left: 26px;
}

.cd__list-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 6px 8px;
}

.cd__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 24px 12px;
  color: var(--bt-text-muted);
}
.cd__empty p {
  margin: 0;
  font-size: var(--bt-fs-sm);
}
.cd__empty-sub {
  color: var(--bt-text-muted);
}

.cd__group + .cd__group {
  margin-top: 8px;
}
.cd__group-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--bt-text-muted);
}

.cd__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--bt-radius-sm);
  text-align: left;
  color: var(--bt-text);
  cursor: pointer;
  font: inherit;
}
.cd__item:hover {
  background: var(--bt-row-hover);
}
.cd__item--sel,
.cd__item--sel:hover {
  background: var(--bt-accent-soft);
  border-color: color-mix(in srgb, var(--bt-accent) 35%, transparent);
}
.cd__item-icon {
  color: var(--bt-text-muted);
  flex: 0 0 auto;
}
.cd__item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}
.cd__item-name {
  font-size: var(--bt-fs-sm);
  font-weight: 500;
}
.cd__item-sub {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
}

.cd__splitter {
  flex: 0 0 1px;
  align-self: stretch;
  background: var(--bt-border);
}

.cd__form {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding: 18px 20px 12px;
  min-width: 0;
  overflow-y: auto;
}

.cd__form-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 12px 14px;
}
.bt-field--col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}
.cd__col-name {
  grid-column: 1 / span 1;
}
.cd__col-group {
  grid-column: 2 / span 1;
}
.cd__col-host {
  grid-column: 1 / span 1;
}
.cd__col-port {
  grid-column: 2 / span 1;
}
.cd__col-user {
  grid-column: 1 / span 1;
}
.cd__col-pwd {
  grid-column: 2 / span 1;
}
.cd__col-key {
  grid-column: 1 / span 2;
}

.cd__filerow {
  display: flex;
  gap: 8px;
}
.cd__filerow .bt-input {
  flex: 1 1 auto;
  min-width: 0;
}

.cd__hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-xs);
}

.cd__error {
  margin-top: 10px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--bt-danger) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--bt-danger) 40%, transparent);
  color: var(--bt-danger);
  border-radius: var(--bt-radius-sm);
  font-size: var(--bt-fs-sm);
}

.cd__test-result {
  margin-top: 8px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: var(--bt-radius-sm);
  font-size: var(--bt-fs-sm);
  border: 1px solid transparent;
  line-height: 1.35;
}
.cd__test-result--ok {
  background: color-mix(in srgb, var(--bt-success, #16a34a) 12%, transparent);
  border-color: color-mix(in srgb, var(--bt-success, #16a34a) 40%, transparent);
  color: var(--bt-success, #16a34a);
}
.cd__test-result--fail {
  background: color-mix(in srgb, var(--bt-danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--bt-danger) 40%, transparent);
  color: var(--bt-danger);
}
.cd__test-result strong {
  font-weight: 600;
}

.cd__spin {
  animation: cd-spin 0.9s linear infinite;
}
@keyframes cd-spin {
  to {
    transform: rotate(360deg);
  }
}

.cd__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}
.cd__foot-left,
.cd__foot-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.18s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}
.bt-cd-enter-active .cd,
.bt-cd-leave-active .cd {
  transition: transform 0.18s ease;
}
.bt-cd-enter-from .cd,
.bt-cd-leave-to .cd {
  transform: translateY(8px);
}
</style>
