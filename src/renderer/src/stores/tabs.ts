import { defineStore } from "pinia";
import type {
  FileStat,
  LocalListEntry,
  RemoteListEntry,
  Result,
  SftpConnectInput,
} from "@shared/types";
import {
  fileName,
  joinRemotePath,
  parentLocalPath,
  parentRemotePath,
} from "@renderer/lib/paths";
import { useSessionsStore } from "./sessions";
import { useQueueStore } from "./queue";

export type TabDraft = {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
};

export type Pane = "local" | "remote";
export type SortCol = "name" | "size" | "mtime" | "perm" | "type";
export type SortDir = "asc" | "desc";
export type SortState = { col: SortCol; dir: SortDir };

export type TabState = {
  id: string;
  sessionId: string | null;
  title: string;
  connectionId: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  localPath: string;
  remotePath: string;
  localEntries: LocalListEntry[];
  remoteEntries: RemoteListEntry[];
  /** Primary (last clicked) selection — kept for backwards compat. Mirrors
   * the last entry of selectedLocalSet/selectedRemoteSet. */
  selectedLocal: string | null;
  selectedRemote: string | null;
  /** Full multi-selection set (all selected paths in this pane). */
  selectedLocalSet: string[];
  selectedRemoteSet: string[];
  /** Last clicked / arrow-focus target — used as the anchor for Shift+click
   * range selection and keyboard navigation. */
  focusedLocal: string | null;
  focusedRemote: string | null;
  sortLocal: SortState;
  sortRemote: SortState;
  showHiddenLocal: boolean;
  showHiddenRemote: boolean;
  statusMessage: string;
  draft: TabDraft;
};

type RemoteCacheEntry = {
  entries: RemoteListEntry[];
  fetchedAt: number;
};

/**
 * In-memory directory cache for the remote pane (WinSCP-style).
 * Keyed by tabId, then by remote path. Cleared on disconnect/close.
 * Used by navigateRemote() for instant paint with stale-while-revalidate.
 */
type RemoteCaches = Record<string, Record<string, RemoteCacheEntry>>;

/** Max age before a cache entry is considered "stale" — still served instantly,
 * but a background refresh is kicked off. Older than HARD_TTL is dropped. */
const STALE_AFTER_MS = 15_000;
const HARD_TTL_MS = 5 * 60_000;

type State = {
  tabs: TabState[];
  activeTabId: string | null;
  homeLocal: string;
  remoteCaches: RemoteCaches;
  /** In-flight remote list fetches, keyed by `${tabId}::${path}` so duplicate
   * navigations don't double-fetch. */
  remoteInFlight: Record<string, Promise<void>>;
};

let nextId = 0;
function makeTabId(): string {
  nextId++;
  return `tab-${Date.now().toString(36)}-${nextId}`;
}

function defaultLocalPath(): string {
  // Filled async via app.getPaths in openFromSession; fallback for SSR/tests.
  return "/";
}

/* --- Persisted per-pane view defaults ------------------------------------ */

type PaneViewDefaults = {
  sortLocal: SortState;
  sortRemote: SortState;
  showHiddenLocal: boolean;
  showHiddenRemote: boolean;
};

const VIEW_STORAGE_KEY = "bt:pane:view";

function defaultPaneView(): PaneViewDefaults {
  return {
    sortLocal: { col: "name", dir: "asc" },
    sortRemote: { col: "name", dir: "asc" },
    showHiddenLocal: false,
    showHiddenRemote: false,
  };
}

function loadPaneView(): PaneViewDefaults {
  const fallback = defaultPaneView();
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PaneViewDefaults>;
    return {
      sortLocal: normalizeSort(parsed.sortLocal) ?? fallback.sortLocal,
      sortRemote: normalizeSort(parsed.sortRemote) ?? fallback.sortRemote,
      showHiddenLocal:
        typeof parsed.showHiddenLocal === "boolean"
          ? parsed.showHiddenLocal
          : fallback.showHiddenLocal,
      showHiddenRemote:
        typeof parsed.showHiddenRemote === "boolean"
          ? parsed.showHiddenRemote
          : fallback.showHiddenRemote,
    };
  } catch {
    return fallback;
  }
}

