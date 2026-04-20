import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "fs/promises";
import {
  sessionIdSchema,
  sessionInputSchema,
  sessionUpdateSchema,
} from "../../shared/schemas";
import type {
  Result,
  Session,
  SessionInput,
  SessionsExportResult,
  SessionsImportResult,
} from "../../shared/types";
import type { SessionsStore } from "./sessions-store";

/** Bumped whenever the on-disk shape changes. The importer accepts any
 *  version it knows how to read; future versions can branch off this. */
const EXPORT_FORMAT_VERSION = 1;

/** Top-level wrapper written to disk during export. The shape is
 *  intentionally portable — a plain JSON document a user could hand-edit
 *  if they really wanted to. */
type ExportFile = {
  $schema: "flowsftp-sessions/v1";
  version: number;
  exportedAt: string;
  appVersion: string;
  sessions: SessionInput[];
};

function validationMessage(err: {
  issues: readonly { message: string }[];
}): string {
  return err.issues[0]?.message ?? "Invalid input";
}

function asInternal(e: unknown): Result<never> {
  return {
    ok: false,
    error: {
      code: "INTERNAL",
      message: e instanceof Error ? e.message : String(e),
    },
  };
}

export function registerSessionsIpc(store: SessionsStore): void {
  ipcMain.removeHandler("flowsftp:sessions:list");
  ipcMain.handle(
    "flowsftp:sessions:list",
    async (): Promise<Result<Session[]>> => {
      try {
        return { ok: true, data: await store.list() };
      } catch (e) {
        return asInternal(e);
      }
    },
  );

  ipcMain.removeHandler("flowsftp:sessions:create");
  ipcMain.handle(
    "flowsftp:sessions:create",
    async (_e, raw: unknown): Promise<Result<Session>> => {
      const parsed = sessionInputSchema.safeParse(raw);
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
      try {
        return { ok: true, data: await store.create(parsed.data) };
      } catch (e) {
        return asInternal(e);
      }
    },
  );

  ipcMain.removeHandler("flowsftp:sessions:update");
  ipcMain.handle(
    "flowsftp:sessions:update",
    async (_e, raw: unknown): Promise<Result<Session>> => {
      const parsed = sessionUpdateSchema.safeParse(raw);
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
      try {
        return {
          ok: true,
          data: await store.update(parsed.data.id, parsed.data.patch),
        };
      } catch (e) {
        return asInternal(e);
      }
    },
  );

  ipcMain.removeHandler("flowsftp:sessions:remove");
  ipcMain.handle(
    "flowsftp:sessions:remove",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = sessionIdSchema.safeParse(raw);
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
      try {
        await store.remove(parsed.data.id);
        return { ok: true, data: undefined };
      } catch (e) {
        return asInternal(e);
      }
    },
  );

  ipcMain.removeHandler("flowsftp:sessions:duplicate");
  ipcMain.handle(
    "flowsftp:sessions:duplicate",
    async (_e, raw: unknown): Promise<Result<Session>> => {
      const parsed = sessionIdSchema.safeParse(raw);
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
      try {
        return { ok: true, data: await store.duplicate(parsed.data.id) };
      } catch (e) {
        return asInternal(e);
      }
    },
  );

  /**
   * Show a Save dialog and write all sessions (no secrets) to a JSON file.
   * Cancelling the dialog is not an error — the renderer treats `path:
   * null` as a normal user-initiated cancel.
   */
  ipcMain.removeHandler("flowsftp:sessions:export");
  ipcMain.handle(
    "flowsftp:sessions:export",
    async (event): Promise<Result<SessionsExportResult>> => {
      try {
        const all = await store.list();
        const win = BrowserWindow.fromWebContents(event.sender);
        const defaultName = `flowsftp-sessions-${formatStamp()}.json`;
        const r = win
          ? await dialog.showSaveDialog(win, {
              defaultPath: defaultName,
              filters: [{ name: "FlowSFTP sessions", extensions: ["json"] }],
            })
          : await dialog.showSaveDialog({
              defaultPath: defaultName,
              filters: [{ name: "FlowSFTP sessions", extensions: ["json"] }],
            });
        if (r.canceled || !r.filePath) {
          return { ok: true, data: { path: null, count: 0 } };
        }
        /* Strip ids/timestamps so the export is portable across machines —
         * importing on another box generates fresh ids and avoids spooky
         * "session updated 3 years ago" timestamps from another user's data. */
        const sessions: SessionInput[] = all.map((s) => ({
          name: s.name,
          group: s.group,
          protocol: s.protocol,
          host: s.host,
          port: s.port,
          username: s.username,
          privateKeyPath: s.privateKeyPath,
          notes: s.notes,
        }));
        const payload: ExportFile = {
          $schema: "flowsftp-sessions/v1",
          version: EXPORT_FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          appVersion: app.getVersion(),
          sessions,
        };
        await writeFile(r.filePath, JSON.stringify(payload, null, 2), "utf8");
        return {
          ok: true,
          data: { path: r.filePath, count: sessions.length },
        };
      } catch (e) {
        return asInternal(e);
      }
    },
  );

  /**
   * Show an Open dialog, parse a sessions JSON file, validate every entry
   * against the existing zod schema, and create the survivors via
   * `store.importMany` (which also dedupes on host+port+user).
   */
  ipcMain.removeHandler("flowsftp:sessions:import");
  ipcMain.handle(
    "flowsftp:sessions:import",
    async (event): Promise<Result<SessionsImportResult>> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const opts: Electron.OpenDialogOptions = {
          properties: ["openFile"],
          filters: [
            { name: "FlowSFTP sessions", extensions: ["json"] },
            { name: "All files", extensions: ["*"] },
          ],
        };
        const r = win
          ? await dialog.showOpenDialog(win, opts)
          : await dialog.showOpenDialog(opts);
        if (r.canceled || !r.filePaths[0]) {
          return {
            ok: true,
            data: { path: null, added: 0, skipped: 0, invalid: 0 },
          };
        }
        const filePath = r.filePaths[0];
        const raw = await readFile(filePath, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: "File is not valid JSON.",
            },
          };
        }
        /* Accept both the wrapped export shape and a bare array — the latter
         * makes it trivial to import sessions hand-edited or shared as a
         * snippet. Forward-compatible: unknown future fields are ignored. */
        const candidates: unknown[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { sessions?: unknown }).sessions)
            ? ((parsed as { sessions: unknown[] }).sessions ?? [])
            : [];
        if (candidates.length === 0) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message:
                "No sessions found in file. Expected a FlowSFTP sessions export or a JSON array.",
            },
          };
        }
        const valid: SessionInput[] = [];
        let invalid = 0;
        for (const c of candidates) {
          /* Strip server-side fields users might have left in place from a
           * previous export so the schema check doesn't reject them. */
          const cleaned =
            c && typeof c === "object"
              ? (() => {
                  const o = { ...(c as Record<string, unknown>) };
                  delete o.id;
                  delete o.createdAt;
                  delete o.updatedAt;
                  if (!("protocol" in o)) o.protocol = "sftp";
                  return o;
                })()
              : c;
          const p = sessionInputSchema.safeParse(cleaned);
          if (p.success) valid.push(p.data);
          else invalid++;
        }
        const result = await store.importMany(valid);
        return {
          ok: true,
          data: {
            path: filePath,
            added: result.added.length,
            skipped: result.skipped,
            invalid,
          },
        };
      } catch (e) {
        return asInternal(e);
      }
    },
  );
}

function formatStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}
