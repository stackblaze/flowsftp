import { createHash, randomUUID } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { readFile, rename, stat, statfs, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, normalize, resolve } from "path";
import { Readable, Transform, Writable } from "stream";
import { pipeline } from "stream/promises";
import { webContents } from "electron";
import SftpClient from "ssh2-sftp-client";
import type {
  FileStat,
  Result,
  RemoteListEntry,
  SftpConnectInput,
  WalkedEntry,
} from "../../shared/types";

/** Same hard cap the local walker uses — see fs-ops-ipc.ts. */
const REMOTE_WALK_MAX_FILES = 50_000;

const DEFAULT_READ_TEXT_MAX_BYTES = 5 * 1024 * 1024;

const PROGRESS_INTERVAL_MS = 250;

/**
 * Per-connection cap on extra SFTP sessions opened for parallel transfers.
 *
 * Each in-flight transfer job borrows its OWN `SftpClient` (i.e. its own SSH
 * session / TCP connection) so that:
 *   1. `fastPut` / `fastGet` can saturate the wire with up to 64 in-flight
 *      WRITE/READ packets without colliding with siblings, and
 *   2. an abort that has to `end()` the client to interrupt `fastPut` only
 *      tears down the one session that was running this transfer — siblings
 *      and the primary (browsing) client stay alive.
 *
 * The browsing/primary `client` (used for `list`, `stat`, `mkdir`, `rename`,
 * etc.) is held outside this pool so file-pane interactions are never starved
 * by an in-flight transfer.
 *
 * The engine's `perSessionConcurrency` should not exceed this number; it does
 * the actual gating, the pool just caps the high-water mark.
 */
const MAX_JOB_POOL_PER_CONNECTION = 8;

/**
 * Throughput knobs for `fastPut` / `fastGet`. 64 in-flight 32 KB reads/writes
 * = ~2 MB on the wire at any moment, which saturates a single SSH session
 * across typical RTTs. Going higher than 32 KB rarely helps because most
 * SFTP servers cap their packet size near there anyway.
 */
const FAST_TRANSFER_CONCURRENCY = 64;
const FAST_TRANSFER_CHUNK_SIZE = 32 * 1024;

type ClientEntry = {
  client: SftpClient;
  lastProgressAt: number;
  /** Window that owns this connection (for IPC progress + cleanup). */
  ownerWebContentsId: number;
  /** Idle, ready-to-borrow extras for parallel transfers. LIFO. */
  jobPool: SftpClient[];
  /** Count of clients currently checked out via {@link acquireJobClient}. */
  jobBorrowed: number;
};

/**
 * Returned from {@link SftpManager.acquireJobClient}. `release()` returns the
 * client to the idle pool; pass `poisoned: true` if the client may have been
 * left in a bad state (e.g. you `end()`ed it to interrupt a `fastPut`) so it
 * gets discarded instead of reused.
 */
type JobClientLease = {
  client: SftpClient;
  release: (poisoned?: boolean) => void;
};

export class SftpManager {
  private readonly clients = new Map<string, ClientEntry>();
  /** Inputs cached so a dropped session can be silently re-established. */
  private readonly connectInputs = new Map<string, SftpConnectInput>();
  /** Owner webContents id remembered across reconnects. */
  private readonly connectOwners = new Map<string, number>();

