import type { SftpManager } from "../sftp/sftp-manager";
import type { Result } from "../../shared/types";
import type { TransferQueue } from "./queue";
import type { Job, JobPriority } from "./types";

const DEFAULT_GLOBAL_CONCURRENCY = 4;
/**
 * Per-session parallelism: how many transfer jobs may run concurrently
 * against the same `connectionId`.
 *
 * Each running job borrows its OWN dedicated `SftpClient` (= its own SSH
 * session / TCP connection) from `SftpManager`'s per-connection pool, so
 * collisions on a single client are no longer a concern. 4 is a sensible
 * default — enough to overlap RTT across multiple files while staying well
 * below the pool ceiling (`MAX_JOB_POOL_PER_CONNECTION = 8`) and below
 * `MaxSessions` on a typical OpenSSH server (default 10).
 */
const DEFAULT_PER_SESSION_CONCURRENCY = 4;

/** Hard ceiling exposed to the UI. Mirrors `MAX_JOB_POOL_PER_CONNECTION`
 *  in `SftpManager` — going above it would force jobs onto the primary
 *  client and lose the parallelism benefit. */
export const MAX_CONCURRENCY = 8;
export const MIN_CONCURRENCY = 1;
const MAX_ATTEMPTS = 5;
const BACKOFFS_MS = [250, 500, 1000, 2000, 4000];

/** Idle-stall watchdog: if an in-flight transfer that already moved
 *  some bytes goes silent for this long, abort it and let the engine
 *  retry on a fresh connection. */
const IDLE_TIMEOUT_MS = 60_000;
const WATCHDOG_TICK_MS = 5_000;

const PRIORITY_RANK: Record<JobPriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

type RunningEntry = {
  controller: AbortController;
  /** True when pause/cancel intentionally aborted the in-flight transfer. */
  intentionalAbort: boolean;
  /** True when the idle-stall watchdog aborted the transfer because it
   *  stopped making progress. The resulting error is always retryable. */
  watchdogTripped: boolean;
};

/** Shape of the structured error returned in {@link Result}. We accept
 *  `unknown` for `details` because Node-level errors (ssh2/ssh2-streams)
 *  surface here as nested `Error`-like objects with a `code` property. */
type StructuredError = {
  code: "VALIDATION" | "SFTP" | "FS" | "INTERNAL";
  message: string;
  details?: unknown;
};

export type TransferEngineOptions = {
  globalConcurrency?: number;
  perSessionConcurrency?: number;
};

/**
 * Schedules ready {@link Job}s onto the {@link SftpManager} respecting
 * a global parallelism cap and a per-session parallelism cap.
 *
 * Pause/cancel work by aborting the in-flight pipeline streams; the SSH
 * session itself stays open, so siblings sharing the same connection are
 * unaffected. Resume picks up from the persisted byte offset via the
 * SFTP layer's `resumeOffset`.
 */
