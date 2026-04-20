import { ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  AppPaths,
  FileStat,
  HashAlgorithm,
  Job,
  JobInput,
  LocalListEntry,
  MenuCommand,
  RemoteListEntry,
  Result,
  Session,
  SessionInput,
  SessionsExportResult,
  SessionsImportResult,
  SftpConnectInput,
  TransferEvent,
  TransferProgressPayload,
  UpdateEvent,
  UpdateState,
  WalkedEntry,
} from "../shared/types";

export type { MenuCommand };

export type FlowSftpApi = {
  app: {
    getPaths: () => Promise<Result<AppPaths>>;
    /** Open another main commander window (multi-window). */
    newWindow: () => Promise<{ ok: true }>;
    /** Synchronous host platform string (read at preload load). */
    platform: NodeJS.Platform;
    /** Subscribe to commands dispatched by the native menu. */
    onMenuCommand: (cb: (cmd: MenuCommand) => void) => () => void;
  };
  sftp: {
    connect: (
      input: SftpConnectInput,
    ) => Promise<Result<{ connectionId: string }>>;
    disconnect: (connectionId: string) => Promise<Result<void>>;
    cwd: (connectionId: string) => Promise<Result<string>>;
    realPath: (connectionId: string, path: string) => Promise<Result<string>>;
    list: (
      connectionId: string,
      path: string,
    ) => Promise<Result<RemoteListEntry[]>>;
    /** Recursively enumerate every regular file beneath `path`. Returns
     *  POSIX-relative paths so the renderer can re-join them onto a local
     *  destination root. Used to expand directory selections into transfer
     *  jobs. Symlinks are skipped. */
    walk: (
      connectionId: string,
      path: string,
    ) => Promise<Result<WalkedEntry[]>>;
    upload: (
      connectionId: string,
      localPath: string,
      remotePath: string,
    ) => Promise<Result<void>>;
    download: (
      connectionId: string,
      remotePath: string,
      localPath: string,
    ) => Promise<Result<void>>;
    /** Download a remote file to a temp scratch dir and open it with the
     *  OS default application. Returns the temp path on success. The local
     *  copy is view-only — edits are not synced back to the server. */
    openRemote: (
      connectionId: string,
      remotePath: string,
    ) => Promise<Result<string>>;
    onProgress: (cb: (p: TransferProgressPayload) => void) => () => void;
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
    stat: (connectionId: string, path: string) => Promise<Result<FileStat>>;
    readText: (
      connectionId: string,
      path: string,
      maxBytes?: number,
    ) => Promise<Result<string>>;
    writeText: (
      connectionId: string,
      path: string,
      contents: string,
    ) => Promise<Result<void>>;
    /** Stream the remote file through the given hash algorithm; returns
     *  the hex digest. Reads the whole file via SFTP — slow on big files
     *  over slow links. Used by the Properties dialog. */
    hash: (
      connectionId: string,
      path: string,
      algorithm: HashAlgorithm,
    ) => Promise<Result<string>>;
  };
  fs: {
    local: {
      list: (path: string) => Promise<Result<LocalListEntry[]>>;
      /** Recursively enumerate every regular file beneath `path`. Returns
       *  POSIX-relative paths so the renderer can re-join them onto a remote
       *  destination root. Symlinks are skipped. */
      walk: (path: string) => Promise<Result<WalkedEntry[]>>;
      mkdir: (path: string) => Promise<Result<void>>;
      rename: (oldPath: string, newPath: string) => Promise<Result<void>>;
      remove: (path: string, recursive: boolean) => Promise<Result<void>>;
      stat: (path: string) => Promise<Result<FileStat>>;
      readText: (path: string, maxBytes?: number) => Promise<Result<string>>;
      writeText: (path: string, contents: string) => Promise<Result<void>>;
      /** Stream the local file through the given hash algorithm; returns
       *  the hex digest. */
      hash: (path: string, algorithm: HashAlgorithm) => Promise<Result<string>>;
    };
  };
  dialog: {
    openFile: () => Promise<Result<string | null>>;
    openDirectory: () => Promise<Result<string | null>>;
    saveRemoteFile: (remotePath: string) => Promise<Result<string | null>>;
  };
  shell: {
    openPath: (path: string) => Promise<Result<void>>;
    showItemInFolder: (path: string) => Promise<Result<void>>;
  };
  sessions: {
    list: () => Promise<Result<Session[]>>;
    create: (input: SessionInput) => Promise<Result<Session>>;
    update: (
      id: string,
      patch: Partial<SessionInput>,
    ) => Promise<Result<Session>>;
    remove: (id: string) => Promise<Result<void>>;
    duplicate: (id: string) => Promise<Result<Session>>;
    /** Show a Save dialog and write all sessions (no secrets) to a JSON
     *  file. Returns null path when the user cancels. */
    exportToFile: () => Promise<Result<SessionsExportResult>>;
    /** Show an Open dialog and import sessions from a JSON file produced
     *  by `exportToFile` (or a hand-edited equivalent). Duplicates by
     *  host+port+username are skipped, not overwritten. */
    importFromFile: () => Promise<Result<SessionsImportResult>>;
  };
  update: {
    /** Snapshot the current update state — used right after the dialog
     *  mounts so it doesn't have to wait for the next push event. */
    getState: () => Promise<Result<UpdateState>>;
    /** Trigger an update check now. Resolves with the post-check state. */
    check: () => Promise<Result<UpdateState>>;
    /** Start downloading the available update (no-op when none available). */
    download: () => Promise<Result<UpdateState>>;
    /** Quit the app and apply the downloaded update. */
    install: () => Promise<Result<UpdateState>>;
    /** Toggle whether the manager auto-downloads available updates. */
    setAutoDownload: (value: boolean) => Promise<Result<void>>;
    /** Subscribe to update state changes; returns an unsubscribe fn. */
    onChange: (cb: (state: UpdateState) => void) => () => void;
  };
  transfer: {
    list: () => Promise<Result<Job[]>>;
    enqueue: (jobs: JobInput[]) => Promise<Result<Job[]>>;
    pause: (id: string) => Promise<Result<void>>;
    resume: (id: string) => Promise<Result<void>>;
    cancel: (id: string) => Promise<Result<void>>;
    pauseAll: () => Promise<Result<void>>;
    resumeAll: () => Promise<Result<void>>;
    clearCompleted: () => Promise<Result<void>>;
    /** Reorder pending (queued/paused) jobs. Running and terminal jobs
     *  are unaffected; ids referring to them are silently ignored. */
    reorder: (orderedIds: string[]) => Promise<Result<void>>;
    /** Remove a single job from the queue. Aborts it first if running. */
    remove: (id: string) => Promise<Result<void>>;
    /** Read the current parallelism caps from the transfer engine. */
    getConcurrency: () => Promise<
      Result<{ global: number; perSession: number }>
    >;
    /** Update one or both parallelism caps (clamped to 1..8 in main). */
    setConcurrency: (opts: {
      global?: number;
      perSession?: number;
    }) => Promise<Result<{ global: number; perSession: number }>>;
    onEvent: (cb: (e: TransferEvent) => void) => () => void;
  };
};

