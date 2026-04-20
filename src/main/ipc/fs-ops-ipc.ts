import { ipcMain } from "electron";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { resolve } from "path";
import {
  localHashSchema,
  localPathSchema,
  localReadTextSchema,
  localRemoveSchema,
  localRenameSchema,
  localWriteTextSchema,
} from "../../shared/schemas";
import type { FileStat, Result, WalkedEntry } from "../../shared/types";

/** Maximum number of files we'll surface from a single directory walk. Past
 *  this we bail out — large recursive transfers should be staged in batches
 *  rather than blowing up the renderer with hundreds of thousands of inputs. */
const WALK_MAX_FILES = 50_000;

const DEFAULT_READ_TEXT_MAX_BYTES = 5 * 1024 * 1024;

function validationMessage(err: {
  issues: readonly { message: string }[];
}): string {
  return err.issues[0]?.message ?? "Invalid input";
}

function fsError(e: unknown): Result<never> {
  return {
    ok: false,
    error: {
      code: "FS",
      message: e instanceof Error ? e.message : String(e),
    },
  };
}

export function registerFsOpsIpc(): void {
  ipcMain.removeHandler("synctron:fs:local:mkdir");
  ipcMain.handle(
    "synctron:fs:local:mkdir",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = localPathSchema.safeParse(raw);
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
        await mkdir(resolve(parsed.data.path), { recursive: true });
        return { ok: true, data: undefined };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  ipcMain.removeHandler("synctron:fs:local:rename");
  ipcMain.handle(
    "synctron:fs:local:rename",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = localRenameSchema.safeParse(raw);
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
        await rename(
          resolve(parsed.data.oldPath),
          resolve(parsed.data.newPath),
        );
        return { ok: true, data: undefined };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  ipcMain.removeHandler("synctron:fs:local:remove");
  ipcMain.handle(
    "synctron:fs:local:remove",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = localRemoveSchema.safeParse(raw);
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
        await rm(resolve(parsed.data.path), {
          recursive: parsed.data.recursive,
          force: false,
        });
        return { ok: true, data: undefined };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  ipcMain.removeHandler("synctron:fs:local:stat");
  ipcMain.handle(
    "synctron:fs:local:stat",
    async (_e, raw: unknown): Promise<Result<FileStat>> => {
      const parsed = localPathSchema.safeParse(raw);
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
        const st = await stat(resolve(parsed.data.path));
        return {
          ok: true,
          data: {
            size: st.size,
            mtimeMs: st.mtimeMs,
            isDirectory: st.isDirectory(),
            isFile: st.isFile(),
            isSymbolicLink: st.isSymbolicLink(),
            mode: st.mode,
          },
        };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  ipcMain.removeHandler("synctron:fs:local:readText");
  ipcMain.handle(
    "synctron:fs:local:readText",
    async (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = localReadTextSchema.safeParse(raw);
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
      const limit = parsed.data.maxBytes ?? DEFAULT_READ_TEXT_MAX_BYTES;
      const full = resolve(parsed.data.path);
      try {
        const st = await stat(full);
        if (st.size > limit) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `File too large: ${st.size} bytes exceeds limit of ${limit}`,
            },
          };
        }
        const text = await readFile(full, "utf8");
        return { ok: true, data: text };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  ipcMain.removeHandler("synctron:fs:local:writeText");
  ipcMain.handle(
    "synctron:fs:local:writeText",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = localWriteTextSchema.safeParse(raw);
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
        await writeFile(
          resolve(parsed.data.path),
          parsed.data.contents,
          "utf8",
        );
        return { ok: true, data: undefined };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  /**
   * Recursively walk a local directory and return a flat list of files with
   * their size and POSIX-style path relative to the walked root. Directories
   * themselves are not returned — `mkdir -p` on the destination side handles
   * the parents on demand. Symlinks are skipped to avoid loops. Hidden dotfiles
   * are included (matches the file pane's listing).
   */
  ipcMain.removeHandler("synctron:fs:local:walk");
  ipcMain.handle(
    "synctron:fs:local:walk",
    async (_e, raw: unknown): Promise<Result<WalkedEntry[]>> => {
      const parsed = localPathSchema.safeParse(raw);
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
      const root = resolve(parsed.data.path);
      const out: WalkedEntry[] = [];
      try {
        await walkLocal(root, "", out);
        return { ok: true, data: out };
      } catch (e) {
        return fsError(e);
      }
    },
  );

  /**
   * Stream a local file through a hash function and return the hex digest.
   * Used by the Properties dialog. Streaming (vs. readFile + hash) keeps
   * peak memory bounded so a 10 GB ISO doesn't blow up the main process.
   */
  ipcMain.removeHandler("synctron:fs:local:hash");
  ipcMain.handle(
    "synctron:fs:local:hash",
    (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = localHashSchema.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "VALIDATION",
            message: validationMessage(parsed.error),
            details: parsed.error.issues,
          },
        });
      }
      const { path: p, algorithm } = parsed.data;
      return new Promise<Result<string>>((res) => {
        const hash = createHash(algorithm);
        const rs = createReadStream(resolve(p));
        rs.on("data", (chunk) => hash.update(chunk));
        rs.on("error", (e) => res(fsError(e)));
        rs.on("end", () => res({ ok: true, data: hash.digest("hex") }));
      });
    },
  );
}

/**
 * Depth-first walk that pushes `WalkedEntry` rows for every regular file
 * beneath `root`. `prefix` is the slash-joined relative path of the directory
 * we're currently inside (empty at the root). We use `withFileTypes` so each
 * entry already knows whether it's a directory/file/symlink without an extra
 * stat round-trip.
 */
async function walkLocal(
  root: string,
  prefix: string,
  out: WalkedEntry[],
): Promise<void> {
  const dir = prefix ? resolve(root, prefix) : root;
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const d of dirents) {
    if (out.length >= WALK_MAX_FILES) {
      throw new Error(
        `Directory walk aborted after ${WALK_MAX_FILES} files; please transfer in smaller batches`,
      );
    }
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isSymbolicLink()) {
      // Skipping symlinks avoids cycles and accidentally fanning out into
      // the user's whole home directory via a stray link.
      continue;
    }
    if (d.isDirectory()) {
      await walkLocal(root, rel, out);
      continue;
    }
    if (!d.isFile()) continue;
    let size = 0;
    let mtimeMs: number | null = null;
    try {
      const st = await stat(resolve(dir, d.name));
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* unreadable file — surface with size 0; the actual transfer will fail
         loudly if it really is broken */
    }
    out.push({ relPath: rel, size, mtimeMs });
  }
}
