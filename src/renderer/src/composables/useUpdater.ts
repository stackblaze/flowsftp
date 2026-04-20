/**
 * Renderer-side projection of the main-process update state machine.
 *
 * Exposes a singleton `state` ref so multiple components (a status badge,
 * the menu, the dialog itself) can subscribe without each one opening
 * its own IPC channel. The composable also wires the menu command
 * `checkForUpdates` to a "show the dialog" action — clicking the menu
 * item should land the user in the right place no matter where they
 * triggered it from.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { UpdateState } from "@shared/types";

const _state = ref<UpdateState>({ status: "idle", currentVersion: "" });
const _dialogOpen = ref<boolean>(false);

let _wired = false;
let _unsubscribe: (() => void) | null = null;
let _refCount = 0;

function ensureWired(): void {
  if (_wired) return;
  _wired = true;
  /* Pull initial snapshot so first render isn't "idle" if the engine
   * already settled. */
  void window.api.update.getState().then((r) => {
    if (r.ok) _state.value = r.data;
  });
  _unsubscribe = window.api.update.onChange((s) => {
    _state.value = s;
    /* Auto-pop the dialog the moment an update appears — users want to
     * know without hunting through menus. We don't auto-pop on
     * `not-available` because that would be intrusive after a manual
     * check; the menu handler shows the dialog explicitly in that case. */
    if (s.status === "available" || s.status === "downloaded") {
      _dialogOpen.value = true;
    }
  });
}

export function useUpdater(): {
  state: typeof _state;
  dialogOpen: typeof _dialogOpen;
  openDialog: () => void;
  closeDialog: () => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
} {
  onMounted(() => {
    _refCount++;
    ensureWired();
  });
  onBeforeUnmount(() => {
    _refCount--;
    if (_refCount <= 0 && _unsubscribe) {
      _unsubscribe();
      _unsubscribe = null;
      _wired = false;
    }
  });

  return {
    state: _state,
    dialogOpen: _dialogOpen,
    openDialog: () => {
      _dialogOpen.value = true;
    },
    closeDialog: () => {
      _dialogOpen.value = false;
    },
    check: async () => {
      const r = await window.api.update.check();
      if (r.ok) _state.value = r.data;
    },
    download: async () => {
      const r = await window.api.update.download();
      if (r.ok) _state.value = r.data;
    },
    install: async () => {
      const r = await window.api.update.install();
      if (r.ok) _state.value = r.data;
    },
  };
}