function normalizeSort(s: Partial<SortState> | undefined): SortState | null {
  if (!s) return null;
  const validCols: SortCol[] = ["name", "size", "mtime", "perm"];
  const validDirs: SortDir[] = ["asc", "desc"];
  if (
    typeof s.col === "string" &&
    validCols.includes(s.col as SortCol) &&
    typeof s.dir === "string" &&
    validDirs.includes(s.dir as SortDir)
  ) {
    return { col: s.col as SortCol, dir: s.dir as SortDir };
  }
  return null;
}

function savePaneView(v: PaneViewDefaults): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/* --- File ops API ad-hoc shape ------------------------------------------- */
/* The preload FlowSftpApi is owned by Agent A who is adding mkdir/rename/remove/
 * chmod/stat surfaces. We type a local extension shape so we can call them
 * without modifying preload. */
type FsOpsApi = {
  fs: {
    local: {
      mkdir: (path: string) => Promise<Result<void>>;
      rename: (oldPath: string, newPath: string) => Promise<Result<void>>;
      remove: (path: string, recursive: boolean) => Promise<Result<void>>;
      stat: (path: string) => Promise<Result<FileStat>>;
    };
  };
  sftp: {
    mkdir: (connectionId: string, path: string) => Promise<Result<void>>;
    rename: (
      connectionId: string,
      oldPath: string,
      newPath: string,
    ) => Promise<Result<void>>;
    remove: (
      connectionId: string,
      path: string,
      recursive: boolean,
    ) => Promise<Result<void>>;
    chmod: (
      connectionId: string,
      path: string,
      mode: number,
    ) => Promise<Result<void>>;
    stat: (
      connectionId: string,
      path: string,
    ) => Promise<Result<FileStat>>;
  };
};

function fsOps(): FsOpsApi {
  return window.api as unknown as FsOpsApi;
}

function joinLocalPath(cwd: string, name: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(cwd)) {
    const norm = cwd.replace(/\//g, "\\");
    return norm.endsWith("\\") ? `${norm}${name}` : `${norm}\\${name}`;
  }
  if (cwd === "/" || cwd === "") return `/${name}`;
  return `${cwd.replace(/\/$/, "")}/${name}`;
}

function emptyTab(id: string): TabState {
  const v = loadPaneView();
  return {
    id,
    sessionId: null,
    title: "New Tab",
    connectionId: null,
    isConnecting: false,
    isConnected: false,
    localPath: defaultLocalPath(),
    remotePath: "/",
    localEntries: [],
    remoteEntries: [],
    selectedLocal: null,
    selectedRemote: null,
    selectedLocalSet: [],
    selectedRemoteSet: [],
    focusedLocal: null,
    focusedRemote: null,
    sortLocal: v.sortLocal,
    sortRemote: v.sortRemote,
    showHiddenLocal: v.showHiddenLocal,
    showHiddenRemote: v.showHiddenRemote,
    statusMessage: "",
    draft: {},
  };
}

function patchTab(state: State, id: string, patch: Partial<TabState>): void {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  state.tabs[idx] = { ...state.tabs[idx], ...patch };
}

function setSelKeys(
  pane: Pane,
): { set: "selectedLocalSet" | "selectedRemoteSet"; primary: "selectedLocal" | "selectedRemote"; focus: "focusedLocal" | "focusedRemote" } {
  return pane === "local"
    ? {
        set: "selectedLocalSet",
        primary: "selectedLocal",
        focus: "focusedLocal",
      }
    : {
        set: "selectedRemoteSet",
        primary: "selectedRemote",
        focus: "focusedRemote",
      };
}