export class TransferEngine {
  private globalConcurrency: number;
  private perSessionConcurrency: number;
  private readonly running = new Map<string, RunningEntry>();
  private readonly perSession = new Map<string, number>();
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly queue: TransferQueue,
    private readonly sftp: SftpManager,
    opts: TransferEngineOptions = {},
  ) {
    this.globalConcurrency = clampConcurrency(
      opts.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
    );
    this.perSessionConcurrency = clampConcurrency(
      opts.perSessionConcurrency ?? DEFAULT_PER_SESSION_CONCURRENCY,
    );

    this.unsubscribe = this.queue.on((e) => {
      if (e.type === "added" || e.type === "updated") {
        this.tick();
      }
    });

    // Kick the scheduler once so any jobs hydrated from disk before the
    // engine attached its listener (the JobStore-backed queue case) get
    // picked up immediately. No-op when the queue is empty.
    this.tick();
  }

  /** Stop scheduling and abort in-flight transfers. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const entry of this.running.values()) {
      entry.intentionalAbort = true;
      entry.controller.abort();
    }
  }

  /** Pause a job: mark paused and abort if running. */
  pause(id: string): void {
    const job = this.queue.get(id);
    if (!job) return;
    if (job.status === "completed" || job.status === "cancelled") return;
    const entry = this.running.get(id);
    if (entry) {
      entry.intentionalAbort = true;
      entry.controller.abort();
    }
    this.queue.pause(id);
  }

  /** Resume a paused job: re-queue and let the engine pick it up. The
   *  queue preserves `transferred`, so the next attempt resumes from the
   *  last persisted byte offset via the SFTP layer's `resumeOffset`. */
  resume(id: string): void {
    this.queue.resume(id);
    this.tick();
  }

  /** Cancel a job: mark cancelled and abort if running. */
  cancel(id: string): void {
    const job = this.queue.get(id);
    if (!job) return;
    const entry = this.running.get(id);
    if (entry) {
      entry.intentionalAbort = true;
      entry.controller.abort();
    }
    this.queue.cancel(id);
  }

  pauseAll(): void {
    for (const j of this.queue.list()) {
      if (j.status === "queued" || j.status === "running") this.pause(j.id);
    }
  }

  resumeAll(): void {
    for (const j of this.queue.list()) {
      if (j.status === "paused") this.queue.resume(j.id);
    }
    this.tick();
  }

  clearCompleted(): void {
    this.queue.clearCompleted();
  }

  /** Apply a reordering of pending jobs. The engine's pickNext() respects
   *  queue.list() ordering, so this directly influences who runs next once
   *  a slot frees up. */
  reorder(orderedIds: string[]): void {
    this.queue.reorder(orderedIds);
  }

  /** Remove a job from the queue. If it's currently running we abort the
   *  transfer first so the slot frees up — otherwise the row just disappears.
   *
   *  We deliberately do NOT bail when the queue doesn't know the id: the
   *  renderer may still be showing a ghost row (e.g. a job that was already
   *  swept by auto-clear-completed, or one that never reached this main
   *  process due to a multi-window broadcast race). `queue.remove` is
   *  idempotent and always emits a `removed` event, which is exactly the
   *  signal the renderer needs to drop the stale row. */
  removeJob(id: string): void {
    const entry = this.running.get(id);
    if (entry) {
      entry.intentionalAbort = true;
      entry.controller.abort();
    }
    this.queue.remove(id);
  }

  /** Return the current concurrency caps. */
  getConcurrency(): { global: number; perSession: number } {
    return {
      global: this.globalConcurrency,
      perSession: this.perSessionConcurrency,
    };
  }

  /** Update the concurrency caps at runtime. Both knobs are clamped to
   *  [{@link MIN_CONCURRENCY}, {@link MAX_CONCURRENCY}]. Lowering a cap
   *  does NOT abort already-running jobs — they finish naturally and the
   *  scheduler simply stops launching new ones until we're back under the
   *  new ceiling. Raising a cap immediately ticks so newly-allowed slots
   *  fill right away. */
  setConcurrency(opts: { global?: number; perSession?: number }): {
    global: number;
    perSession: number;
  } {
    let raised = false;
    if (typeof opts.global === "number") {
      const next = clampConcurrency(opts.global);
      if (next > this.globalConcurrency) raised = true;
      this.globalConcurrency = next;
    }
    if (typeof opts.perSession === "number") {
      const next = clampConcurrency(opts.perSession);
      if (next > this.perSessionConcurrency) raised = true;
      this.perSessionConcurrency = next;
    }
    if (raised) this.tick();
    return this.getConcurrency();
  }

  private tick(): void {
    if (this.stopped) return;
    while (this.running.size < this.globalConcurrency) {
      const next = this.pickNext();
      if (!next) break;
      this.start(next);
    }
  }

  private pickNext(): Job | null {
    const queued = this.queue
      .list()
      .filter((j) => j.status === "queued" && !this.running.has(j.id))
      .sort(
        (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority],
      );
    for (const j of queued) {
      const used = this.perSession.get(j.connectionId) ?? 0;
      if (used < this.perSessionConcurrency) return j;
    }
    return null;
  }

  private start(job: Job): void {
    const controller = new AbortController();
    const entry: RunningEntry = {
      controller,
      intentionalAbort: false,
      watchdogTripped: false,
    };
    this.running.set(job.id, entry);
    this.perSession.set(
      job.connectionId,
      (this.perSession.get(job.connectionId) ?? 0) + 1,
    );
    this.queue.update(job.id, {
      status: "running",
      startedAt: job.startedAt ?? Date.now(),
      error: undefined,
    });
    void this.runJob(job, entry).finally(() => {
      this.running.delete(job.id);
      const cur = this.perSession.get(job.connectionId) ?? 1;
      if (cur <= 1) this.perSession.delete(job.connectionId);
      else this.perSession.set(job.connectionId, cur - 1);
      this.tick();
    });
  }

  private async runJob(job: Job, entry: RunningEntry): Promise<void> {
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      this.queue.update(job.id, { attempt });

      // Use the queue's view if it has more progress than the in-memory
      // job snapshot (e.g. previous attempts pushed `transferred` higher
      // via onProgress before the failure).
      const cur = this.queue.get(job.id);
      const startOffset = cur?.transferred ?? job.transferred;
      const resumeOffset = startOffset;

      // Idle-stall watchdog state, scoped to this attempt.
      let lastProgressAt = Date.now();
      let lastTransferredSeen = startOffset;
      // Reset per-attempt watchdog flag on the entry so a retried attempt
      // starts from a clean slate.
      entry.watchdogTripped = false;

      const onProgress = (transferred: number, total: number): void => {
        if (transferred > lastTransferredSeen) {
          lastTransferredSeen = transferred;
          lastProgressAt = Date.now();
        }
        const patch: Partial<Job> = { transferred };
        if (total > 0 && total !== job.size) {
          patch.size = total;
          job.size = total;
        }
        this.queue.update(job.id, patch);
      };

      const watchdog = setInterval(() => {
        // Only trip if some bytes have actually moved — a transfer that
        // hangs on the very first byte is intentionally NOT killed by the
        // watchdog (could be a slow auth/stat negotiation; the SFTP layer
        // owns its own connect-timeout for that case).
        if (lastTransferredSeen <= startOffset) return;
        if (Date.now() - lastProgressAt > IDLE_TIMEOUT_MS) {
          entry.watchdogTripped = true;
          entry.controller.abort();
        }
      }, WATCHDOG_TICK_MS);

      let r: Result<void>;
      try {
        r =
          job.kind === "upload"
            ? await this.sftp.uploadJob(
                job.connectionId,
                job.src,
                job.dst,
                onProgress,
                entry.controller.signal,
                resumeOffset,
              )
            : await this.sftp.downloadJob(
                job.connectionId,
                job.src,
                job.dst,
                onProgress,
                entry.controller.signal,
                resumeOffset,
              );
      } finally {
        clearInterval(watchdog);
      }

      if (r.ok) {
        // Lock the bar at 100% on success. Use the latest known size from
        // the queue (it may have been updated mid-flight by onProgress).
        // If size is still unknown, leave `transferred` untouched — never
        // write `undefined` because Object.assign-style merge would clobber
        // the last reported value and make a completed row render as 0%.
        const after = this.queue.get(job.id);
        const patch: Partial<Job> = {
          status: "completed",
          finishedAt: Date.now(),
        };
        if (after && after.size > 0) patch.transferred = after.size;
        this.queue.update(job.id, patch);
        return;
      }

      // If pause/cancel intentionally aborted, surrender — queue already
      // reflects the new status. Watchdog aborts are NOT intentional and
      // fall through to the retry path below.
      if (entry.intentionalAbort) return;

      const after = this.queue.get(job.id);
      if (
        !after ||
        after.status === "cancelled" ||
        after.status === "paused"
      ) {
        return;
      }

      const watchdogTripped = entry.watchdogTripped;
      const retryable = watchdogTripped || isRetryableError(r.error);
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        this.queue.update(job.id, {
          status: "failed",
          error: r.error.message,
          finishedAt: Date.now(),
        });
        return;
      }

      const backoff = BACKOFFS_MS[Math.min(attempt - 1, BACKOFFS_MS.length - 1)];
      await sleep(backoff);

      // If something changed during sleep (cancel/pause), bail.
      const post = this.queue.get(job.id);
      if (
        !post ||
        post.status === "cancelled" ||
        post.status === "paused"
      ) {
        return;
      }
    }
  }
}

