<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FolderOpen, KeyRound, Settings, Shield, X } from "@renderer/lib/icons";

type SessionInput = {
  id?: string;
  name: string;
  group?: string;
  protocol: "sftp";
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  notes?: string;
};

type DialogResult =
  | { action: "save"; session: SessionInput; password?: string }
  | { action: "save-connect"; session: SessionInput; password?: string }
  | { action: "cancel" };

const props = defineProps<{
  open: boolean;
  /** When provided, the dialog edits this session. Otherwise it creates a new one. */
  initial?: Partial<SessionInput> | null;
  title?: string;
}>();

const emit = defineEmits<{
  (e: "close", result: DialogResult): void;
}>();

const tab = ref<"general" | "auth" | "advanced">("general");

const form = ref<SessionInput>(blank());
const password = ref<string>("");
const dialogRef = ref<HTMLDivElement | null>(null);

function blank(): SessionInput {
  return {
    name: "",
    group: "Saved sessions",
    protocol: "sftp",
    host: "",
    port: 22,
    username: "",
    privateKeyPath: "",
    notes: "",
  };
}

function reset(): void {
  form.value = { ...blank(), ...(props.initial ?? {}) };
  password.value = "";
  tab.value = "general";
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      reset();
      await nextTick();
      dialogRef.value?.focus();
    }
  },
);

watch(
  () => props.initial,
  () => {
    if (props.open) reset();
  },
  { deep: true },
);

const saveDisabled = computed(() => {
  return !form.value.name.trim() || !form.value.host.trim() || !form.value.username.trim();
});

async function browseKey(): Promise<void> {
  const res = await window.api.dialog.openFile();
  if (res.ok && res.data) form.value.privateKeyPath = res.data;
}

function close(): void {
  emit("close", { action: "cancel" });
}

function save(): void {
  if (saveDisabled.value) return;
  emit("close", {
    action: "save",
    session: { ...form.value },
    password: password.value || undefined,
  });
}

function saveAndConnect(): void {
  if (saveDisabled.value) return;
  emit("close", {
    action: "save-connect",
    session: { ...form.value },
    password: password.value || undefined,
  });
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="modal" @mousedown.self="close">
      <div
        ref="dialogRef"
        class="modal__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="title || 'Session'"
        tabindex="-1"
      >
        <header class="modal__header">
          <h2 class="modal__title">
            {{ title || (initial?.id ? "Edit session" : "New session") }}
          </h2>
          <button
            type="button"
            class="bt-iconbtn"
            aria-label="Close"
            @click="close"
          >
            <X :size="14" />
          </button>
        </header>

        <nav class="modal__tabs" role="tablist">
          <button
            type="button"
            class="modal__tab"
            :class="{ 'modal__tab--active': tab === 'general' }"
            role="tab"
            :aria-selected="tab === 'general'"
            @click="tab = 'general'"
          >
            <Settings :size="13" />
            <span>General</span>
          </button>
          <button
            type="button"
            class="modal__tab"
            :class="{ 'modal__tab--active': tab === 'auth' }"
            role="tab"
            :aria-selected="tab === 'auth'"
            @click="tab = 'auth'"
          >
            <Shield :size="13" />
            <span>Authentication</span>
          </button>
          <button
            type="button"
            class="modal__tab"
            :class="{ 'modal__tab--active': tab === 'advanced' }"
            role="tab"
            :aria-selected="tab === 'advanced'"
            @click="tab = 'advanced'"
          >
            <KeyRound :size="13" />
            <span>Advanced</span>
          </button>
        </nav>

        <div class="modal__body">
          <section v-show="tab === 'general'" class="modal__section">
            <div class="modal__grid">
              <label class="bt-field bt-field--col">
                <span class="bt-label">Name</span>
                <input
                  v-model="form.name"
                  class="bt-input"
                  placeholder="My production server"
                  autocomplete="off"
                />
              </label>
              <label class="bt-field bt-field--col">
                <span class="bt-label">Group</span>
                <input
                  v-model="form.group"
                  class="bt-input"
                  placeholder="Saved sessions"
                  autocomplete="off"
                />
              </label>
              <label class="bt-field bt-field--col modal__col-host">
                <span class="bt-label">Host</span>
                <input
                  v-model="form.host"
                  class="bt-input"
                  placeholder="example.com"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
              <label class="bt-field bt-field--col modal__col-port">
                <span class="bt-label">Port</span>
                <input
                  v-model.number="form.port"
                  type="number"
                  min="1"
                  max="65535"
                  class="bt-input"
                />
              </label>
              <label class="bt-field bt-field--col">
                <span class="bt-label">Username</span>
                <input
                  v-model="form.username"
                  class="bt-input"
                  placeholder="root"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
              <label class="bt-field bt-field--col modal__col-protocol">
                <span class="bt-label">Protocol</span>
                <input
                  class="bt-input"
                  value="SFTP"
                  disabled
                  aria-disabled="true"
                />
              </label>
              <label class="bt-field bt-field--col modal__col-notes">
                <span class="bt-label">Notes</span>
                <textarea
                  v-model="form.notes"
                  class="bt-textarea"
                  rows="3"
                  placeholder="Optional notes (not synced)"
                />
              </label>
            </div>
          </section>

          <section v-show="tab === 'auth'" class="modal__section">
            <p class="modal__note">
              <Shield :size="13" />
              Passwords are
              <strong>never persisted</strong> — they live only in this dialog
              for the current connection attempt.
            </p>
            <label class="bt-field bt-field--col">
              <span class="bt-label">Password</span>
              <input
                v-model="password"
                type="password"
                class="bt-input"
                autocomplete="new-password"
                placeholder="Leave blank to use private key"
              />
            </label>
            <label class="bt-field bt-field--col">
              <span class="bt-label">Private key path</span>
              <div class="modal__filerow">
                <input
                  v-model="form.privateKeyPath"
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
          </section>

          <section v-show="tab === 'advanced'" class="modal__section">
            <div class="modal__placeholder">
              <KeyRound :size="20" />
              <h3>Advanced options</h3>
              <p>
                Connection multiplexing, keepalives, ciphers and proxy settings
                will live here in a later milestone.
              </p>
            </div>
          </section>
        </div>

        <footer class="modal__footer">
          <button type="button" class="bt-btn" @click="close">Cancel</button>
          <div class="modal__footer-spacer" />
          <button
            type="button"
            class="bt-btn"
            :disabled="saveDisabled"
            @click="save"
          >
            Save
          </button>
          <button
            type="button"
            class="bt-btn bt-btn--primary"
            :disabled="saveDisabled"
            @click="saveAndConnect"
          >
            Save &amp; connect
          </button>
        </footer>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bt-overlay);
  backdrop-filter: blur(2px);
}

