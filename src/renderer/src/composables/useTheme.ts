import { onMounted, onUnmounted, ref, watch } from "vue";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "bt:theme";

const mode = ref<ThemeMode>(readInitialMode());
const resolved = ref<ResolvedTheme>(resolveTheme(mode.value));

function readInitialMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore unavailable storage */
  }
  return "system";
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(m: ThemeMode): ResolvedTheme {
  if (m === "system") return prefersDark() ? "dark" : "light";
  return m;
}

function applyTheme(t: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (t === "dark") html.classList.add("dark");
  else html.classList.remove("dark");
  html.dataset.theme = t;
}

let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;
let watcherInstalled = false;

function installSystemWatcher(): void {
  if (watcherInstalled || typeof window === "undefined" || !window.matchMedia) {
    return;
  }
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaListener = (): void => {
    if (mode.value === "system") {
      resolved.value = resolveTheme("system");
      applyTheme(resolved.value);
    }
  };
  mediaQuery.addEventListener("change", mediaListener);
  watcherInstalled = true;
}

watch(
  mode,
  (m) => {
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
    resolved.value = resolveTheme(m);
    applyTheme(resolved.value);
  },
  { immediate: true },
);

/**
 * Theme controller. Reads/writes `localStorage["bt:theme"]` and listens to
 * `prefers-color-scheme` when in `"system"` mode. Toggles a `.dark` class on
 * `<html>` to drive the CSS-variable palette in `assets/main.css`.
 */
export function useTheme(): {
  mode: typeof mode;
  resolved: typeof resolved;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
} {
  onMounted(() => installSystemWatcher());
  onUnmounted(() => {
    /* shared watcher persists across component lifecycles */
  });

  return {
    mode,
    resolved,
    setMode: (m) => {
      mode.value = m;
    },
    cycle: () => {
      mode.value =
        mode.value === "system"
          ? "light"
          : mode.value === "light"
            ? "dark"
            : "system";
    },
  };
}
