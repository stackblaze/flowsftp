import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname } from "path";
import type { Job } from "./types";

/**
 * JSON-file persistence for {@link Job} rows. The {@link TransferQueue}
 * owns the in-memory truth; this store mirrors every mutation so the queue
 * survives an app restart.
 *
 * Why a plain JSON file (no SQLite, no native deps):
 * - Zero native modules → no NODE_MODULE_VERSION rebuilds when switching
 *   between Electron's bundled Node (runtime) and vanilla Node (vitest).
 * - Our scale is tiny (typically <100 jobs, each <1 KB serialized). A full
 *   snapshot rewrite per change is a sub-millisecond operation.
 * - We never query the data — `load()` slurps everything into memory once
 *   on startup, the queue does the rest in JS.
 *
 * Durability strategy:
 * - **Atomic write.** Serialize → `writeFileSync(tmp)` → `fsync(tmp)` →
 *   `renameSync(tmp, real)`. POSIX rename is atomic, so a crash mid-write
 *   leaves either the prior good snapshot or the new good snapshot — never
 *   a half-written one.
 * - **Debounced flush.** Mutations within {@link DEBOUNCE_MS} coalesce into
 *   one write. {@link close} flushes immediately.
 * - **Schema envelope.** The on-disk shape is `{ version, jobs }` so we can
 *   gate future format changes without crashing on old files.
 *
 * Failure modes:
 * - Missing file → start empty (first run).
 * - Corrupt JSON → log a warning to stderr and start empty; the next write
 *   overwrites the broken file. We deliberately do NOT throw, because a
 *   corrupted queue file should never block the app from launching.
 */
export class JobStore {
  private static readonly SCHEMA_VERSION = 1;
  private static readonly DEBOUNCE_MS = 100;

  private readonly filePath: string;
  /** Job records by id. Mutated in-place by {@link upsert} / {@link delete}. */
  private readonly snapshot = new Map<string, Job>();
  /** Per-job slot number, mirroring the SQLite `position` column. The
   *  `load()` ordering and `setPositions` semantics depend on this. */
  private readonly positions = new Map<string, number>();

  private dirty = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.hydrateFromDisk();
  }

  /**
   * Hydrate persisted jobs in canonical order (by `position`, ascending).
   * Callers are expected to normalize ephemeral statuses (e.g. "running" →
   * "queued") before handing the rows back to the engine — the store itself
   * stays neutral about that.
   */
  load(): Job[] {
    return [...this.snapshot.values()].sort(
      (a, b) =>
        (this.positions.get(a.id) ?? 0) - (this.positions.get(b.id) ?? 0),
    );
  }

  upsert(job: Job, position: number): void {
    if (this.closed) return;
    this.snapshot.set(job.id, { ...job });
    this.positions.set(job.id, position);
    this.scheduleWrite();
  }

  delete(id: string): void {
    if (this.closed) return;
    const had = this.snapshot.delete(id);
    this.positions.delete(id);
    if (had) this.scheduleWrite();
  }

  /**
   * Rewrite `position` for the given ids. Ids not in the store are silently
   * ignored. Ids in the store but absent from `orderedIds` keep their
   * existing position (which would be wrong if the queue ever reorders a
   * partial slice — but in practice {@link TransferQueue.reorder} always
   * passes the full canonical order, matching the SQLite implementation).
   */
  setPositions(orderedIds: string[]): void {
    if (this.closed) return;
    let mutated = false;
    orderedIds.forEach((id, i) => {
      if (!this.snapshot.has(id)) return;
      const prev = this.positions.get(id);
      if (prev !== i) {
        this.positions.set(id, i);
        mutated = true;
      }
    });
    if (mutated) this.scheduleWrite();
  }

  /** Wipe everything — used by tests and by a future "Reset queue" action. */
  clear(): void {
    if (this.closed) return;
    if (this.snapshot.size === 0 && this.positions.size === 0) return;
    this.snapshot.clear();
    this.positions.clear();
    this.scheduleWrite();
  }

  /**
   * Flush any pending writes synchronously and stop accepting new ones.
   * Idempotent. Call this from `before-quit` so the on-disk view matches
   * the in-memory queue exactly.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirty) this.writeNow();
  }

  /** Synchronously flush right now (skipping the debounce). Test-only. */
  flushSync(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirty) this.writeNow();
  }

  private hydrateFromDisk(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      // Permissions, EISDIR, etc. — log and start empty rather than crashing
      // the main process on launch.
      // eslint-disable-next-line no-console
      console.warn(`[JobStore] could not read ${this.filePath}:`, e);
      return;
    }
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[JobStore] corrupt JSON at ${this.filePath}, starting empty:`,
        e,
      );
      return;
    }
    const jobs = extractJobs(parsed);
    jobs.forEach((j, i) => {
      this.snapshot.set(j.id, j);
      this.positions.set(j.id, i);
    });
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        this.writeNow();
      } catch (e) {
        // Don't take down the main process for a write failure; just log
        // and let the next mutation retry.
        // eslint-disable-next-line no-console
        console.warn(`[JobStore] write failed, will retry:`, e);
        this.dirty = true;
      }
    }, JobStore.DEBOUNCE_MS);
  }

  private writeNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const ordered = this.load();
    const payload = JSON.stringify({
      version: JobStore.SCHEMA_VERSION,
      jobs: ordered,
    });
    const tmp = `${this.filePath}.tmp`;
    // Open + write + fsync + close — fsync is what actually pushes the
    // bytes out of the OS page cache before we rename. Without it, a
    // power loss between rename and the kernel's writeback would leave
    // the destination pointing at a zero-byte (or stale) inode.
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, payload);
      try {
        fsyncSync(fd);
      } catch {
        /* fsync may fail on some virtualized filesystems; rename below
           is the actual durability guarantee for our needs. */
      }
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.filePath);
    } catch (e) {
      // Best-effort cleanup of the orphan temp file before re-throwing.
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}

/**
 * Pull a `Job[]` out of whatever the on-disk file deserializes to, defending
 * against partial / hand-edited / older-version files. Anything that doesn't
 * smell like a job record is dropped silently.
 */
function extractJobs(parsed: unknown): Job[] {
  const arr =
    Array.isArray(parsed)
      ? parsed
      : isJobEnvelope(parsed)
        ? parsed.jobs
        : [];
  const out: Job[] = [];
  for (const candidate of arr) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    if (
      typeof c.id !== "string" ||
      typeof c.connectionId !== "string" ||
      typeof c.kind !== "string" ||
      typeof c.src !== "string" ||
      typeof c.dst !== "string"
    ) {
      continue;
    }
    out.push({
      id: c.id,
      connectionId: c.connectionId,
      kind: c.kind as Job["kind"],
      src: c.src,
      dst: c.dst,
      size: typeof c.size === "number" ? c.size : 0,
      transferred: typeof c.transferred === "number" ? c.transferred : 0,
      status: (typeof c.status === "string" ? c.status : "queued") as Job["status"],
      error: typeof c.error === "string" ? c.error : undefined,
      attempt: typeof c.attempt === "number" ? c.attempt : 0,
      startedAt: typeof c.startedAt === "number" ? c.startedAt : undefined,
      finishedAt: typeof c.finishedAt === "number" ? c.finishedAt : undefined,
      priority: (typeof c.priority === "string"
        ? c.priority
        : "normal") as Job["priority"],
    });
  }
  return out;
}

function isJobEnvelope(v: unknown): v is { version: number; jobs: unknown[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    "jobs" in v &&
    Array.isArray((v as { jobs: unknown }).jobs)
  );
}
