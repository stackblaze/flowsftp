/**
 * File/folder icon URL resolution for the dual-pane file browser.
 *
 * Wraps the {@link https://www.npmjs.com/package/vscode-material-icons | vscode-material-icons}
 * package — a self-hosted re-publish of the VS Code Material Icon Theme
 * SVGs. The SVGs themselves are copied into the renderer build at
 * `/material-icons/<name>.svg` by the `vite-plugin-static-copy` block in
 * `electron.vite.config.ts`, so the URLs returned here resolve identically
 * in `electron-vite dev` (served by Vite) and `electron-vite build`
 * (loaded from disk via `file://`).
 *
 * Why a thin wrapper instead of calling the package directly?
 *  - One place to set the {@link ICONS_URL} base path.
 *  - Single seam for handling our `LocalListEntry`/`RemoteListEntry`
 *    "type" union — including symlinks (no Material Icons concept) and
 *    "other" entries (sockets, devices, FIFOs, etc.) which fall back to
 *    a sensible default rather than emitting a confusing per-extension
 *    icon for a non-file inode.
 *  - Lets us swap the icon set later without touching every call site.
 */
import {
  getIconForDirectoryPath,
  getIconForFilePath,
  getIconUrlByName,
  type MaterialIcon,
} from "vscode-material-icons";
import type { LocalListEntry, RemoteListEntry } from "@shared/types";

/** Base URL where the SVGs are served from. Must match the `dest` field
 *  in the `viteStaticCopy` target in `electron.vite.config.ts`. Leading
 *  slash is required so the path resolves from the renderer root regardless
 *  of which view is currently mounted. */
const ICONS_URL = "/material-icons";

type AnyEntry = LocalListEntry | RemoteListEntry;

/**
 * Resolve the icon URL to display next to a directory entry.
 *
 * Priority order:
 *  1. `dir`        → folder icon (Material's `getIconForDirectoryPath` picks
 *                    a themed folder when the name matches, e.g. `node_modules`,
 *                    `.git`, `src`, `dist`).
 *  2. `link`       → generic file icon. Material doesn't ship a symlink
 *                    glyph, and inferring the target's type would require
 *                    an extra round-trip we'd rather not pay during list
 *                    rendering. The visible "→" arrow elsewhere in the row
 *                    already telegraphs link-ness.
 *  3. `other`      → generic file icon (sockets/devices/FIFOs).
 *  4. `file`       → name-based file icon, falling back to the package's
 *                    default `file` glyph for anything unrecognized.
 */
export function iconUrlForEntry(entry: AnyEntry): string {
  if (entry.type === "dir") {
    const name = getIconForDirectoryPath(entry.name);
    return getIconUrlByName(name, ICONS_URL);
  }
  if (entry.type === "link" || entry.type === "other") {
    return genericFileIconUrl();
  }
  const name = getIconForFilePath(entry.name);
  return getIconUrlByName(name, ICONS_URL);
}

/** Generic folder icon URL, useful for placeholder rows (e.g. the
 *  "create folder" inline editor) where there's no entry yet. */
export function genericFolderIconUrl(): string {
  return getIconUrlByName("folder" as MaterialIcon, ICONS_URL);
}

/** Generic file icon URL, useful for placeholder rows or fallback states. */
export function genericFileIconUrl(): string {
  return getIconUrlByName("file" as MaterialIcon, ICONS_URL);
}
