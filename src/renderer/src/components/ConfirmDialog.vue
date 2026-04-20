<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  X,
} from "@renderer/lib/icons";
import { HelpCircle } from "lucide-vue-next";

type IconKind = "warning" | "info" | "question" | "danger";
type Variant = "default" | "danger";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    message: string;
    details?: string[];
    confirmText?: string;
    cancelText?: string;
    variant?: Variant;
    icon?: IconKind;
    /** When true the confirm action is in progress: both buttons disable,
     *  the confirm label swaps to `busyText`, a spinner appears, and the
     *  dialog ignores Escape / Enter / backdrop dismiss so the user can't
     *  accidentally close it before the operation finishes. */
    busy?: boolean;
    busyText?: string;
  }>(),
  {
    title: "Confirm",
    details: () => [],
    confirmText: "OK",
    cancelText: "Cancel",
    variant: "default",
    icon: undefined,
    busy: false,
    busyText: "Working…",
  },
);

const emit = defineEmits<{
  (e: "close", result: { confirmed: boolean }): void;
}>();

const confirmBtnRef = ref<HTMLButtonElement | null>(null);

const effectiveIcon = computed<IconKind>(() => {
  if (props.icon) return props.icon;
  return props.variant === "danger" ? "danger" : "question";
});

const iconComponent = computed(() => {
  switch (effectiveIcon.value) {
    case "warning":
    case "danger":
      return AlertCircle;
    case "info":
      return Info;
    case "question":
      return HelpCircle;
    default:
      return CheckCircle2;
  }
});

const iconClass = computed(() => {
  switch (effectiveIcon.value) {
    case "danger":
      return "cfm__icon cfm__icon--danger";
    case "warning":
      return "cfm__icon cfm__icon--warning";
    case "info":
      return "cfm__icon cfm__icon--info";
    case "question":
    default:
      return "cfm__icon cfm__icon--neutral";
  }
});

const hasDetails = computed(
  () => Array.isArray(props.details) && props.details.length > 0,
);

function confirm(): void {
  if (props.busy) return;
  emit("close", { confirmed: true });
}

function cancel(): void {
  if (props.busy) return;
  emit("close", { confirmed: false });
}

function onBackdropMouseDown(e: MouseEvent): void {
  if (props.busy) return;
  if (e.target === e.currentTarget) cancel();
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (props.busy) {
    // Swallow Escape/Enter while busy so the user can't dismiss or re-fire.
    if (e.key === "Escape" || e.key === "Enter") e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  } else if (e.key === "Enter") {
    e.preventDefault();
    confirm();
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void nextTick(() => confirmBtnRef.value?.focus());
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
      :aria-labelledby="'cfm-title'"
      @mousedown="onBackdropMouseDown"
    >
      <div class="cfm">
        <header class="cfm__head">
          <div class="cfm__title" id="cfm-title">{{ title }}</div>
          <button
            type="button"
            class="bt-iconbtn"
            data-tooltip="Close"
            :disabled="busy"
            @click="cancel"
          >
            <X :size="14" />
          </button>
        </header>

        <div class="cfm__body">
          <component :is="iconComponent" :size="24" :class="iconClass" />
          <div class="cfm__text">
            <p class="cfm__message">{{ message }}</p>
            <ul v-if="hasDetails" class="cfm__details bt-mono">
              <li v-for="(d, i) in details" :key="i" class="bt-truncate" :title="d">
                {{ d }}
              </li>
            </ul>
          </div>
        </div>

        <footer class="cfm__foot">
          <button
            type="button"
            class="bt-btn"
            :disabled="busy"
            @click="cancel"
          >
            {{ cancelText }}
          </button>
          <button
            ref="confirmBtnRef"
            type="button"
            class="bt-btn cfm__confirm"
            :class="
              variant === 'danger' ? 'bt-btn--danger' : 'bt-btn--primary'
            "
            :disabled="busy"
            :aria-busy="busy"
            @click="confirm"
          >
            <Loader2 v-if="busy" :size="13" class="cfm__spin" />
            <span>{{ busy ? busyText : confirmText }}</span>
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
  z-index: 7600;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.cfm {
  width: 100%;
  max-width: 440px;
  background: var(--bt-bg-elevated);
  border: 1px solid var(--bt-border);
  border-radius: var(--bt-radius-lg);
  box-shadow: var(--bt-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cfm__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-bottom: 1px solid var(--bt-border);
}
.cfm__title {
  font-size: var(--bt-fs-md);
  font-weight: 600;
  color: var(--bt-text);
}

.cfm__body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 18px 14px;
}
.cfm__icon {
  flex: 0 0 auto;
  margin-top: 2px;
}
.cfm__icon--danger {
  color: var(--bt-danger);
}
.cfm__icon--warning {
  color: var(--bt-warning);
}
.cfm__icon--info {
  color: var(--bt-info);
}
.cfm__icon--neutral {
  color: var(--bt-accent);
}

.cfm__text {
  min-width: 0;
  flex: 1 1 auto;
}
.cfm__message {
  margin: 0;
  color: var(--bt-text);
  font-size: var(--bt-fs-md);
  line-height: 1.45;
  white-space: pre-wrap;
}

.cfm__details {
  margin: 10px 0 0;
  padding: 8px 10px;
  list-style: none;
  background: var(--bt-bg);
  border: 1px solid var(--bt-border-subtle);
  border-radius: var(--bt-radius-sm);
  font-size: var(--bt-fs-xs);
  color: var(--bt-text-muted);
  max-height: 180px;
  overflow-y: auto;
}
.cfm__details li {
  padding: 1px 0;
}

.cfm__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bt-bg);
  border-top: 1px solid var(--bt-border);
}

.cfm__confirm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cfm__spin {
  animation: cfm-spin 1s linear infinite;
}
@keyframes cfm-spin {
  to {
    transform: rotate(360deg);
  }
}

.bt-cd-enter-active,
.bt-cd-leave-active {
  transition: opacity 0.18s ease;
}
.bt-cd-enter-from,
.bt-cd-leave-to {
  opacity: 0;
}
.bt-cd-enter-active .cfm,
.bt-cd-leave-active .cfm {
  transition: transform 0.18s ease;
}
.bt-cd-enter-from .cfm,
.bt-cd-leave-to .cfm {
  transform: translateY(8px);
}
</style>
