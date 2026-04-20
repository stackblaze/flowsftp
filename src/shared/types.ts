import { z } from "zod";
import type {
  connectionIdSchema,
  enqueueJobsSchema,
  hashAlgorithmSchema,
  jobIdSchema,
  jobInputSchema,
  jobPrioritySchema,
  localHashSchema,
  localListSchema,
  localPathSchema,
  localReadTextSchema,
  localRemoveSchema,
  localRenameSchema,
  localWriteTextSchema,
  sessionIdSchema,
  sessionInputSchema,
  sessionUpdateSchema,
  sftpChmodSchema,
  sftpConnectSchema,
  sftpDownloadSchema,
  sftpHashSchema,
  sftpListSchema,
  sftpPathSchema,
  sftpReadTextSchema,
  sftpRemoveSchema,
  sftpRenameSchema,
  sftpUploadSchema,
  sftpWriteTextSchema,
} from "./schemas";

export type SftpConnectInput = z.infer<typeof sftpConnectSchema>;
export type ConnectionIdPayload = z.infer<typeof connectionIdSchema>;
export type SftpListInput = z.infer<typeof sftpListSchema>;
export type SftpUploadInput = z.infer<typeof sftpUploadSchema>;
export type SftpDownloadInput = z.infer<typeof sftpDownloadSchema>;
export type LocalListInput = z.infer<typeof localListSchema>;

export type LocalPathInput = z.infer<typeof localPathSchema>;
export type LocalRenameInput = z.infer<typeof localRenameSchema>;
export type LocalRemoveInput = z.infer<typeof localRemoveSchema>;
export type LocalReadTextInput = z.infer<typeof localReadTextSchema>;
export type LocalWriteTextInput = z.infer<typeof localWriteTextSchema>;

export type SftpPathInput = z.infer<typeof sftpPathSchema>;
export type SftpRenameInput = z.infer<typeof sftpRenameSchema>;
export type SftpRemoveInput = z.infer<typeof sftpRemoveSchema>;
export type SftpChmodInput = z.infer<typeof sftpChmodSchema>;
export type SftpReadTextInput = z.infer<typeof sftpReadTextSchema>;
export type SftpWriteTextInput = z.infer<typeof sftpWriteTextSchema>;

export type HashAlgorithm = z.infer<typeof hashAlgorithmSchema>;
export type LocalHashInput = z.infer<typeof localHashSchema>;
export type SftpHashInput = z.infer<typeof sftpHashSchema>;

/** Common stat output for both local and remote ops. */
export type FileStat = {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
};

export type Ok<T> = { ok: true; data: T };
export type Err = {
  ok: false;
  error: {
    code: "VALIDATION" | "SFTP" | "FS" | "INTERNAL";
    message: string;
    details?: unknown;
  };
};
export type Result<T> = Ok<T> | Err;

export type RemoteEntryType = "file" | "dir" | "link" | "other";

export type RemoteListEntry = {
  name: string;
  path: string;
  type: RemoteEntryType;
  size: number;
  mtimeMs: number | null;
};

export type LocalListEntry = {
  name: string;
  path: string;
  type: RemoteEntryType;
  size: number;
  mtimeMs: number | null;
};

export type AppPaths = {
  home: string;
  userData: string;
};

export type TransferProgressPayload = {
  connectionId: string;
  direction: "upload" | "download";
  remotePath: string;
  localPath: string;
  transferred: number;
  total: number;
};

/** Saved session (NO secrets — keytar comes in M4). */
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type SessionUpdateInput = z.infer<typeof sessionUpdateSchema>;
export type SessionIdInput = z.infer<typeof sessionIdSchema>;

export type Session = SessionInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
};

/** Result of `sessions:export` — null path means the user cancelled the
 *  save dialog and no file was written. */
export type SessionsExportResult = {
  path: string | null;
  count: number;
};

/** Result of `sessions:import` — null path means the user cancelled the
 *  open dialog. `added`/`skipped`/`invalid` always reflect the file when
 *  it was actually parsed. */
export type SessionsImportResult = {
  path: string | null;
  added: number;
  skipped: number;
  invalid: number;
};

/** Transfer queue. */
export type JobKind = "upload" | "download";
export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type JobPriority = z.infer<typeof jobPrioritySchema>;

export type JobInput = z.infer<typeof jobInputSchema>;
export type EnqueueJobsInput = z.infer<typeof enqueueJobsSchema>;
export type JobIdInput = z.infer<typeof jobIdSchema>;

export type Job = {
  id: string;
  connectionId: string;
  kind: JobKind;
  src: string;
  dst: string;
  size: number;
  transferred: number;
  status: JobStatus;
  error?: string;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  priority: JobPriority;
};

/** Output of a recursive directory walk. `relPath` is the path relative to
 *  the walked root, using forward slashes regardless of the source platform
 *  so it can be safely re-joined onto either a local or remote destination. */
export type WalkedEntry = {
  relPath: string;
  size: number;
  /** Last-modified time in ms since epoch, or null when unavailable. */
  mtimeMs: number | null;
};

export type TransferEvent =
  | { type: "added"; job: Job }
  | { type: "updated"; job: Job }
  | { type: "removed"; id: string }
  | { type: "snapshot"; jobs: Job[] }
  | { type: "reordered"; orderedIds: string[] };

/** Commands sent from the native (OS) menu down to the focused window. */
export type MenuCommand =
  | "newWindow"
  | "newTab"
  | "closeTab"
  | "login"
  | "disconnect"
  | "toggleTheme"
  | "toggleQueuePanel"
  | "toggleTransferDialog"
  | "refreshBoth"
  | "parentDir"
  | "pauseAll"
  | "resumeAll"
  | "clearCompleted"
  | "checkForUpdates"
  | "about";

/* --- Software updates ---
 * State machine surfaced from the main-process UpdateManager. The renderer
 * subscribes to changes via `api.update.onChange` and renders accordingly.
 * Every state carries the data the UI needs without asking back, so the
 * dialog can be a pure projection of the current state.
 */
export type UpdateState =
  | { status: "idle"; currentVersion: string }
  | { status: "checking"; currentVersion: string }
  | { status: "not-available"; currentVersion: string; checkedAt: number }
  | {
      status: "available";
      currentVersion: string;
      version: string;
      releaseDate?: string;
      releaseNotes?: string;
      /** True when auto-download has kicked in and a `downloading` event
       *  is imminent. Lets the UI avoid showing a stale "Download" button. */
      autoDownloading: boolean;
    }
  | {
      status: "downloading";
      currentVersion: string;
      version: string;
      percent: number; // 0..100
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | {
      status: "downloaded";
      currentVersion: string;
      version: string;
      releaseNotes?: string;
    }
  | {
      status: "error";
      currentVersion: string;
      message: string;
    }
  /** App is running in development without a `dev-app-update.yml`, so
   *  electron-updater can't actually check anything. Surface this so the
   *  UI can render a useful hint instead of a silent no-op. */
  | { status: "dev-disabled"; currentVersion: string };

export type UpdateEvent = { state: UpdateState };