export const useTabsStore = defineStore("tabs", {
  state: (): State => ({
    tabs: [],
    activeTabId: null,
    homeLocal: "/",
    remoteCaches: {},
    remoteInFlight: {},
  }),
  getters: {
    activeTab(state): TabState | null {
      if (!state.activeTabId) return null;
      return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
    },
    byId: (state) => (id: string) =>
      state.tabs.find((t) => t.id === id) ?? null,
  },
  actions: {
    /** Lazy-load the user's home directory for new-tab defaults. */
    async ensureHome(): Promise<string> {
      if (this.homeLocal && this.homeLocal !== "/") return this.homeLocal;
      const r = await window.api.app.getPaths();
      if (r.ok) this.homeLocal = r.data.home;
      return this.homeLocal;
    },

    /**
     * Open a tab from a saved session (or a blank one when sessionId is null).
     * Returns the new tab id and sets it active.
     */
    openFromSession(sessionId: string | null): string {
      const id = makeTabId();
      const tab = emptyTab(id);
      void this.ensureHome().then((home) => {
        if (tab.localPath === "/" && home) {
          patchTab(this.$state, id, { localPath: home });
          void this.refreshLocal(id);
        }
      });

      if (sessionId) {
        const sessions = useSessionsStore();
        const s = sessions.byId(sessionId);
        if (s) {
          tab.sessionId = s.id;
          tab.title = s.name;
          tab.draft = {
            host: s.host,
            port: s.port,
            username: s.username,
            privateKeyPath: s.privateKeyPath,
          };
        }
      }

      this.tabs = [...this.tabs, tab];
      this.activeTabId = id;
      return id;
    },

    activate(id: string): void {
      if (this.tabs.some((t) => t.id === id)) this.activeTabId = id;
    },

    async close(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab) return;
      if (tab.connectionId) {
        await window.api.sftp.disconnect(tab.connectionId);
      }
      const idx = this.tabs.findIndex((t) => t.id === id);
      this.tabs = this.tabs.filter((t) => t.id !== id);
      delete this.remoteCaches[id];
      if (this.activeTabId === id) {
        const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? this.tabs[0];
        this.activeTabId = next ? next.id : null;
      }
    },

    /* ------- Selection (single-string back-compat) ----------------------- */

    setSelectedLocal(id: string, path: string | null): void {
      const set = path ? [path] : [];
      patchTab(this.$state, id, {
        selectedLocal: path,
        selectedLocalSet: set,
        focusedLocal: path,
      });
    },

    setSelectedRemote(id: string, path: string | null): void {
      const set = path ? [path] : [];
      patchTab(this.$state, id, {
        selectedRemote: path,
        selectedRemoteSet: set,
        focusedRemote: path,
      });
    },

    /* ------- Multi-selection actions ------------------------------------- */

    setSelectionSet(id: string, pane: Pane, paths: string[]): void {
      const k = setSelKeys(pane);
      const last = paths.length > 0 ? paths[paths.length - 1] : null;
      patchTab(this.$state, id, {
        [k.set]: [...paths],
        [k.primary]: last,
        [k.focus]: last,
      } as Partial<TabState>);
    },

    toggleInSelection(id: string, pane: Pane, path: string): void {
      const tab = this.byId(id);
      if (!tab) return;
      const k = setSelKeys(pane);
      const current = tab[k.set] as string[];
      const exists = current.includes(path);
      const next = exists
        ? current.filter((p) => p !== path)
        : [...current, path];
      const last = next.length > 0 ? next[next.length - 1] : null;
      patchTab(this.$state, id, {
        [k.set]: next,
        [k.primary]: last,
        [k.focus]: path,
      } as Partial<TabState>);
    },

    extendSelection(
      id: string,
      pane: Pane,
      anchorPath: string | null,
      toPath: string,
      orderedPaths: string[],
    ): void {
      const k = setSelKeys(pane);
      const anchor = anchorPath ?? toPath;
      const a = orderedPaths.indexOf(anchor);
      const b = orderedPaths.indexOf(toPath);
      if (b === -1) return;
      const [lo, hi] = a === -1 ? [b, b] : a <= b ? [a, b] : [b, a];
      const next = orderedPaths.slice(lo, hi + 1);
      patchTab(this.$state, id, {
        [k.set]: next,
        [k.primary]: toPath,
        [k.focus]: toPath,
      } as Partial<TabState>);
    },

    clearSelection(id: string, pane: Pane): void {
      const k = setSelKeys(pane);
      patchTab(this.$state, id, {
        [k.set]: [],
        [k.primary]: null,
        [k.focus]: null,
      } as Partial<TabState>);
    },

    setFocused(id: string, pane: Pane, path: string | null): void {
      const k = setSelKeys(pane);
      patchTab(this.$state, id, {
        [k.focus]: path,
      } as Partial<TabState>);
    },

    /* ------- View state (sort + hidden) ---------------------------------- */

    setSort(pane: Pane, col: SortCol): void {
      const view = loadPaneView();
      const cur = pane === "local" ? view.sortLocal : view.sortRemote;
      const next: SortState =
        cur.col === col
          ? { col, dir: cur.dir === "asc" ? "desc" : "asc" }
          : { col, dir: "asc" };
      const updated: PaneViewDefaults = {
        ...view,
        ...(pane === "local" ? { sortLocal: next } : { sortRemote: next }),
      };
      savePaneView(updated);
      const key: keyof TabState = pane === "local" ? "sortLocal" : "sortRemote";
      this.tabs = this.tabs.map((t) => ({ ...t, [key]: next }));
    },

    toggleHidden(pane: Pane): void {
      const view = loadPaneView();
      const cur =
        pane === "local" ? view.showHiddenLocal : view.showHiddenRemote;
      const next = !cur;
      const updated: PaneViewDefaults = {
        ...view,
        ...(pane === "local"
          ? { showHiddenLocal: next }
          : { showHiddenRemote: next }),
      };
      savePaneView(updated);
      const key: keyof TabState =
        pane === "local" ? "showHiddenLocal" : "showHiddenRemote";
      this.tabs = this.tabs.map((t) => ({ ...t, [key]: next }));
    },

    /* ------- Navigation -------------------------------------------------- */

    async navigateLocal(id: string, path: string): Promise<void> {
      patchTab(this.$state, id, {
        localPath: path,
        selectedLocal: null,
        selectedLocalSet: [],
        focusedLocal: null,
      });
      await this.refreshLocal(id);
    },

    async navigateRemote(id: string, path: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab) return;

      // Read cache before mutating (cache may be served instantly).
      const cache = this.remoteCaches[id]?.[path];
      const now = Date.now();
      const fresh = cache && now - cache.fetchedAt < STALE_AFTER_MS;
      const usable = cache && now - cache.fetchedAt < HARD_TTL_MS;

      patchTab(this.$state, id, {
        remotePath: path,
        selectedRemote: null,
        selectedRemoteSet: [],
        focusedRemote: null,
        // Paint cached entries immediately for instant navigation.
        remoteEntries: usable ? cache.entries : [],
        statusMessage: usable && !fresh ? "Refreshing…" : "",
      });

      if (fresh) return;
      // Fire-and-forget background refresh (revalidate). Errors land in
      // statusMessage via refreshRemote().
      void this.refreshRemote(id);
    },

    async goUpLocal(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab) return;
      await this.navigateLocal(id, parentLocalPath(tab.localPath));
    },

    async goUpRemote(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab) return;
      await this.navigateRemote(id, parentRemotePath(tab.remotePath));
    },

    async goHomeLocal(id: string): Promise<void> {
      const home = await this.ensureHome();
      await this.navigateLocal(id, home);
    },

    async refreshLocal(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab) return;
      const r = await window.api.fs.local.list(tab.localPath);
      if (r.ok) {
        patchTab(this.$state, id, { localEntries: r.data });
      } else {
        patchTab(this.$state, id, {
          statusMessage: `Local: ${r.error.message}`,
        });
      }
    },

    async refreshRemote(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) return;
      const path = tab.remotePath;
      const key = `${id}::${path}`;

      // Coalesce concurrent fetches for the same tab+path.
      const existing = this.remoteInFlight[key];
      if (existing) {
        await existing;
        return;
      }

      const connectionId = tab.connectionId;
      const fetchPromise = (async (): Promise<void> => {
        const r = await window.api.sftp.list(connectionId, path);
        // Bail if the user navigated away while we were fetching — keep the
        // cache write but don't clobber the now-active path's entries.
        const stillHere = this.byId(id);
        if (r.ok) {
          if (!this.remoteCaches[id]) this.remoteCaches[id] = {};
          this.remoteCaches[id][path] = {
            entries: r.data,
            fetchedAt: Date.now(),
          };
          if (stillHere && stillHere.remotePath === path) {
            patchTab(this.$state, id, {
              remoteEntries: r.data,
              statusMessage: "",
            });
          }
        } else if (stillHere && stillHere.remotePath === path) {
          patchTab(this.$state, id, {
            statusMessage: `Remote: ${r.error.message}`,
          });
        }
      })();

      this.remoteInFlight[key] = fetchPromise;
      try {
        await fetchPromise;
      } finally {
        delete this.remoteInFlight[key];
      }
    },

    /** Drop a single cached path or all cached paths for a tab. */
    invalidateRemoteCache(id: string, path?: string): void {
      const t = this.remoteCaches[id];
      if (!t) return;
      if (path) {
        delete t[path];
      } else {
        delete this.remoteCaches[id];
      }
    },

    /**
     * Prefetch (warm cache) for the parent of the current path so going up is
     * instant. Best-effort, no UI feedback. Skipped if already cached fresh.
     */
    async prefetchRemoteParent(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) return;
      const parent = parentRemotePath(tab.remotePath);
      if (parent === tab.remotePath) return;
      const cached = this.remoteCaches[id]?.[parent];
      if (cached && Date.now() - cached.fetchedAt < STALE_AFTER_MS) return;
      const key = `${id}::${parent}`;
      if (this.remoteInFlight[key] !== undefined) return;
      const connectionId = tab.connectionId;
      const p = (async (): Promise<void> => {
        const r = await window.api.sftp.list(connectionId, parent);
        if (r.ok) {
          if (!this.remoteCaches[id]) this.remoteCaches[id] = {};
          this.remoteCaches[id][parent] = {
            entries: r.data,
            fetchedAt: Date.now(),
          };
        }
      })();
      this.remoteInFlight[key] = p;
      try {
        await p;
      } finally {
        delete this.remoteInFlight[key];
      }
    },

    async connect(
      id: string,
      opts: { password?: string } = {},
    ): Promise<Result<{ connectionId: string }>> {
      const tab = this.byId(id);
      if (!tab) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Tab not found" },
        };
      }
      if (!tab.draft.host || !tab.draft.username) {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "Host and username required" },
        };
      }
      patchTab(this.$state, id, {
        isConnecting: true,
        statusMessage: "Connecting…",
      });
      const input: SftpConnectInput = {
        host: tab.draft.host,
        port: tab.draft.port ?? 22,
        username: tab.draft.username,
        password: opts.password ?? tab.draft.password,
        privateKeyPath: tab.draft.privateKeyPath,
      };
      const r = await window.api.sftp.connect(input);
      if (!r.ok) {
        patchTab(this.$state, id, {
          isConnecting: false,
          isConnected: false,
          statusMessage: r.error.message,
        });
        return r;
      }
      patchTab(this.$state, id, {
        isConnecting: false,
        isConnected: true,
        connectionId: r.data.connectionId,
        statusMessage: "Connected",
        // Never persist the password in the draft after a successful connect.
        draft: { ...tab.draft, password: undefined },
      });
      // Fresh connection — drop any stale cache from a prior session.
      this.invalidateRemoteCache(id);
      // Land in the user's actual home dir (e.g. /home/linux) instead of "/".
      // Most servers refuse writes to /home itself; this avoids the
      // "permission denied" trap when uploading right after connect.
      const cwd = await window.api.sftp.cwd(r.data.connectionId);
      if (cwd.ok && cwd.data && cwd.data !== tab.remotePath) {
        await this.navigateRemote(id, cwd.data);
      } else {
        await this.refreshRemote(id);
      }
      void this.prefetchRemoteParent(id);
      return r;
    },

    async disconnect(id: string): Promise<void> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) return;
      await window.api.sftp.disconnect(tab.connectionId);
      this.invalidateRemoteCache(id);
      patchTab(this.$state, id, {
        connectionId: null,
        isConnected: false,
        remoteEntries: [],
        selectedRemote: null,
        selectedRemoteSet: [],
        focusedRemote: null,
        statusMessage: "Disconnected",
      });
    },

    /**
     * Enqueue the currently-selected local file as an upload job. Skips
     * directories for now (recursive upload comes later).
     * Returns the number of jobs enqueued.
     */
    async enqueueUpload(id: string): Promise<number> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId || !tab.selectedLocal) return 0;
      const entry = tab.localEntries.find((e) => e.path === tab.selectedLocal);
      if (!entry || entry.type !== "file") return 0;
      const queue = useQueueStore();
      const dst = joinRemotePath(tab.remotePath, fileName(entry.path));
      const created = await queue.enqueue([
        {
          connectionId: tab.connectionId,
          kind: "upload",
          src: entry.path,
          dst,
          size: entry.size,
          priority: "normal",
        },
      ]);
      return created.length;
    },

    /**
     * Enqueue the currently-selected remote file as a download to localDst.
     * Skips directories for now.
     */
    async enqueueDownload(id: string, localDst: string): Promise<number> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId || !tab.selectedRemote) return 0;
      const entry = tab.remoteEntries.find(
        (e) => e.path === tab.selectedRemote,
      );
      if (!entry || entry.type !== "file") return 0;
      const queue = useQueueStore();
      const created = await queue.enqueue([
        {
          connectionId: tab.connectionId,
          kind: "download",
          src: entry.path,
          dst: localDst,
          size: entry.size,
          priority: "normal",
        },
      ]);
      return created.length;
    },

    /* ------- File operations -------------------------------------------- */

    async mkdirLocal(id: string, name: string): Promise<Result<void>> {
      const tab = this.byId(id);
      if (!tab) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Tab not found" },
        };
      }
      const target = joinLocalPath(tab.localPath, name);
      const r = await fsOps().fs.local.mkdir(target);
      if (r.ok) {
        patchTab(this.$state, id, { statusMessage: `Created ${name}` });
        await this.refreshLocal(id);
      } else {
        patchTab(this.$state, id, {
          statusMessage: `mkdir: ${r.error.message}`,
        });
      }
      return r;
    },

    async mkdirRemote(id: string, name: string): Promise<Result<void>> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Not connected" },
        };
      }
      const target = joinRemotePath(tab.remotePath, name);
      const r = await fsOps().sftp.mkdir(tab.connectionId, target);
      if (r.ok) {
        patchTab(this.$state, id, { statusMessage: `Created ${name}` });
        this.invalidateRemoteCache(id, tab.remotePath);
        await this.refreshRemote(id);
      } else {
        patchTab(this.$state, id, {
          statusMessage: `mkdir: ${r.error.message}`,
        });
      }
      return r;
    },

    async renameLocal(
      id: string,
      oldPath: string,
      newName: string,
    ): Promise<Result<void>> {
      const tab = this.byId(id);
      if (!tab) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Tab not found" },
        };
      }
      const parent = parentLocalPath(oldPath);
      const target = joinLocalPath(parent, newName);
      if (target === oldPath) return { ok: true, data: undefined };
      const r = await fsOps().fs.local.rename(oldPath, target);
      if (r.ok) {
        patchTab(this.$state, id, { statusMessage: `Renamed ${newName}` });
        await this.refreshLocal(id);
      } else {
        patchTab(this.$state, id, {
          statusMessage: `rename: ${r.error.message}`,
        });
      }
      return r;
    },

    async renameRemote(
      id: string,
      oldPath: string,
      newName: string,
    ): Promise<Result<void>> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Not connected" },
        };
      }
      const parent = parentRemotePath(oldPath);
      const target = joinRemotePath(parent, newName);
      if (target === oldPath) return { ok: true, data: undefined };
      const r = await fsOps().sftp.rename(tab.connectionId, oldPath, target);
      if (r.ok) {
        patchTab(this.$state, id, { statusMessage: `Renamed ${newName}` });
        this.invalidateRemoteCache(id, tab.remotePath);
        await this.refreshRemote(id);
      } else {
        patchTab(this.$state, id, {
          statusMessage: `rename: ${r.error.message}`,
        });
      }
      return r;
    },

    async deleteLocalSelection(
      id: string,
    ): Promise<Result<{ deleted: number }>> {
      const tab = this.byId(id);
      if (!tab) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Tab not found" },
        };
      }
      const targets = tab.selectedLocalSet;
      if (targets.length === 0) {
        return { ok: true, data: { deleted: 0 } };
      }
      const byPath = new Map(tab.localEntries.map((e) => [e.path, e]));
      let deleted = 0;
      let lastErr: string | null = null;
      for (const p of targets) {
        const entry = byPath.get(p);
        const recursive = entry ? entry.type === "dir" : false;
        const r = await fsOps().fs.local.remove(p, recursive);
        if (r.ok) deleted++;
        else lastErr = r.error.message;
      }
      patchTab(this.$state, id, {
        selectedLocal: null,
        selectedLocalSet: [],
        focusedLocal: null,
        statusMessage: lastErr
          ? `Deleted ${deleted}, last error: ${lastErr}`
          : `Deleted ${deleted} item${deleted === 1 ? "" : "s"}`,
      });
      await this.refreshLocal(id);
      if (lastErr) {
        return {
          ok: false,
          error: { code: "FS", message: lastErr, details: { deleted } },
        };
      }
      return { ok: true, data: { deleted } };
    },

    async deleteRemoteSelection(
      id: string,
    ): Promise<Result<{ deleted: number }>> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Not connected" },
        };
      }
      const connectionId = tab.connectionId;
      const targets = tab.selectedRemoteSet;
      if (targets.length === 0) {
        return { ok: true, data: { deleted: 0 } };
      }
      const byPath = new Map(tab.remoteEntries.map((e) => [e.path, e]));
      let deleted = 0;
      let lastErr: string | null = null;
      for (const p of targets) {
        const entry = byPath.get(p);
        const recursive = entry ? entry.type === "dir" : false;
        const r = await fsOps().sftp.remove(connectionId, p, recursive);
        if (r.ok) deleted++;
        else lastErr = r.error.message;
      }
      patchTab(this.$state, id, {
        selectedRemote: null,
        selectedRemoteSet: [],
        focusedRemote: null,
        statusMessage: lastErr
          ? `Deleted ${deleted}, last error: ${lastErr}`
          : `Deleted ${deleted} item${deleted === 1 ? "" : "s"}`,
      });
      this.invalidateRemoteCache(id, tab.remotePath);
      await this.refreshRemote(id);
      if (lastErr) {
        return {
          ok: false,
          error: { code: "SFTP", message: lastErr, details: { deleted } },
        };
      }
      return { ok: true, data: { deleted } };
    },

    async chmodRemote(
      id: string,
      path: string,
      mode: number,
    ): Promise<Result<void>> {
      const tab = this.byId(id);
      if (!tab || !tab.connectionId) {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "Not connected" },
        };
      }
      const r = await fsOps().sftp.chmod(tab.connectionId, path, mode);
      if (r.ok) {
        patchTab(this.$state, id, {
          statusMessage: `chmod ${mode.toString(8)} ${path}`,
        });
        this.invalidateRemoteCache(id, tab.remotePath);
        await this.refreshRemote(id);
      } else {
        patchTab(this.$state, id, {
          statusMessage: `chmod: ${r.error.message}`,
        });
      }
      return r;
    },
  },
});
