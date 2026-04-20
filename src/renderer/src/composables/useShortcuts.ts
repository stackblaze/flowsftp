import { onBeforeUnmount, onMounted } from "vue";

export type ShortcutHandlers = {
  /** Ctrl/Cmd+T: open a new tab. */
  newTab?: () => void;
  /** Ctrl/Cmd+W: close the active tab. */
  closeTab?: () => void;
  /** Ctrl/Cmd+N: open a new Synctron window. */
  newWindow?: () => void;
  /** Ctrl/Cmd+R: refresh both panes of the active tab. (was F5) */
  refreshAll?: () => void;
  /** F5: WinSCP "Copy" — transfer the focused pane's selection across. */
  copySelection?: () => void;
  /** F6: WinSCP "Move" — copy the selection across, then delete the source. */
  moveSelection?: () => void;
  /** Backspace or Alt+Up: parent dir of focused pane. */
  goUp?: () => void;
  /** Ctrl/Cmd+L: open the Login dialog. */
  openLogin?: () => void;
  /** Del: delete the current pane's selection. Skipped when typing. */
  deleteSelection?: () => void;
  /** F2: rename the focused entry. */
  renameFocused?: () => void;
  /** F7: create a new folder in the focused pane. */
  newFolder?: () => void;
  /** F4: edit the focused file (open in editor). */
  editFocused?: () => void;
  /** Ctrl+H: toggle showing hidden (dotfile) entries in the focused pane. */
  toggleHidden?: () => void;
  /** Ctrl/Cmd+S: open the WinSCP-style Synchronize dialog. */
  openSync?: () => void;
};

/**
 * Wires global keyboard shortcuts to the supplied handlers. Registered on
 * mount, cleaned up on unmount. Skips events that originate from form fields
 * or `contenteditable` elements unless explicitly safe (e.g. F-keys, command
 * combos with a non-typing modifier).
 *
 * Bindings:
 * - Ctrl/Cmd+T  -> newTab
 * - Ctrl/Cmd+W  -> closeTab
 * - Ctrl/Cmd+N  -> newWindow
 * - Ctrl/Cmd+R  -> refreshAll
 * - F5          -> copySelection (WinSCP)
 * - F6          -> moveSelection (WinSCP)
 * - Backspace   -> goUp (only outside text inputs / inline editors)
 * - Alt+Up      -> goUp
 * - Ctrl/Cmd+L  -> openLogin
 * - Del         -> deleteSelection (only outside text inputs)
 * - F2          -> renameFocused
 * - F7          -> newFolder
 * - F4          -> editFocused
 * - Ctrl+H      -> toggleHidden (no Shift; Cmd+H is reserved by macOS)
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const typing = isTypingTarget(e.target);

    if (mod && !e.shiftKey && key.toLowerCase() === "t") {
      e.preventDefault();
      handlers.newTab?.();
      return;
    }
    if (mod && !e.shiftKey && key.toLowerCase() === "w") {
      e.preventDefault();
      handlers.closeTab?.();
      return;
    }
    if (mod && !e.shiftKey && key.toLowerCase() === "n") {
      e.preventDefault();
      handlers.newWindow?.();
      return;
    }
    if (mod && !e.shiftKey && key.toLowerCase() === "l") {
      e.preventDefault();
      handlers.openLogin?.();
      return;
    }
    if (mod && !e.shiftKey && key.toLowerCase() === "r") {
      e.preventDefault();
      handlers.refreshAll?.();
      return;
    }
    if (mod && !e.shiftKey && key.toLowerCase() === "s") {
      e.preventDefault();
      handlers.openSync?.();
      return;
    }
    /* Ctrl+H: toggle hidden. We deliberately use Ctrl rather than Cmd on
     * macOS — Cmd+H is reserved by the OS for "Hide application". */
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && key.toLowerCase() === "h") {
      e.preventDefault();
      handlers.toggleHidden?.();
      return;
    }
    if (key === "F5" && !typing) {
      e.preventDefault();
      handlers.copySelection?.();
      return;
    }
    if (key === "F6" && !typing) {
      e.preventDefault();
      handlers.moveSelection?.();
      return;
    }
    if (key === "F2") {
      e.preventDefault();
      handlers.renameFocused?.();
      return;
    }
    if (key === "F4") {
      e.preventDefault();
      handlers.editFocused?.();
      return;
    }
    if (key === "F7") {
      e.preventDefault();
      handlers.newFolder?.();
      return;
    }
    if (key === "Delete" && !typing) {
      e.preventDefault();
      handlers.deleteSelection?.();
      return;
    }
    if (e.altKey && key === "ArrowUp") {
      e.preventDefault();
      handlers.goUp?.();
      return;
    }
    if (key === "Backspace" && !typing && !mod && !e.altKey) {
      e.preventDefault();
      handlers.goUp?.();
      return;
    }
  }

  onMounted(() => window.addEventListener("keydown", onKey));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
}
