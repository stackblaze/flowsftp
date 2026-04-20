<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ChevronDown } from "@renderer/lib/icons";

type MenuItem =
  | {
      type?: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      onSelect?: () => void;
    }
  | { type: "separator" };

type Menu = {
  id: string;
  label: string;
  items: MenuItem[];
};

const props = defineProps<{ menus: Menu[] }>();

const open = ref<string | null>(null);
const menuPositions = reactive<Record<string, { left: number; top: number }>>(
  {},
);
const root = ref<HTMLElement | null>(null);

function toggle(id: string, e: MouseEvent): void {
  if (open.value === id) {
    open.value = null;
    return;
  }
  open.value = id;
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  menuPositions[id] = { left: rect.left, top: rect.bottom };
}

function hoverSwitch(id: string, e: MouseEvent): void {
  if (open.value === null) return;
  open.value = id;
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  menuPositions[id] = { left: rect.left, top: rect.bottom };
}

function pick(item: MenuItem): void {
  if ("type" in item && item.type === "separator") return;
  if (item.disabled) return;
  open.value = null;
  item.onSelect?.();
}

function onWindowMouseDown(e: MouseEvent): void {
  if (open.value === null) return;
  const t = e.target as Node;
  if (root.value && root.value.contains(t)) return;
  // Also keep open if the click landed inside a floating panel rendered outside root.
  const panels = document.querySelectorAll<HTMLElement>("[data-bt-menu-panel]");
  for (const p of panels) if (p.contains(t)) return;
  open.value = null;
}

function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && open.value !== null) {
    open.value = null;
  }
}

onMounted(() => {
  window.addEventListener("mousedown", onWindowMouseDown);
  window.addEventListener("keydown", onWindowKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onWindowMouseDown);
  window.removeEventListener("keydown", onWindowKey);
});

defineExpose({ menus: props.menus });
</script>

<template>
  <nav ref="root" class="menu" aria-label="Application menu">
    <button
      v-for="m in menus"
      :key="m.id"
      type="button"
      class="menu__btn"
      :class="{ 'menu__btn--active': open === m.id }"
      @click="toggle(m.id, $event)"
      @mouseenter="hoverSwitch(m.id, $event)"
    >
      {{ m.label }}
    </button>

    <div class="menu__brand">
      <span class="menu__brand-dot" />
      <span class="menu__brand-name">FlowSFTP</span>
    </div>

    <teleport to="body">
      <template v-for="m in menus" :key="m.id + '-pop'">
        <div
          v-if="open === m.id"
          data-bt-menu-panel
          class="menu__panel"
          role="menu"
          :style="{
            left: (menuPositions[m.id]?.left ?? 0) + 'px',
            top: (menuPositions[m.id]?.top ?? 0) + 'px',
          }"
        >
          <template v-for="(it, idx) in m.items" :key="idx">
            <div
              v-if="(it as { type?: string }).type === 'separator'"
              class="menu__sep"
            />
            <button
              v-else
              type="button"
              class="menu__item"
              :disabled="(it as { disabled?: boolean }).disabled"
              role="menuitem"
              @click="pick(it)"
            >
              <span class="menu__item-label">{{
                (it as { label: string }).label
              }}</span>
              <span
                v-if="(it as { shortcut?: string }).shortcut"
                class="menu__item-kbd"
                >{{ (it as { shortcut?: string }).shortcut }}</span
              >
              <ChevronDown
                v-if="false"
                :size="12"
                class="menu__item-chevron"
              />
            </button>
          </template>
        </div>
      </template>
    </teleport>
  </nav>
</template>

<style scoped>
.menu {
  display: flex;
  align-items: center;
  gap: 0;
  height: var(--bt-h-menu);
  padding: 0 var(--bt-sp-2);
  background: var(--bt-menu-bg);
  border-bottom: 1px solid var(--bt-border);
  font-size: var(--bt-fs-md);
  -webkit-app-region: drag;
}

.menu__btn {
  -webkit-app-region: no-drag;
  height: 100%;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--bt-text);
  cursor: default;
  font-size: var(--bt-fs-md);
  border-radius: 0;
}

.menu__btn:hover,
.menu__btn--active {
  background: var(--bt-row-hover);
}
.menu__btn--active {
  background: var(--bt-accent-soft);
}

.menu__brand {
  -webkit-app-region: drag;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-right: var(--bt-sp-2);
  font-size: var(--bt-fs-sm);
  color: var(--bt-text-muted);
}
.menu__brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff8a00 0%, #e52e71 100%);
  box-shadow: 0 0 0 2px var(--bt-bg-elevated);
}
.menu__brand-name {
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bt-text);
}
</style>

<style>
.menu__panel {
  position: fixed;
  z-index: 2000;
  min-width: 240px;
  padding: 4px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius);
  box-shadow: var(--bt-shadow-lg);
  font-size: var(--bt-fs-md);
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--bt-text);
  border-radius: var(--bt-radius-sm);
  cursor: pointer;
  font-size: var(--bt-fs-md);
}
.menu__item:hover:not(:disabled) {
  background: var(--bt-accent);
  color: #fff;
}
.menu__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.menu__item-label {
  flex: 1 1 auto;
}
.menu__item-kbd {
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  font-family: var(--bt-font-mono);
}
.menu__item:hover:not(:disabled) .menu__item-kbd {
  color: rgba(255, 255, 255, 0.85);
}
.menu__sep {
  height: 1px;
  background: var(--bt-border);
  margin: 4px 0;
}
</style>
