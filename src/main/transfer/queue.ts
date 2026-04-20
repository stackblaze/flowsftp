import { randomUUID } from "crypto";
import type { JobStore } from "./job-store";
import type { Job, JobInput, TransferEvent } from "./types";

type Listener = (e: TransferEvent) => void;

/**
 * Throttle window for pure-progress writes to disk. Rapidly-streaming
 * transfers can fire `update({ transferred })` hundreds of times per
 * second; we coalesce those into at most one disk write per job per
 * window. State-changing patches (status, error, finishedAt, etc.) bypass
 * the throttle entirely so the on-disk view never lags reality where it
 * matters.
 */
const PROGRESS_PERSIST_THROTTLE_MS = 1000;

/**
 * In-memory transfer queue with event emission and optional disk persistence.
 * Pure logic — no SFTP, no scheduling. The {@link TransferEngine} consumes
 * events from this queue and drives actual transfers.
 */
export class TransferQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<Listener>();
  /** Canonical ordering of all jobs; drives both UI display and the
   *  engine's pickNext priority. New jobs append to the tail; reorder()
   *  rewrites this for queued/paused jobs only. */
  private readonly order: string[] = [];
  /** Optional persistence sink. `null` keeps the queue purely in-memory
   *  (used by unit tests and any future ephemeral mode). */
  private readonly store: JobStore | null;
  /** Per-job timestamps of the last persisted progress write, used to
   *  throttle high-frequency `transferred` updates. State changes bypass
   *  this map. */
  private readonly lastProgressPersist = new Map<string, number>();
  /** Job ids with a progress write deferred by the throttle, waiting to be
   *  flushed by the next state change or by `flush()`. */
  private readonly pendingProgressFlush = new Set<string>();

  constructor(store: JobStore | null = null) {
    this.store = store;
    if (store) {
      const rows = store.load();
      for (const r of rows) {
        // A job persisted as "running" is by definition orphaned — the
        // process that was running it died. Reset to "queued" so the
        // engine picks it up and the SFTP layer's resumeOffset machinery
        // continues from `transferred` bytes.
        const j: Job =
          r.status === "running" ? { ...r, status: "queued" } : r;
        this.jobs.set(j.id, j);
        this.order.push(j.id);
      }
      // The hydrated jobs already have correct on-disk positions; only
      // persist the running→queued status reset for any rows we mutated.
      for (const j of this.jobs.values()) {
        if (j.status === "queued") {
          // Re-upserting a previously-running row writes the new status
          // without touching position. Cheap; runs once on startup.
          const i = this.order.indexOf(j.id);
          if (i >= 0) store.upsert(j, i);
        }
      }
    }
  }

  enqueue(input: JobInput): Job {
    // Dedupe: if there's already a *pending* job (queued / running / paused)
    // for the exact same target, return it instead of creating a twin.
    // The UI can fire enqueue multiple times for a single user intent
    // (drag-drop, F5 + click race, multi-window broadcasts, HMR-leaked
    // listeners), and a duplicate row in the queue panel is never useful —
    // it just confuses the user about which one is "the real" transfer.
    // Terminal jobs (completed/failed/cancelled) are *not* deduped against,
    // so the user can intentionally re-transfer the same file later.
    for (const existing of this.jobs.values()) {
      if (
        existing.connectionId === input.connectionId &&
        existing.kind === input.kind &&
        existing.src === input.src &&
        existing.dst === input.dst &&
        (existing.status === "queued" ||
          existing.status === "running" ||
          existing.status === "paused")
      ) {
        return { ...existing };
      }
    }
    const job: Job = {
      id: randomUUID(),
      connectionId: input.connectionId,
      kind: input.kind,
      src: input.src,
      dst: input.dst,
      size: input.size ?? 0,
      transferred: 0,
      status: "queued",
      attempt: 0,
      priority: input.priority ?? "normal",
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.persistJob(job);
    this.emit({ type: "added", job: { ...job } });
    return { ...job };
  }

  list(): Job[] {
    const out: Job[] = [];
    for (const id of this.order) {
      const j = this.jobs.get(id);
      if (j) out.push({ ...j });
    }
    return out;
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const cur = this.jobs.get(id);
    if (!cur) return undefined;
    const next: Job = { ...cur, ...patch, id: cur.id };
    this.jobs.set(id, next);
    // Decide whether this update is "noisy" (transferred-only or
    // attempt-only progress chatter) or "structural" (status change,
    // error, finishedAt, etc.). Structural changes flush immediately and
    // also drain any deferred progress write for this job. Noisy changes
    // throttle to PROGRESS_PERSIST_THROTTLE_MS.
    const isStructural =
      "status" in patch ||
      "error" in patch ||
      "finishedAt" in patch ||
      "startedAt" in patch ||
      "size" in patch ||
      "priority" in patch;
    if (isStructural) {
      this.persistJob(next);
    } else {
      this.persistProgressThrottled(next);
    }
    this.emit({ type: "updated", job: { ...next } });
    return { ...next };
  }

  remove(id: string): boolean {
    const had = this.jobs.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    this.lastProgressPersist.delete(id);
    this.pendingProgressFlush.delete(id);
    if (this.store) this.store.delete(id);
    // Always notify subscribers, even if we didn't know about this id.
    // The UI is the source of truth for what the user *sees* in the queue
    // panel; if a ghost row ever drifts out of sync with main (multi-window
    // broadcast race, HMR-leaked listener, lost event during reconnect),
    // a "removed" event is the only signal that lets the renderer drop it.
    // The event is idempotent on the renderer side (it's just an array
    // filter), so re-broadcasting for an unknown id is harmless.
    this.emit({ type: "removed", id });
    return had;
  }

  /**
   * Rewrite the order of pending jobs. `desiredOrder` is a list of ids the
   * caller wants to slot into the head of the pending range, in order. Any
   * pending ids not mentioned keep their relative order at the tail.
   * Running and terminal jobs (completed/failed/cancelled) are *never*
   * reordered — moving them would either lie about scheduling or pretend
   * to rewrite history.
   */
  reorder(desiredOrder: string[]): void {
    const isPending = (id: string): boolean => {
      const j = this.jobs.get(id);
      return !!j && (j.status === "queued" || j.status === "paused");
    };
    const desired = desiredOrder.filter(
      (id, i) => isPending(id) && desiredOrder.indexOf(id) === i,
    );
    if (desired.length === 0) return;
    const desiredSet = new Set(desired);
    // Keep non-pending jobs anchored to their existing slots; weave the
    // newly ordered pending ids in their requested sequence into the slots
    // that previously held pending ids. This preserves the visual position
    // of any running job between two queued blocks.
    const next: string[] = [];
    let cursor = 0;
    for (const id of this.order) {
      const j = this.jobs.get(id);
      if (!j) continue;
      const pendingHere = j.status === "queued" || j.status === "paused";
      if (pendingHere && desiredSet.has(id)) {
        const pick = desired[cursor++];
        if (pick) next.push(pick);
      } else if (pendingHere) {
        next.push(id);
      } else {
        next.push(id);
      }
    }
    // Append any remaining desired ids that weren't slotted (defensive).
    while (cursor < desired.length) {
      const pick = desired[cursor++];
      if (pick && !next.includes(pick)) next.push(pick);
    }
    this.order.length = 0;
    this.order.push(...next);
    if (this.store) this.store.setPositions(this.order.slice());
    this.emit({ type: "reordered", orderedIds: this.order.slice() });
  }

  pause(id: string): Job | undefined {
    const cur = this.jobs.get(id);
    if (!cur) return undefined;
    if (cur.status === "completed" || cur.status === "cancelled") return cur;
    return this.update(id, { status: "paused" });
  }

  resume(id: string): Job | undefined {
    const cur = this.jobs.get(id);
    if (!cur) return undefined;
    if (cur.status !== "paused" && cur.status !== "failed") return cur;
    // True byte-offset resume; we keep `transferred` so the next
    // pickNext + start cycle picks up from the last persisted offset.
    return this.update(id, {
      status: "queued",
      error: undefined,
    });
  }

  cancel(id: string): Job | undefined {
    const cur = this.jobs.get(id);
    if (!cur) return undefined;
    if (cur.status === "completed" || cur.status === "cancelled") return cur;
    return this.update(id, { status: "cancelled", finishedAt: Date.now() });
  }

  pauseAll(): void {
    for (const j of [...this.jobs.values()]) {
      if (j.status === "queued" || j.status === "running") {
        this.pause(j.id);
      }
    }
  }

  resumeAll(): void {
    for (const j of [...this.jobs.values()]) {
      if (j.status === "paused") {
        this.resume(j.id);
      }
    }
  }

  clearCompleted(): void {
    for (const j of [...this.jobs.values()]) {
      if (j.status === "completed" || j.status === "cancelled") {
        this.remove(j.id);
      }
    }
  }

  /** Subscribe to queue events. Returns an unsubscribe handle. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit a snapshot to all listeners (e.g. on new subscriber). */
  emitSnapshot(): void {
    this.emit({ type: "snapshot", jobs: this.list() });
  }

  private emit(e: TransferEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* listener errors must not break the queue */
      }
    }
  }

  /** Write a job to the store at its current order slot. Skips silently
   *  when running without a store (in-memory tests, ephemeral mode). */
  private persistJob(job: Job): void {
    if (!this.store) return;
    const idx = this.order.indexOf(job.id);
    if (idx < 0) return;
    this.store.upsert(job, idx);
    this.lastProgressPersist.set(job.id, Date.now());
    this.pendingProgressFlush.delete(job.id);
  }

  /** Throttled variant for high-frequency progress updates. If the last
   *  persist was within {@link PROGRESS_PERSIST_THROTTLE_MS}, the write is
   *  deferred and `pendingProgressFlush` is marked so the next structural
   *  update or {@link flush} call writes the latest snapshot. */
  private persistProgressThrottled(job: Job): void {
    if (!this.store) return;
    const last = this.lastProgressPersist.get(job.id) ?? 0;
    if (Date.now() - last >= PROGRESS_PERSIST_THROTTLE_MS) {
      this.persistJob(job);
    } else {
      this.pendingProgressFlush.add(job.id);
    }
  }

  /**
   * Drain any progress writes that were deferred by the throttle. Call this
   * before app shutdown so the on-disk transferred-bytes match what the
   * user last saw on screen — otherwise resume on next launch could
   * re-send up to one throttle window's worth of bytes.
   */
  flush(): void {
    if (!this.store) return;
    for (const id of this.pendingProgressFlush) {
      const job = this.jobs.get(id);
      if (job) this.persistJob(job);
    }
    this.pendingProgressFlush.clear();
  }

  /** Flush pending writes and close the underlying store. Idempotent. */
  close(): void {
    this.flush();
    if (this.store) this.store.close();
  }
}
