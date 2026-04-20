import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import { mkdir, readdir, stat } from "fs/promises";
import { join, resolve, basename } from "path";
import type { Result, LocalListEntry, AppPaths } from "../../shared/types";
import {
  connectionIdSchema,
  localListSchema,
  sftpConnectSchema,
  sftpDownloadSchema,
  sftpListSchema,
  sftpOpenRemoteSchema,
  sftpUploadSchema,
} from "../../shared/schemas";
import { SftpManager } from "../sftp/sftp-manager";

function validationMessage(err: {
  issues: readonly { message: string }[];
}): string {
  return err.issues[0]?.message ?? "Invalid input";
}

export function registerSynctronIpc(
  sftp: SftpManager,
  createMainWindow: () => void,
): void {
  ipcMain.removeHandler("synctron:app:paths");
  ipcMain.handle("synctron:app:paths", (): Result<AppPaths> => {
    return {
      ok: true,
      data: {
        home: app.getPath("home"),
        userData: app.getPath("userData"),
      },
    };
  });

  ipcMain.removeHandler("synctron:fs:local:list");
  ipcMain.handle(
    "synctron:fs:local:list",
    async (_e, raw: unknown): Promise<Result<LocalListEntry[]>> => {
      const parsed = localListSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: validationMessage(parsed.error),
            details: parsed.error.issues,
          },
        };
      }
      const dir = resolve(parsed.data.path);
      try {
        const dirents = await readdir(dir, { withFileTypes: true });
        const entries: LocalListEntry[] = [];
        for (const d of dirents) {
          const full = resolve(dir, d.name);
          let size = 0;
          let mtimeMs: number | null = null;
          try {
            const st = await stat(full);
            size = st.isDirectory() ? 0 : st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            /* broken symlink etc. */
          }
          const type: LocalListEntry["type"] = d.isDirectory()
            ? "dir"
            : d.isSymbolicLink()
              ? "link"
              : "file";
          entries.push({ name: d.name, path: full, type, size, mtimeMs });
        }
        entries.sort((a, b) => {
          if (a.type === "dir" && b.type !== "dir") return -1;
          if (a.type !== "dir" && b.type === "dir") return 1;
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        });
        return { ok: true, data: entries };
      } catch (e) {
        return {
          ok: false,
          error: {
            code: "FS",
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    },
  );

  ipcMain.removeHandler("synctron:sftp:connect");
  ipcMain.handle("synctron:sftp:connect", async (event, raw: unknown) => {
    const parsed = sftpConnectSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: validationMessage(parsed.error),
          details: parsed.error.issues,
        },
      };
    }
    return sftp.connect(parsed.data, event.sender.id);
  });

  ipcMain.removeHandler("synctron:window:new");
  ipcMain.handle("synctron:window:new", (): { ok: true } => {
    createMainWindow();
    return { ok: true };
  });

  ipcMain.removeHandler("synctron:sftp:disconnect");
  ipcMain.handle("synctron:sftp:disconnect", async (_e, raw: unknown) => {
    const parsed = connectionIdSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: validationMessage(parsed.error),
          details: parsed.error.issues,
        },
      };
    }
    return sftp.disconnect(parsed.data.connectionId);
  });

  ipcMain.removeHandler("synctron:sftp:list");
  ipcMain.handle("synctron:sftp:list", async (_e, raw: unknown) => {
    const parsed = sftpListSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: validationMessage(parsed.error),
          details: parsed.error.issues,
        },
      };
    }
    const { connectionId, path } = parsed.data;
    return sftp.list(connectionId, path);
  });

  ipcMain.removeHandler("synctron:sftp:upload");
  ipcMain.handle("synctron:sftp:upload", async (_e, raw: unknown) => {
    const parsed = sftpUploadSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: validationMessage(parsed.error),
          details: parsed.error.issues,
        },
      };
    }
    const { connectionId, localPath, remotePath } = parsed.data;
    return sftp.upload(connectionId, localPath, remotePath);
  });

  ipcMain.removeHandler("synctron:sftp:download");
  ipcMain.handle("synctron:sftp:download", async (_e, raw: unknown) => {
    const parsed = sftpDownloadSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: validationMessage(parsed.error),
          details: parsed.error.issues,
        },
      };
    }
    const { connectionId, remotePath, localPath } = parsed.data;
    return sftp.download(connectionId, remotePath, localPath);
  });

  /**
   * Download a remote file into a per-connection scratch dir under the OS
   * temp directory, then ask the OS to open it with the default application
   * (Preview/Acrobat for PDFs, etc.). The file is overwritten on each call,
   * so re-opening always reflects the current remote contents.
   *
   * Note: this is a one-way "view" — local edits to the temp copy are NOT
   * synced back to the server. A proper "Edit with…" round-trip can be added
   * later with a watcher on the temp path.
   */
  ipcMain.removeHandler("synctron:sftp:openRemote");
  ipcMain.handle(
    "synctron:sftp:openRemote",
    async (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = sftpOpenRemoteSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: validationMessage(parsed.error),
            details: parsed.error.issues,
          },
        };
      }
      const { connectionId, remotePath } = parsed.data;
      const name = basename(remotePath.replace(/\\/g, "/")) || "file";
      const dir = join(app.getPath("temp"), "synctron", connectionId);
      try {
        await mkdir(dir, { recursive: true });
      } catch (e) {
        return {
          ok: false,
          error: {
            code: "INTERNAL",
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
      const localPath = join(dir, name);
      const dl = await sftp.download(connectionId, remotePath, localPath);
      if (!dl.ok) return dl;
      const err = await shell.openPath(localPath);
      if (err) {
        return { ok: false, error: { code: "INTERNAL", message: err } };
      }
      return { ok: true, data: localPath };
    },
  );

  ipcMain.removeHandler("synctron:dialog:openFile");
  ipcMain.handle(
    "synctron:dialog:openFile",
    async (event): Promise<Result<string | null>> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const opts: OpenDialogOptions = { properties: ["openFile"] };
      const r = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) {
        return { ok: true, data: null };
      }
      return { ok: true, data: r.filePaths[0] };
    },
  );

  ipcMain.removeHandler("synctron:dialog:openDirectory");
  ipcMain.handle(
    "synctron:dialog:openDirectory",
    async (event): Promise<Result<string | null>> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const opts: OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
      };
      const r = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) {
        return { ok: true, data: null };
      }
      return { ok: true, data: r.filePaths[0] };
    },
  );

  ipcMain.removeHandler("synctron:shell:openPath");
  ipcMain.handle(
    "synctron:shell:openPath",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const p =
        typeof raw === "string" ? raw : (raw as { path?: string })?.path;
      if (!p || typeof p !== "string") {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "path required" },
        };
      }
      const err = await shell.openPath(resolve(p));
      if (err) {
        return { ok: false, error: { code: "INTERNAL", message: err } };
      }
      return { ok: true, data: undefined };
    },
  );

  ipcMain.removeHandler("synctron:shell:showItemInFolder");
  ipcMain.handle(
    "synctron:shell:showItemInFolder",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const p =
        typeof raw === "string" ? raw : (raw as { path?: string })?.path;
      if (!p || typeof p !== "string") {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "path required" },
        };
      }
      shell.showItemInFolder(resolve(p));
      return { ok: true, data: undefined };
    },
  );

  /** Pick a directory, then full path for saving remote file basename(remote) into that folder. */
  ipcMain.removeHandler("synctron:dialog:saveRemoteFile");
  ipcMain.handle(
    "synctron:dialog:saveRemoteFile",
    async (event, raw: unknown): Promise<Result<string | null>> => {
      const remotePath =
        typeof raw === "string"
          ? raw
          : (raw as { remotePath?: string })?.remotePath;
      if (!remotePath || typeof remotePath !== "string") {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "remotePath required" },
        };
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const name = basename(remotePath.replace(/\\/g, "/"));
      const saveOpts: SaveDialogOptions = {
        defaultPath: name,
        showsTagField: false,
      };
      const r = win
        ? await dialog.showSaveDialog(win, saveOpts)
        : await dialog.showSaveDialog(saveOpts);
      if (r.canceled || !r.filePath) {
        return { ok: true, data: null };
      }
      return { ok: true, data: r.filePath };
    },
  );
}
