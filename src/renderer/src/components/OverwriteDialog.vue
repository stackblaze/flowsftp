<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { AlertCircle, X } from "@renderer/lib/icons";

/** What the caller learns from the dialog. */
export type OverwriteChoice = "cancel" | "skip" | "overwrite";

/** A single conflict to display in the list. We keep this minimal so the
 *  dialog is reusable for any caller that has a (path, side) pair. */
export type OverwriteConflict = {
  dst: string;
  /** Used purely to label the conflict, e.g. "remote" / "local". */
  side: "local" | "remote";
};

const props = defineProps<{
  open: boolean;
  conflicts: OverwriteConflict[];
  /** Total transfer count — lets the message phrase "5 of 12 files exist" so
   *  the user understands "Skip existing" still queues the rest. */
  totalCount: number;
}>();

const emit = defineEmits<{
  (e: "close", choice: OverwriteChoice): void;
}>();

const overwriteBtnRef = ref<HTMLButtonElement | null>(null);

const headline = computed<string>(() => {
  const n = props.conflicts.length;
  if (props.totalCount > n) {
    return `${n} of ${props.totalCount} files already exist at the destination.`;
  }
  return n === 1
    ? "1 file already exists at the destination."
    : `${n} files already exist at the destination.`;
});

const subline = computed<string>(() =>
  props.conflicts[0]?.side === "remote"
    ? "Overwriting will replace the file on the server."
    : "Overwriting will replace the file on your computer.",
);

function choose(choice: OverwriteChoice): void {
  emit("close", choice);
}

function onBackdropMouseDown(e: MouseEvent): void {
  if (e.target === e.currentTarget) choose("cancel");
}

/** Esc cancels (safe default). Enter triggers Overwrite to match the focused
 *  button's affordance — but only when the focus is on the dialog so we
 *  don't hijack typing in some other field. */
function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    choose("cancel");
  } else if (e.key === "Enter") {
    e.preventDefault();
    choose("overwrite");
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void nextTick(() => overwriteBtnRef.value?.focus());
  },
  { immediate: true },
);

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
      aria-labelledby="ow-title"
      @mousedown="onBackdropMouseDown"
    >
      <div class="ow">
        <header class="ow__head">
          <div class="ow__title" id="ow-title">Overwrite existing files?</div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Close"
            @click="choose('cancel')"
          >
            <X :size="14" />
          </button>
        </header>

        <div class="ow__body">
          <AlertCircle :size="24" class="ow__icon" />
          <div class="ow__text">
            <p class="ow__message">{{ headline }}</p>
            <p class="ow__sub">{{ subline }}</p>
            <ul class="ow__list bt-mono">
              <li
                v-for="c in conflicts"
                :key="c.dst"
                class="bt-truncate"
                :title="c.dst"
              >
                {{ c.dst }}
              </li>
            </ul>
          </div>
        </div>

        <footer class="ow__foot">
          <button type="button" class="bt-btn" @click="choose('cancel')">
            Cancel
          </button>
          <button
            type="button"
            class="bt-btn"
            :disabled="totalCount === conflicts.length"
            :data-tooltip="
              totalCount === conflicts.length
                ? 'All transfers conflict — nothing left to skip to'
                : undefined
            "
            @click="choose('skip')"
          >
            Skip existing
          </button>
          <button
            ref="overwriteBtnRef"
            type="button"
            class="bt-btn bt-btn--danger"
            @click="choose('overwrite')"
          >
            Overwrite all
          </button>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.cd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 7700;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.ow {
  width: 100%;
  max-width: 520px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ow__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.ow__title {
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
}

.ow__body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 18px 14px;
}
.ow__icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--bt-warning);
}
.ow__text {
  min-width: 0;
  flex: 1 1 auto;
}
.ow__message {
  margin: 0;
  color: var(--bt-text);
  font-size: var(--bt-fs-md);
  font-weight: 600;
  line-height: 1.4;
}
.ow__sub {
  margin: 4px 0 10px;
  color: var(--bt-text-muted);
  font-size: var(--bt-fs-sm);
  line-height: 1.4;
}
.ow__list {
  margin: 0;
  padding: 8px 10px;
  list-style: none;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  max-height: 220px;
  overflow-y: auto;
}
.ow__list li {
  padding: 1px 0;
}

.ow__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}

.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.18s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}
.bt-cd-enter-active .ow,
.bt-cd-leave-active .ow {
  transition: transform 0.18s ease;
}
.bt-cd-enter-from .ow,
.bt-cd-leave-to .ow {
  transform: translateY(8px);
}
</style>
