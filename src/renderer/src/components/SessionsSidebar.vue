<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  Plus,
  Search,
  Server,
  Trash2,
} from "@renderer/lib/icons";

type Session = {
  id: string;
  name: string;
  group?: string;
  protocol: "sftp";
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

const props = defineProps<{
  sessions: Session[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  (e: "create"): void;
  (e: "edit", id: string): void;
  (e: "duplicate", id: string): void;
  (e: "remove", id: string): void;
  (e: "open", id: string): void;
  (e: "openInNewTab", id: string): void;
}>();

const filter = ref("");
const collapsedGroups = ref<Record<string, boolean>>({});
const searchInput = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.sessions;
  return props.sessions.filter((s) => {
    const hay =
      `${s.name} ${s.host} ${s.username} ${s.group ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
});

const grouped = computed<{ name: string; items: Session[] }[]>(() => {
  const map = new Map<string, Session[]>();
  for (const s of filtered.value) {
    const g = s.group?.trim() || "Saved sessions";
    const arr = map.get(g);
    if (arr) arr.push(s);
    else map.set(g, [s]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => ({
      name,
      items: items.sort((x, y) => x.name.localeCompare(y.name)),
    }));
});

function toggleGroup(name: string): void {
  collapsedGroups.value[name] = !collapsedGroups.value[name];
}

function focusSearch(): void {
  searchInput.value?.focus();
  searchInput.value?.select();
}

defineExpose({ focusSearch });
</script>

<template>
  <aside class="sidebar" aria-label="Sessions">
    <header class="sidebar__head">
      <div class="sidebar__title">
        <span>Sessions</span>
        <span class="sidebar__count">{{ sessions.length }}</span>
      </div>
      <div class="sidebar__head-actions">
        <button
          type="button"
          class="bt-iconbtn"
          data-tooltip="New session"
          @click="emit('create')"
        >
          <Plus :size="14" />
        </button>
        <button
          type="button"
          class="bt-iconbtn"
          data-tooltip="Search sessions (Ctrl/Cmd+Shift+P)"
          @click="focusSearch"
        >
          <Search :size="14" />
        </button>
      </div>
    </header>

    <div class="sidebar__search">
      <Search :size="13" class="sidebar__search-icon" />
      <input
        ref="searchInput"
        v-model="filter"
        class="sidebar__search-input"
        placeholder="Filter sessions…"
        spellcheck="false"
        autocomplete="off"
      />
    </div>

    <div class="sidebar__list" role="list">
      <div v-if="!loaded" class="sidebar__empty">
        Loading sessions…
      </div>
      <div v-else-if="sessions.length === 0" class="sidebar__empty">
        <Server :size="20" />
        <p>No saved sessions yet.</p>
        <button
          type="button"
          class="bt-btn bt-btn--primary sidebar__empty-cta"
          @click="emit('create')"
        >
          <Plus :size="13" />
          Create one
        </button>
      </div>
      <div v-else-if="filtered.length === 0" class="sidebar__empty">
        No sessions match “{{ filter }}”.
      </div>

      <template v-for="group in grouped" :key="group.name">
        <div class="sidebar__group">
          <button
            type="button"
            class="sidebar__group-head"
            @click="toggleGroup(group.name)"
          >
            <ChevronDown
              v-if="!collapsedGroups[group.name]"
              :size="12"
            />
            <ChevronRight v-else :size="12" />
            <span class="sidebar__group-name">{{ group.name }}</span>
            <span class="sidebar__group-count">{{ group.items.length }}</span>
          </button>
          <div v-if="!collapsedGroups[group.name]" class="sidebar__group-items">
            <div
              v-for="s in group.items"
              :key="s.id"
              class="session"
              :title="`${s.username}@${s.host}:${s.port}`"
              role="listitem"
              tabindex="0"
              @click="emit('open', s.id)"
              @dblclick="emit('open', s.id)"
              @keydown.enter="emit('open', s.id)"
            >
              <span class="session__icon">
                <Server :size="13" />
              </span>
              <div class="session__main bt-truncate">
                <div class="session__name bt-truncate">{{ s.name }}</div>
                <div class="session__sub bt-truncate">
                  {{ s.username }}@{{ s.host }}:{{ s.port }}
                </div>
              </div>
              <div class="session__actions">
                <button
                  type="button"
                  class="bt-iconbtn session__action"
                  data-tooltip="Open in new tab"
                  @click.stop="emit('openInNewTab', s.id)"
                >
                  <ExternalLink :size="12" />
                </button>
                <button
                  type="button"
                  class="bt-iconbtn session__action"
                  data-tooltip="Edit session"
                  @click.stop="emit('edit', s.id)"
                >
                  <Edit3 :size="12" />
                </button>
                <button
                  type="button"
                  class="bt-iconbtn session__action"
                  data-tooltip="Duplicate"
                  @click.stop="emit('duplicate', s.id)"
                >
                  <Copy :size="12" />
                </button>
                <button
                  type="button"
                  class="bt-iconbtn session__action session__action--danger"
                  data-tooltip="Delete"
                  @click.stop="emit('remove', s.id)"
                >
                  <Trash2 :size="12" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bt-sidebar);
  border-right: 1px solid var(--bt-border);
  min-width: 0;
}

.sidebar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--bt-border);
}
.sidebar__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--bt-fs-sm);
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--bt-text-muted);
}
.sidebar__count {
  font-size: var(--bt-fs-xs);
  font-weight: 500;
  color: var(--bt-text-subtle);
  letter-spacing: 0;
}
.sidebar__head-actions {
  display: flex;
  gap: 2px;
}

.sidebar__search {
  position: relative;
  padding: 6px 8px;
  border-bottom: 1px solid var(--bt-border);
}
.sidebar__search-icon {
  position: absolute;
  top: 50%;
  left: 14px;
  transform: translateY(-50%);
  color: var(--bt-text-subtle);
  pointer-events: none;
}
.sidebar__search-input {
  width: 100%;
  padding: 5px 8px 5px 26px;
  background: var(--bt-bg-elevated);
  color: var(--bt-text);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-sm);
  outline: none;
  font-size: var(--bt-fs-sm);
}
.sidebar__search-input:focus {
  border-color: var(--bt-accent);
  box-shadow: var(--bt-focus);
}

.sidebar__list {
  flex: 1 1 auto;
  overflow: auto;
  padding-bottom: 8px;
}

.sidebar__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-sm);
}
.sidebar__empty p {
  margin: 0;
}
.sidebar__empty-cta {
  margin-top: 4px;
}

.sidebar__group {
  margin-top: 8px;
}

.sidebar__group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
}
.sidebar__group-head:hover {
  color: var(--bt-text);
}
.sidebar__group-name {
  flex: 1 1 auto;
  text-align: left;
}
.sidebar__group-count {
  color: var(--bt-text-subtle);
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}

.sidebar__group-items {
  display: flex;
  flex-direction: column;
  padding: 2px 0;
}

.session {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 10px;
  cursor: pointer;
  outline: none;
  border-left: 2px solid transparent;
}
.session:hover,
.session:focus-visible {
  background: var(--bt-row-hover);
  border-left-color: var(--bt-accent);
}

.session__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--bt-text-subtle);
}
.session:hover .session__icon {
  color: var(--bt-accent);
}

.session__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.session__name {
  font-size: var(--bt-fs-md);
  color: var(--bt-text);
}
.session__sub {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-subtle);
  font-family: var(--bt-font-mono);
}

.session__actions {
  display: flex;
  gap: 0;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.session:hover .session__actions,
.session:focus-within .session__actions {
  opacity: 1;
}
.session__action {
  width: 22px;
  height: 22px;
}
.session__action--danger:hover {
  color: var(--bt-danger);
}
</style>
