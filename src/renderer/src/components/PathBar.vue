<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronRight, PencilLine, Server } from "@renderer/lib/icons";

const props = defineProps<{
  path: string;
  pane: "local" | "remote";
}>();
const emit = defineEmits<{
  (e: "navigate", path: string): void;
}>();

const editing = ref(false);
const draft = ref(props.path);
const inputRef = ref<HTMLInputElement | null>(null);

watch(
  () => props.path,
  (p) => {
    if (!editing.value) draft.value = p;
  },
);

type Crumb = { label: string; path: string };

const crumbs = computed<Crumb[]>(() => {
  const p = props.path || (props.pane === "remote" ? "/" : "");
  if (props.pane === "remote") {
    if (!p || p === "/") return [{ label: "/", path: "/" }];
    const parts = p.split("/").filter(Boolean);
    const acc: Crumb[] = [{ label: "/", path: "/" }];
    let cur = "";
    for (const part of parts) {
      cur = cur === "" ? `/${part}` : `${cur}/${part}`;
      acc.push({ label: part, path: cur });
    }
    return acc;
  }

  // Local: support both POSIX and Windows.
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    const drive = p.slice(0, 2);
    const rest = p.slice(3).replace(/\\/g, "/");
    const parts = rest.split("/").filter(Boolean);
    const acc: Crumb[] = [{ label: `${drive}\\`, path: `${drive}\\` }];
    let cur = `${drive}\\`;
    for (const part of parts) {
      cur = cur.endsWith("\\") ? `${cur}${part}` : `${cur}\\${part}`;
      acc.push({ label: part, path: cur });
    }
    return acc;
  }

  if (!p) return [{ label: "Computer", path: "/" }];
  const parts = p.split("/").filter(Boolean);
  const acc: Crumb[] = [{ label: "/", path: "/" }];
  let cur = "";
  for (const part of parts) {
    cur = cur === "" ? `/${part}` : `${cur}/${part}`;
    acc.push({ label: part, path: cur });
  }
  return acc;
});

async function startEdit(): Promise<void> {
  draft.value = props.path;
  editing.value = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
}

function commitEdit(): void {
  editing.value = false;
  if (draft.value !== props.path) emit("navigate", draft.value);
}

function cancelEdit(): void {
  editing.value = false;
  draft.value = props.path;
}
</script>

<template>
  <div class="pathbar" :class="`pathbar--${pane}`">
    <span class="pathbar__leader">
      <Server :size="13" />
    </span>

    <div v-if="!editing" class="pathbar__crumbs" role="list">
      <template v-for="(c, i) in crumbs" :key="c.path + i">
        <button
          type="button"
          class="pathbar__crumb"
          :class="{ 'pathbar__crumb--last': i === crumbs.length - 1 }"
          :title="c.path"
          @click="emit('navigate', c.path)"
        >
          {{ c.label }}
        </button>
        <ChevronRight
          v-if="i < crumbs.length - 1"
          :size="11"
          class="pathbar__sep"
        />
      </template>
    </div>

    <input
      v-else
      ref="inputRef"
      v-model="draft"
      class="pathbar__input"
      spellcheck="false"
      autocomplete="off"
      @keydown.enter.prevent="commitEdit"
      @keydown.esc.prevent="cancelEdit"
      @blur="commitEdit"
    />

    <button
      type="button"
      class="bt-iconbtn pathbar__edit"
      :data-tooltip="editing ? 'Apply path' : 'Edit path'"
      @click="editing ? commitEdit() : startEdit()"
    >
      <PencilLine :size="13" />
    </button>
  </div>
</template>

<style scoped>
.pathbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 6px;
  background: var(--bt-bg-elevated);
  border-bottom: 1px solid var(--bt-border);
  font-size: var(--bt-fs-sm);
  min-width: 0;
}

.pathbar__leader {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--bt-text-subtle);
  padding-right: 2px;
}

.pathbar__crumbs {
  display: flex;
  align-items: center;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.pathbar__crumb {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 6px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 3px;
  cursor: pointer;
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-sm);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pathbar__crumb:hover {
  background: var(--bt-row-hover);
  color: var(--bt-text);
}
.pathbar__crumb--last {
  color: var(--bt-text);
  font-weight: 600;
}

.pathbar__sep {
  color: var(--bt-text-subtle);
  flex: 0 0 auto;
}

.pathbar__input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  background: var(--bt-bg);
  color: var(--bt-text);
  border: 1px solid var(--bt-accent);
  border-radius: var(--bt-radius-sm);
  outline: none;
  font-size: var(--bt-fs-sm);
  font-family: var(--bt-font-mono);
}

.pathbar__edit {
  width: 22px;
  height: 22px;
}
</style>