const PROGRESS_CH = "flowsftp:sftp:progress";
const TRANSFER_EVENT_CH = "flowsftp:transfer:event";
const UPDATE_EVENT_CH = "flowsftp:update:event";

export const flowSftpApi: FlowSftpApi = {
  app: {
    getPaths: () => ipcRenderer.invoke("flowsftp:app:paths"),
    newWindow: () => ipcRenderer.invoke("flowsftp:window:new"),
    platform: process.platform,
    onMenuCommand: (cb) => {
      const handler = (_e: unknown, cmd: MenuCommand): void => cb(cmd);
      ipcRenderer.on("flowsftp:menu:command", handler);
      return () => ipcRenderer.off("flowsftp:menu:command", handler);
    },
  },
  sftp: {
    connect: (input) => ipcRenderer.invoke("flowsftp:sftp:connect", input),
    disconnect: (connectionId) =>
      ipcRenderer.invoke("flowsftp:sftp:disconnect", { connectionId }),
    cwd: (connectionId) =>
      ipcRenderer.invoke("flowsftp:sftp:cwd", { connectionId }),
    realPath: (connectionId, path) =>
      ipcRenderer.invoke("flowsftp:sftp:realPath", { connectionId, path }),
    list: (connectionId, path) =>
      ipcRenderer.invoke("flowsftp:sftp:list", { connectionId, path }),
    walk: (connectionId, path) =>
      ipcRenderer.invoke("flowsftp:sftp:walk", { connectionId, path }),
    upload: (connectionId, localPath, remotePath) =>
      ipcRenderer.invoke("flowsftp:sftp:upload", {
        connectionId,
        localPath,
        remotePath,
      }),
    download: (connectionId, remotePath, localPath) =>
      ipcRenderer.invoke("flowsftp:sftp:download", {
        connectionId,
        remotePath,
        localPath,
      }),
    openRemote: (connectionId, remotePath) =>
      ipcRenderer.invoke("flowsftp:sftp:openRemote", {
        connectionId,
        remotePath,
      }),
    onProgress: (cb) => {
      const listener = (
        _e: IpcRendererEvent,
        p: TransferProgressPayload,
      ): void => cb(p);
      ipcRenderer.on(PROGRESS_CH, listener);
      return () => ipcRenderer.removeListener(PROGRESS_CH, listener);
    },
    mkdir: (connectionId, path) =>
      ipcRenderer.invoke("flowsftp:sftp:mkdir", { connectionId, path }),
    rename: (connectionId, oldPath, newPath) =>
      ipcRenderer.invoke("flowsftp:sftp:rename", {
        connectionId,
        oldPath,
        newPath,
      }),
    remove: (connectionId, path, recursive) =>
      ipcRenderer.invoke("flowsftp:sftp:remove", {
        connectionId,
        path,
        recursive,
      }),
    chmod: (connectionId, path, mode) =>
      ipcRenderer.invoke("flowsftp:sftp:chmod", { connectionId, path, mode }),
    stat: (connectionId, path) =>
      ipcRenderer.invoke("flowsftp:sftp:stat", { connectionId, path }),
    readText: (connectionId, path, maxBytes) =>
      ipcRenderer.invoke("flowsftp:sftp:readText", {
        connectionId,
        path,
        maxBytes,
      }),
    writeText: (connectionId, path, contents) =>
      ipcRenderer.invoke("flowsftp:sftp:writeText", {
        connectionId,
        path,
        contents,
      }),
    hash: (connectionId, path, algorithm) =>
      ipcRenderer.invoke("flowsftp:sftp:hash", {
        connectionId,
        path,
        algorithm,
      }),
  },
  fs: {
    local: {
      list: (path) => ipcRenderer.invoke("flowsftp:fs:local:list", { path }),
      walk: (path) => ipcRenderer.invoke("flowsftp:fs:local:walk", { path }),
      mkdir: (path) => ipcRenderer.invoke("flowsftp:fs:local:mkdir", { path }),
      rename: (oldPath, newPath) =>
        ipcRenderer.invoke("flowsftp:fs:local:rename", { oldPath, newPath }),
      remove: (path, recursive) =>
        ipcRenderer.invoke("flowsftp:fs:local:remove", { path, recursive }),
      stat: (path) => ipcRenderer.invoke("flowsftp:fs:local:stat", { path }),
      readText: (path, maxBytes) =>
        ipcRenderer.invoke("flowsftp:fs:local:readText", { path, maxBytes }),
      writeText: (path, contents) =>
        ipcRenderer.invoke("flowsftp:fs:local:writeText", { path, contents }),
      hash: (path, algorithm) =>
        ipcRenderer.invoke("flowsftp:fs:local:hash", { path, algorithm }),
    },
  },
  dialog: {
    openFile: () => ipcRenderer.invoke("flowsftp:dialog:openFile"),
    openDirectory: () => ipcRenderer.invoke("flowsftp:dialog:openDirectory"),
    saveRemoteFile: (remotePath) =>
      ipcRenderer.invoke("flowsftp:dialog:saveRemoteFile", { remotePath }),
  },
  shell: {
    openPath: (path) => ipcRenderer.invoke("flowsftp:shell:openPath", path),
    showItemInFolder: (path) =>
      ipcRenderer.invoke("flowsftp:shell:showItemInFolder", path),
  },
  sessions: {
    list: () => ipcRenderer.invoke("flowsftp:sessions:list"),
    create: (input) => ipcRenderer.invoke("flowsftp:sessions:create", input),
    update: (id, patch) =>
      ipcRenderer.invoke("flowsftp:sessions:update", { id, patch }),
    remove: (id) => ipcRenderer.invoke("flowsftp:sessions:remove", { id }),
    duplicate: (id) => ipcRenderer.invoke("flowsftp:sessions:duplicate", { id }),
    exportToFile: () => ipcRenderer.invoke("flowsftp:sessions:export"),
    importFromFile: () => ipcRenderer.invoke("flowsftp:sessions:import"),
  },
  update: {
    getState: () => ipcRenderer.invoke("flowsftp:update:getState"),
    check: () => ipcRenderer.invoke("flowsftp:update:check"),
    download: () => ipcRenderer.invoke("flowsftp:update:download"),
    install: () => ipcRenderer.invoke("flowsftp:update:install"),
    setAutoDownload: (value) =>
      ipcRenderer.invoke("flowsftp:update:setAutoDownload", { value }),
    onChange: (cb) => {
      const listener = (_e: IpcRendererEvent, payload: UpdateEvent): void =>
        cb(payload.state);
      ipcRenderer.on(UPDATE_EVENT_CH, listener);
      return () => ipcRenderer.removeListener(UPDATE_EVENT_CH, listener);
    },
  },
  transfer: {
    list: () => ipcRenderer.invoke("flowsftp:transfer:list"),
    enqueue: (jobs) => ipcRenderer.invoke("flowsftp:transfer:enqueue", { jobs }),
    pause: (id) => ipcRenderer.invoke("flowsftp:transfer:pause", { id }),
    resume: (id) => ipcRenderer.invoke("flowsftp:transfer:resume", { id }),
    cancel: (id) => ipcRenderer.invoke("flowsftp:transfer:cancel", { id }),
    pauseAll: () => ipcRenderer.invoke("flowsftp:transfer:pauseAll"),
    resumeAll: () => ipcRenderer.invoke("flowsftp:transfer:resumeAll"),
    clearCompleted: () => ipcRenderer.invoke("flowsftp:transfer:clearCompleted"),
    reorder: (orderedIds) =>
      ipcRenderer.invoke("flowsftp:transfer:reorder", { orderedIds }),
    remove: (id) => ipcRenderer.invoke("flowsftp:transfer:remove", { id }),
    getConcurrency: () => ipcRenderer.invoke("flowsftp:transfer:getConcurrency"),
    setConcurrency: (opts) =>
      ipcRenderer.invoke("flowsftp:transfer:setConcurrency", opts),
    onEvent: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: TransferEvent): void =>
        cb(ev);
      ipcRenderer.on(TRANSFER_EVENT_CH, listener);
      return () => ipcRenderer.removeListener(TRANSFER_EVENT_CH, listener);
    },
  },
};