const RETRYABLE_NODE_CODES =
  /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|EAGAIN|EBUSY|ECONNABORTED)$/;

function hasStringCode(v: unknown): v is { code: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    typeof (v as { code: unknown }).code === "string"
  );
}

function isRetryableError(error: StructuredError): boolean {
  // Pre-check failures (free space, validation) are user-actionable, not
  // transient — never retry them.
  if (error.code === "VALIDATION") return false;

  // Peek at nested Node errors first — they carry the most reliable signal.
  if (hasStringCode(error.details)) {
    const nodeCode = error.details.code;
    if (RETRYABLE_NODE_CODES.test(nodeCode)) return true;
    // Disk-full surfacing through details should NOT retry.
    if (nodeCode === "ENOSPC") return false;
  }

  const m = error.message.toLowerCase();

  // Disk-full / out-of-space is always non-retryable, regardless of which
  // path surfaced it.
  if (
    m.includes("enospc") ||
    m.includes("no space") ||
    m.includes("disk full")
  ) {
    return false;
  }

  if (m.includes("auth")) return false;
  if (m.includes("permission")) return false;
  if (m.includes("denied")) return false;
  if (m.includes("no such file")) return false;
  if (m.includes("eacces")) return false;
  if (m.includes("enoent")) return false;

  // A size mismatch usually means the remote got truncated / the connection
  // dropped mid-write — worth a retry from the persisted offset.
  if (m.includes("size mismatch")) return true;

  if (
    m.includes("econnreset") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("etimedout") ||
    m.includes("no sftp connection") ||
    m.includes("no response") ||
    m.includes("network")
  ) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_GLOBAL_CONCURRENCY;
  const i = Math.floor(n);
  if (i < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (i > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return i;
}