.modal__panel {
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: var(--bt-bg-elevated);
  color: var(--bt-text);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  outline: none;
  overflow: hidden;
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--bt-border);
}
.modal__title {
  margin: 0;
  font-size: var(--bt-fs-lg);
  font-weight: 600;
}

.modal__tabs {
  display: flex;
  align-items: stretch;
  padding: 0 12px;
  gap: 2px;
  border-bottom: 1px solid var(--bt-border);
  background: var(--bt-bg);
}
.modal__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--bt-text-muted);
  cursor: pointer;
  font-size: var(--bt-fs-sm);
  border-bottom: 2px solid transparent;
}
.modal__tab:hover {
  color: var(--bt-text);
}
.modal__tab--active {
  color: var(--bt-accent);
  border-bottom-color: var(--bt-accent);
}

.modal__body {
  padding: 16px;
  overflow: auto;
  flex: 1 1 auto;
  min-height: 0;
}

.modal__section {
  display: block;
}

.modal__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.modal__col-host {
  grid-column: 1 / span 1;
}
.modal__col-port {
  grid-column: 2 / span 1;
}
.modal__col-protocol {
  grid-column: 2 / span 1;
}
.modal__col-notes {
  grid-column: 1 / span 2;
}

.bt-field--col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}

.modal__filerow {
  display: flex;
  gap: 8px;
}
.modal__filerow .bt-input {
  flex: 1 1 auto;
  min-width: 0;
}

.modal__note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: var(--bt-radius);
  background: var(--bt-accent-soft);
  color: var(--bt-text);
  font-size: var(--bt-fs-sm);
}

.modal__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 32px;
  color: var(--bt-text-muted);
}
.modal__placeholder h3 {
  margin: 4px 0 0;
  font-size: var(--bt-fs-lg);
  color: var(--bt-text);
}
.modal__placeholder p {
  margin: 0;
  font-size: var(--bt-fs-sm);
}

.modal__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--bt-border);
  background: var(--bt-bg);
}
.modal__footer-spacer {
  flex: 1 1 auto;
}

.bt-textarea {
  width: 100%;
  padding: 6px 10px;
  background: var(--bt-bg-elevated);
  color: var(--bt-text);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-sm);
  font-size: var(--bt-fs-md);
  outline: none;
  resize: vertical;
  min-height: 60px;
  font-family: var(--bt-font-sans);
}
.bt-textarea:focus {
  border-color: var(--bt-accent);
  box-shadow: var(--bt-focus);
}
</style>