  private emitProgress(payload: {
    connectionId: string;
    direction: "upload" | "download";
    remotePath: string;
    localPath: string;
    transferred: number;
    total: number;
  }): void {
    const entry = this.clients.get(payload.connectionId);
    if (!entry) return;
    const wc = webContents.fromId(entry.ownerWebContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.send("synctron:sftp:progress", payload);
  }

  private shouldEmit(entry: ClientEntry): boolean {
    const now = Date.now();
    if (now - entry.lastProgressAt >= PROGRESS_INTERVAL_MS) {
      entry.lastProgressAt = now;
      return true;
    }
    return false;
  }

  async connect(
    opts: SftpConnectInput,
    ownerWebContentsId: number,
  ): Promise<Result<{ connectionId: string }>> {
    if (!opts.password?.length && !opts.privateKeyPath?.length) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Provide a password or private key path",
        },
      };
    }

    const keyResult = await this.loadPrivateKey(opts.privateKeyPath);
    if (!keyResult.ok) return keyResult;

    const client = new SftpClient();
    try {
      await client.connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.username,
        password: opts.password,
        privateKey: keyResult.data,
        readyTimeout: 30_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: () => true,
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }

    const connectionId = randomUUID();
    this.registerClient(connectionId, client, ownerWebContentsId);
    this.connectInputs.set(connectionId, opts);
    this.connectOwners.set(connectionId, ownerWebContentsId);
    return { ok: true, data: { connectionId } };
  }

  /**
   * Wire a fresh client into the pool and arrange for the entry to be evicted
   * if the underlying ssh2 session drops (e.g. keepalive timeout). The cached
   * connect input is intentionally NOT cleared on drop so {@link ensureConnected}
   * can transparently reconnect on the next job.
   */
  private registerClient(
    connectionId: string,
    client: SftpClient,
    ownerWebContentsId: number,
  ): void {
    this.clients.set(connectionId, {
      client,
      lastProgressAt: 0,
      ownerWebContentsId,
      jobPool: [],
      jobBorrowed: 0,
    });
    const drop = (): void => {
      const current = this.clients.get(connectionId);
      if (current && current.client === client) {
        // Drain the pool too — if the primary session went away, keepalive
        // failures usually mean the network is gone for everyone, so don't
        // try to keep stale extras around.
        for (const c of current.jobPool) {
          try {
            void c.end();
          } catch {
            /* ignore */
          }
        }
        current.jobPool.length = 0;
        this.clients.delete(connectionId);
      }
    };
    client.on("end", drop);
    client.on("close", drop);
  }

  /**
   * Borrow a dedicated `SftpClient` for the duration of one transfer job.
   * Reuses an idle client from the pool if available, otherwise opens a
   * fresh SSH session using the cached connect input.
   *
   * Always returns a `release()` function — call it (with `poisoned: true`
   * if the client was forcibly torn down to abort a `fastPut`) when the job
   * is done so the slot frees up. If you forget to release, the connection
   * leaks until {@link disconnect} is called.
   */
  private async acquireJobClient(
    connectionId: string,
  ): Promise<Result<JobClientLease>> {
    const ensured = await this.ensureConnected(connectionId);
    if (!ensured.ok) return ensured;
    const entry = ensured.data;

    let client = entry.jobPool.pop();
    if (!client) {
      // Engine concurrency should keep us under the cap; if not, fall back
      // to the primary client (slower because it serializes with browsing,
      // but correct).
      if (entry.jobBorrowed >= MAX_JOB_POOL_PER_CONNECTION) {
        entry.jobBorrowed++;
        const primary = entry.client;
        return {
          ok: true,
          data: {
            client: primary,
            release: (): void => {
              entry.jobBorrowed = Math.max(0, entry.jobBorrowed - 1);
            },
          },
        };
      }
      const cachedInput = this.connectInputs.get(connectionId);
      if (!cachedInput) {
        return {
          ok: false,
          error: { code: "SFTP", message: "No SFTP connection" },
        };
      }
      const keyResult = await this.loadPrivateKey(cachedInput.privateKeyPath);
      if (!keyResult.ok) return keyResult;
      const fresh = new SftpClient();
      try {
        await fresh.connect({
          host: cachedInput.host,
          port: cachedInput.port ?? 22,
          username: cachedInput.username,
          password: cachedInput.password,
          privateKey: keyResult.data,
          readyTimeout: 30_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 4,
          hostVerifier: () => true,
        });
      } catch (e) {
        return sftpError(e);
      }
      client = fresh;
    }

    entry.jobBorrowed++;
    const borrowed = client;
    const release = (poisoned: boolean = false): void => {
      entry.jobBorrowed = Math.max(0, entry.jobBorrowed - 1);
      // Never return the primary to the extras pool — it's owned by the
      // entry directly. Also never recycle a poisoned client (e.g. one we
      // `end()`ed to interrupt a `fastPut`) because its SSH state is gone.
      if (poisoned || borrowed === entry.client) {
        if (poisoned && borrowed !== entry.client) {
          try {
            void borrowed.end();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (entry.jobPool.length < MAX_JOB_POOL_PER_CONNECTION) {
        entry.jobPool.push(borrowed);
      } else {
        try {
          void borrowed.end();
        } catch {
          /* ignore */
        }
      }
    };
    return { ok: true, data: { client: borrowed, release } };
  }

  private async loadPrivateKey(
    privateKeyPath: string | undefined,
  ): Promise<Result<string | undefined>> {
    if (!privateKeyPath) return { ok: true, data: undefined };
    try {
      const data = await readFile(resolve(privateKeyPath), "utf8");
      return { ok: true, data };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message:
            e instanceof Error ? e.message : "Failed to read private key file",
        },
      };
    }
  }

  /**
   * Return the live entry for `connectionId`. If the entry is missing but we
   * have cached connect input (e.g. the session was reaped after a network
   * drop), reconnect transparently and re-register under the same id, keeping
   * the original `ownerWebContentsId` so progress events still route home.
   */
  private async ensureConnected(
    connectionId: string,
  ): Promise<Result<ClientEntry>> {
    const existing = this.clients.get(connectionId);
    if (existing) return { ok: true, data: existing };

    const cachedInput = this.connectInputs.get(connectionId);
    const cachedOwner = this.connectOwners.get(connectionId);
    if (!cachedInput || cachedOwner === undefined) {
      return {
        ok: false,
        error: { code: "SFTP", message: "No SFTP connection" },
      };
    }

    const keyResult = await this.loadPrivateKey(cachedInput.privateKeyPath);
    if (!keyResult.ok) return keyResult;

    const client = new SftpClient();
    try {
      await client.connect({
        host: cachedInput.host,
        port: cachedInput.port ?? 22,
        username: cachedInput.username,
        password: cachedInput.password,
        privateKey: keyResult.data,
        readyTimeout: 30_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: () => true,
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }

    this.registerClient(connectionId, client, cachedOwner);
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: "Failed to register reconnected client",
        },
      };
    }
    return { ok: true, data: entry };
  }

  async disconnect(connectionId: string): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    this.connectInputs.delete(connectionId);
    this.connectOwners.delete(connectionId);
    if (!entry) {
      return {
        ok: false,
        error: { code: "SFTP", message: "Unknown connection" },
      };
    }
    // Tear down the pooled job clients first; failures here are best-effort
    // and shouldn't block the primary disconnect.
    for (const c of entry.jobPool) {
      try {
        await c.end();
      } catch {
        /* ignore */
      }
    }
    entry.jobPool.length = 0;
    try {
      await entry.client.end();
    } catch {
      /* ignore */
    }
    this.clients.delete(connectionId);
    return { ok: true, data: undefined };
  }

  /** Close every SFTP session opened from a window that is closing. */
  async disconnectByOwner(ownerWebContentsId: number): Promise<void> {
    const ids = [...this.clients.entries()]
      .filter(([, e]) => e.ownerWebContentsId === ownerWebContentsId)
      .map(([id]) => id);
    for (const id of ids) {
      await this.disconnect(id);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.clients.keys()]) {
      await this.disconnect(id);
    }
  }

  /** Resolve a path to its absolute form on the server (for `~` and relative). */
  async realPath(
    connectionId: string,
    remotePath: string,
  ): Promise<Result<string>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    try {
      const abs = await entry.client.realPath(remotePath);
      return { ok: true, data: abs };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  /** Return the user's default working directory (typically their home). */
  async cwd(connectionId: string): Promise<Result<string>> {
    return this.realPath(connectionId, ".");
  }

  async list(
    connectionId: string,
    remotePath: string,
  ): Promise<Result<RemoteListEntry[]>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }

    const safe = normalizePosixPath(remotePath);
    try {
      const raw = await entry.client.list(safe);
      const entries: RemoteListEntry[] = raw.map((item) => {
        const type = fileTypeFromSftp(item.type);
        const name = item.name;
        const path = joinPosix(safe, name);
        return {
          name,
          path,
          type,
          size: typeof item.size === "number" ? item.size : 0,
          mtimeMs: typeof item.modifyTime === "number" ? item.modifyTime : null,
        };
      });
      entries.sort((a, b) => {
        if (a.type === "dir" && b.type !== "dir") return -1;
        if (a.type !== "dir" && b.type === "dir") return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return { ok: true, data: entries };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  /**
   * Recursively walk a remote directory and return a flat list of regular
   * files with their sizes and POSIX-style paths relative to `remotePath`.
   * Mirrors {@link walkLocal} on the local side. Symlinks are skipped to
   * avoid cycles. Uses the primary browsing client because the walk is
   * read-only and the per-job pool is reserved for in-flight transfers.
   */
  async walk(
    connectionId: string,
    remotePath: string,
  ): Promise<Result<WalkedEntry[]>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const root = normalizePosixPath(remotePath);
    const out: WalkedEntry[] = [];

    const visit = async (relDir: string): Promise<void> => {
      const absDir = relDir ? joinPosix(root, relDir) : root;
      let raw: Awaited<ReturnType<typeof entry.client.list>>;
      try {
        raw = await entry.client.list(absDir);
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      for (const item of raw) {
        if (out.length >= REMOTE_WALK_MAX_FILES) {
          throw new Error(
            `Remote walk aborted after ${REMOTE_WALK_MAX_FILES} files; please transfer in smaller batches`,
          );
        }
        const type = fileTypeFromSftp(item.type);
        const rel = relDir ? `${relDir}/${item.name}` : item.name;
        if (type === "link") continue;
        if (type === "dir") {
          await visit(rel);
          continue;
        }
        if (type !== "file") continue;
        out.push({
          relPath: rel,
          size: typeof item.size === "number" ? item.size : 0,
          mtimeMs:
            typeof item.modifyTime === "number" ? item.modifyTime : null,
        });
      }
    };

    try {
      await visit("");
      return { ok: true, data: out };
    } catch (e) {
      return sftpError(e);
    }
  }

  async upload(
    connectionId: string,
    localPath: string,
    remotePath: string,
  ): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }

    const local = resolve(localPath);
    const remote = normalizePosixPath(remotePath);

    try {
      await entry.client.fastPut(local, remote, {
        step: (transferred, _chunk, total) => {
          if (this.shouldEmit(entry)) {
            this.emitProgress({
              connectionId,
              direction: "upload",
              remotePath: remote,
              localPath: local,
              transferred,
              total,
            });
          }
        },
      });
      return { ok: true, data: undefined };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  async download(
    connectionId: string,
    remotePath: string,
    localPath: string,
  ): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }

    const local = resolve(localPath);
    const remote = normalizePosixPath(remotePath);

    try {
      await entry.client.fastGet(remote, local, {
        step: (transferred, _chunk, total) => {
          if (this.shouldEmit(entry)) {
            this.emitProgress({
              connectionId,
              direction: "download",
              remotePath: remote,
              localPath: local,
              transferred,
              total,
            });
          }
        },
      });
      return { ok: true, data: undefined };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: "SFTP",
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  /**
   * Job-style upload used by the {@link TransferEngine}. Borrows a dedicated
   * SFTP session from the per-connection pool ({@link acquireJobClient}) so
   * it can use `fastPut`'s 64-way pipelining without colliding with sibling
   * transfers, and so the abort path can `end()` the session safely.
   *
   * - Writes to a deterministic `${remote}.blz-<sha1(local|remote)[:12]>.part`
   *   sidecar so that a later attempt can resume into the SAME temp file.
   * - **Cold-start path** (`resumeOffset === 0`): uses `fastPut` with
   *   `concurrency: 64, chunkSize: 32 KB` for max single-session throughput.
   * - **Resume path** (`resumeOffset > 0`): falls back to the streaming
   *   pipeline because `fastPut` doesn't expose a `start` offset. Slower but
   *   correctness-preserving — only hit after a network drop or pause.
   * - On {@link signal} abort, the borrowed client is forcibly `end()`ed and
   *   marked poisoned so the pool drops it. Sibling transfers on OTHER
   *   borrowed clients are unaffected. The `.part` sidecar is preserved.
   * - After transfer, sidecar size is verified against the local file size;
   *   on match we rename via `posixRename` (atomic on POSIX servers), falling
   *   back to `delete` + `rename` for servers that reject overwrites.
   * - If the connection was reaped between attempts, {@link acquireJobClient}
   *   transparently reconnects via the cached input.
   */
  async uploadJob(
    connectionId: string,
    localPath: string,
    remotePath: string,
    onProgress: (transferred: number, total: number) => void,
    signal: AbortSignal,
    resumeOffset: number = 0,
  ): Promise<Result<void>> {
    if (signal.aborted) {
      return { ok: false, error: { code: "SFTP", message: "aborted" } };
    }
    const lease = await this.acquireJobClient(connectionId);
    if (!lease.ok) return lease;
    const { client } = lease.data;
    let poisoned = false;

    try {
      const local = resolve(localPath);
      const remote = normalizePosixPath(remotePath);
      const tmpRemote = buildPartPath(remote, local, remote);

      let totalSize: number;
      try {
        const localStat = await stat(local);
        totalSize = localStat.size;
      } catch (e) {
        return sftpError(e);
      }

      let effectiveOffset = resumeOffset;
      if (effectiveOffset > 0) {
        try {
          const partStat = await client.stat(tmpRemote);
          const partSize =
            typeof partStat.size === "number" ? partStat.size : 0;
          if (partSize < effectiveOffset) effectiveOffset = 0;
        } catch {
          effectiveOffset = 0;
        }
      }

      // Wire abort → end the borrowed client. fastPut has no signal
      // support, so the only way to interrupt it is to tear down the SSH
      // session. The lease will be poisoned so the pool drops the client.
      const onAbort = (): void => {
        poisoned = true;
        try {
          void client.end();
        } catch {
          /* ignore */
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (effectiveOffset === 0) {
          // Cold-start fast path: 64-way pipelined fastPut.
          let lastEmit = 0;
          try {
            await client.fastPut(local, tmpRemote, {
              concurrency: FAST_TRANSFER_CONCURRENCY,
              chunkSize: FAST_TRANSFER_CHUNK_SIZE,
              step: (transferred, _chunk, total): void => {
                const now = Date.now();
                if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                  lastEmit = now;
                  onProgress(transferred, total || totalSize);
                }
              },
            });
            onProgress(totalSize, totalSize);
          } catch (e) {
            if (signal.aborted) {
              return {
                ok: false,
                error: { code: "SFTP", message: "aborted" },
              };
            }
            return sftpError(e);
          }
        } else {
          // Resume path: stream into the existing .part starting at offset.
          let lastEmit = 0;
          let cumulative = effectiveOffset;
          const tap = new Transform({
            transform(chunk: Buffer, _enc, cb): void {
              cumulative += chunk.length;
              const now = Date.now();
              if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                lastEmit = now;
                onProgress(cumulative, totalSize);
              }
              cb(null, chunk);
            },
          });

          const rs: Readable = createReadStream(local, {
            start: effectiveOffset,
          });
          const ws: Writable = client.createWriteStream(tmpRemote, {
            flags: "r+",
            start: effectiveOffset,
          });

          try {
            await pipeline(rs, tap, ws);
            onProgress(cumulative, totalSize);
          } catch (e) {
            if (signal.aborted) {
              return {
                ok: false,
                error: { code: "SFTP", message: "aborted" },
              };
            }
            return sftpError(e);
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      let uploadedSize: number;
      try {
        const st = await client.stat(tmpRemote);
        uploadedSize = typeof st.size === "number" ? st.size : -1;
      } catch (e) {
        return sftpError(e);
      }
      if (uploadedSize !== totalSize) {
        return {
          ok: false,
          error: {
            code: "SFTP",
            message: `Size mismatch after upload: expected ${totalSize}, got ${uploadedSize}`,
          },
        };
      }

      try {
        await client.posixRename(tmpRemote, remote);
      } catch {
        try {
          await client.delete(remote);
        } catch {
          /* destination may not exist; rename below is the real test */
        }
        try {
          await client.rename(tmpRemote, remote);
        } catch (e) {
          return sftpError(e);
        }
      }

      return { ok: true, data: undefined };
    } finally {
      lease.data.release(poisoned);
    }
  }

  async mkdir(connectionId: string, remotePath: string): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const remote = normalizePosixPath(remotePath);
    try {
      await entry.client.mkdir(remote, true);
      return { ok: true, data: undefined };
    } catch (e) {
      return sftpError(e);
    }
  }

  async rename(
    connectionId: string,
    oldPath: string,
    newPath: string,
  ): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const from = normalizePosixPath(oldPath);
    const to = normalizePosixPath(newPath);
    try {
      await entry.client.rename(from, to);
      return { ok: true, data: undefined };
    } catch (e) {
      return sftpError(e);
    }
  }

  async remove(
    connectionId: string,
    remotePath: string,
    recursive: boolean,
  ): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const remote = normalizePosixPath(remotePath);
    try {
      const st = await entry.client.stat(remote);
      if (st.isDirectory) {
        await entry.client.rmdir(remote, recursive);
      } else {
        await entry.client.delete(remote);
      }
      return { ok: true, data: undefined };
    } catch (e) {
      return sftpError(e);
    }
  }

  async chmod(
    connectionId: string,
    remotePath: string,
    mode: number,
  ): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const remote = normalizePosixPath(remotePath);
    try {
      await entry.client.chmod(remote, mode);
      return { ok: true, data: undefined };
    } catch (e) {
      return sftpError(e);
    }
  }

  async stat(
    connectionId: string,
    remotePath: string,
  ): Promise<Result<FileStat>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const remote = normalizePosixPath(remotePath);
    try {
      const st = await entry.client.stat(remote);
      return {
        ok: true,
        data: {
          size: typeof st.size === "number" ? st.size : 0,
          // ssh2-sftp-client v12 returns modifyTime already in milliseconds.
          mtimeMs: typeof st.modifyTime === "number" ? st.modifyTime : 0,
          isDirectory: !!st.isDirectory,
          isFile: !!st.isFile,
          isSymbolicLink: !!st.isSymbolicLink,
          mode: typeof st.mode === "number" ? st.mode : 0,
        },
      };
    } catch (e) {
      return sftpError(e);
    }
  }

  /**
   * Stream a remote file through a hash function and return the hex digest.
   * Used by the Properties dialog ("Compute MD5/SHA-256"). We deliberately
   * do NOT shell out to `md5sum` over SSH because we cannot rely on what
   * the server has installed (BSD `md5`, GNU `md5sum`, BusyBox, none of
   * the above on locked-down appliances). Streaming through the SFTP
   * read channel works on every server with sftp-subsystem enabled.
   *
   * Borrows a job-pool client so the primary browsing connection isn't
   * blocked while we read the whole file. The borrowed client is poisoned
   * on error so it doesn't get reused in a half-read state.
   */
  async hash(
    connectionId: string,
    remotePath: string,
    algorithm: "md5" | "sha1" | "sha256",
  ): Promise<Result<string>> {
    const lease = await this.acquireJobClient(connectionId);
    if (!lease.ok) return lease;
    const { client } = lease.data;
    let poisoned = false;
    try {
      const remote = normalizePosixPath(remotePath);
      const hash = createHash(algorithm);
      const rs: Readable = client.createReadStream(remote);
      try {
        for await (const chunk of rs) {
          hash.update(chunk as Buffer);
        }
      } catch (e) {
        poisoned = true;
        return sftpError(e);
      }
      return { ok: true, data: hash.digest("hex") };
    } finally {
      lease.data.release(poisoned);
    }
  }

  async readText(
    connectionId: string,
    remotePath: string,
    maxBytes: number = DEFAULT_READ_TEXT_MAX_BYTES,
  ): Promise<Result<string>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const remote = normalizePosixPath(remotePath);
    try {
      const st = await entry.client.stat(remote);
      const size = typeof st.size === "number" ? st.size : 0;
      if (size > maxBytes) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `File too large: ${size} bytes exceeds limit of ${maxBytes}`,
          },
        };
      }
      const buf = (await entry.client.get(remote)) as Buffer;
      return { ok: true, data: buf.toString("utf8") };
    } catch (e) {
      return sftpError(e);
    }
  }

  async writeText(
    connectionId: string,
    remotePath: string,
    contents: string,
  ): Promise<Result<void>> {
    const entry = this.clients.get(connectionId);
    if (!entry) {
      return { ok: false, error: { code: "SFTP", message: "Not connected" } };
    }
    const remote = normalizePosixPath(remotePath);
    const tmp = join(
      tmpdir(),
      `synctron-sftp-write-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tmp, contents, "utf8");
      await entry.client.fastPut(tmp, remote);
      return { ok: true, data: undefined };
    } catch (e) {
      return sftpError(e);
    } finally {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Job-style download used by the {@link TransferEngine}. See {@link uploadJob}
   * for the shared design notes (resume-aware, atomic via temp + rename,
   * shared-session-safe abort, transparent reconnect). Differences:
   *
   * - The temp sidecar is local: `${local}.blz-<sha1(local|remote)[:12]>.part`,
   *   and the final swap uses `fs.promises.rename` (atomic on the same
   *   filesystem).
   * - Before opening the write stream we attempt `statfs(dirname(local))` and
   *   fail fast if free space < remote size. A `statfs` failure is non-fatal
   *   (skipped on platforms that don't support it).
   * - The remote source size captured up-front is used as the reference for
   *   the post-transfer size check.
   */
  async downloadJob(
    connectionId: string,
    remotePath: string,
    localPath: string,
    onProgress: (transferred: number, total: number) => void,
    signal: AbortSignal,
    resumeOffset: number = 0,
  ): Promise<Result<void>> {
    if (signal.aborted) {
      return { ok: false, error: { code: "SFTP", message: "aborted" } };
    }
    const lease = await this.acquireJobClient(connectionId);
    if (!lease.ok) return lease;
    const { client } = lease.data;
    let poisoned = false;

    try {
      const local = resolve(localPath);
      const remote = normalizePosixPath(remotePath);
      const tmpLocal = buildPartPath(local, local, remote);

      let totalSize: number;
      try {
        const remoteStat = await client.stat(remote);
        totalSize = typeof remoteStat.size === "number" ? remoteStat.size : 0;
      } catch (e) {
        return sftpError(e);
      }

      try {
        const fsStats = await statfs(dirname(local));
        const bavail = Number(fsStats.bavail);
        const bsize = Number(fsStats.bsize);
        const free = bavail * bsize;
        if (Number.isFinite(free) && free < totalSize) {
          return {
            ok: false,
            error: {
              code: "SFTP",
              message: `Not enough disk space at ${dirname(local)}: need ${totalSize}, have ${free}`,
            },
          };
        }
      } catch {
        /* statfs not supported on this platform; skip precheck */
      }

      let effectiveOffset = resumeOffset;
      if (effectiveOffset > 0) {
        try {
          const partStat = await stat(tmpLocal);
          if (partStat.size < effectiveOffset) effectiveOffset = 0;
        } catch {
          effectiveOffset = 0;
        }
      }

      const onAbort = (): void => {
        poisoned = true;
        try {
          void client.end();
        } catch {
          /* ignore */
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (effectiveOffset === 0) {
          // Cold-start fast path: 64-way pipelined fastGet into the .part.
          let lastEmit = 0;
          try {
            await client.fastGet(remote, tmpLocal, {
              concurrency: FAST_TRANSFER_CONCURRENCY,
              chunkSize: FAST_TRANSFER_CHUNK_SIZE,
              step: (transferred, _chunk, total): void => {
                const now = Date.now();
                if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                  lastEmit = now;
                  onProgress(transferred, total || totalSize);
                }
              },
            });
            onProgress(totalSize, totalSize);
          } catch (e) {
            if (signal.aborted) {
              return {
                ok: false,
                error: { code: "SFTP", message: "aborted" },
              };
            }
            return sftpError(e);
          }
        } else {
          // Resume path: stream into the existing .part starting at offset.
          let lastEmit = 0;
          let cumulative = effectiveOffset;
          const tap = new Transform({
            transform(chunk: Buffer, _enc, cb): void {
              cumulative += chunk.length;
              const now = Date.now();
              if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                lastEmit = now;
                onProgress(cumulative, totalSize);
              }
              cb(null, chunk);
            },
          });

          const rs: Readable = client.createReadStream(remote, {
            start: effectiveOffset,
          });
          const ws: Writable = createWriteStream(tmpLocal, {
            flags: "r+",
            start: effectiveOffset,
          });

          try {
            await pipeline(rs, tap, ws);
            onProgress(cumulative, totalSize);
          } catch (e) {
            if (signal.aborted) {
              return {
                ok: false,
                error: { code: "SFTP", message: "aborted" },
              };
            }
            return sftpError(e);
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      let downloadedSize: number;
      try {
        const st = await stat(tmpLocal);
        downloadedSize = st.size;
      } catch (e) {
        return sftpError(e);
      }
      if (downloadedSize !== totalSize) {
        return {
          ok: false,
          error: {
            code: "SFTP",
            message: `Size mismatch after download: expected ${totalSize}, got ${downloadedSize}`,
          },
        };
      }

      try {
        await rename(tmpLocal, local);
      } catch (e) {
        return sftpError(e);
      }

      return { ok: true, data: undefined };
    } finally {
      lease.data.release(poisoned);
    }
  }
}

function normalizePosixPath(p: string): string {
  const n = normalize(p.replace(/\\/g, "/"));
  if (!n.startsWith("/")) {
    return `/${n}`;
  }
  return n;
}

function joinPosix(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/$/, "")}/${name}`;
}

function sftpError(e: unknown): Result<never> {
  return {
    ok: false,
    error: {
      code: "SFTP",
      message: e instanceof Error ? e.message : String(e),
    },
  };
}

function fileTypeFromSftp(t: string): RemoteListEntry["type"] {
  if (t === "d") return "dir";
  if (t === "-" || t === "f") return "file";
  if (t === "l") return "link";
  return "other";
}

/**
 * Build a `.blz-<hash>.part` sidecar path that is stable across attempts of
 * the same `(localPath, remotePath)` pair, so resume can find the prior temp
 * file regardless of the side it lives on.
 */
function buildPartPath(
  base: string,
  localPath: string,
  remotePath: string,
): string {
  const hash = createHash("sha1")
    .update(`${localPath}|${remotePath}`)
    .digest("hex")
    .slice(0, 12);
  return `${base}.blz-${hash}.part`;
}
