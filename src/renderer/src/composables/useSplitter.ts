import { onMounted, ref, watch } from "vue";

export type SplitterAxis = "x" | "y";

export type SplitterOptions = {
  /** localStorage key to remember the resolved size. */
  storageKey?: string;
  /** Initial size in pixels (used when no stored value present). */
  defaultSize: number;
  /** Minimum size in pixels. */
  min?: number;
  /** Maximum size in pixels. */
  max?: number;
  /** Axis being resized. `"x"` -> width, `"y"` -> height. */
  axis: SplitterAxis;
  /** When true, drag direction is inverted (e.g. right-anchored panel). */
  invert?: boolean;
};

/**
 * Generic splitter composable. Returns a reactive `size` and a `startDrag`
 * handler suitable for `@mousedown` on a splitter element. Persists the
 * resolved size under `options.storageKey` when provided.
 *
 * Usage:
 *   const { size, isDragging, startDrag } = useSplitter({
 *     storageKey: "bt:sidebar:width",
 *     defaultSize: 240,
 *     min: 180,
 *     max: 480,
 *     axis: "x",
 *   })
 */
export function useSplitter(options: SplitterOptions): {
  size: ReturnType<typeof ref<number>>;
  isDragging: ReturnType<typeof ref<boolean>>;
  startDrag: (e: MouseEvent) => void;
  reset: () => void;
} {
  const { storageKey, defaultSize, axis, invert = false } = options;
  const min = options.min ?? 80;
  const max = options.max ?? 1200;

  const size = ref<number>(readInitial());
  const isDragging = ref<boolean>(false);

  function readInitial(): number {
    if (!storageKey) return defaultSize;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return defaultSize;
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n)) return defaultSize;
      return clamp(n);
    } catch {
      return defaultSize;
    }
  }

  function clamp(n: number): number {
    return Math.min(max, Math.max(min, n));
  }

  function persist(n: number): void {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(n));
    } catch {
      /* ignore */
    }
  }

  watch(size, (n) => persist(n));

  function startDrag(e: MouseEvent): void {
    e.preventDefault();
    isDragging.value = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = size.value ?? defaultSize;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent): void => {
      const delta =
        axis === "x" ? ev.clientX - startX : ev.clientY - startY;
      const next = clamp(startSize + (invert ? -delta : delta));
      size.value = next;
    };

    const onUp = (): void => {
      isDragging.value = false;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  onMounted(() => {
    /* nothing to do on mount; size is initialized eagerly */
  });

  return {
    size,
    isDragging,
    startDrag,
    reset: () => {
      size.value = defaultSize;
    },
  };
}
