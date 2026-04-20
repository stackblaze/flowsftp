import { defineStore } from "pinia";
import type { Job, JobInput, TransferEvent } from "@shared/types";

const SPEED_WINDOW_MS = 3000;

/** Hard bounds on the user-facing "max parallel" knob. Mirrors the main
 *  process `MAX_CONCURRENCY` / SFTP per-connection pool ceiling — going
 *  higher would force jobs onto the primary client and lose parallelism. */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 4;

/**
 * How long a swept job's id stays in the tombstone set. After this window
 * any straggler "added" / "updated" event from main is treated as legitimate
 * again. 30s is enough to cover post-completion progress flushes, multi-
 * window broadcast races, and slow HMR-leaked listeners without causing
 * confusion if the user genuinely re-uploads the same id (they can't —
 * ids are random UUIDs minted in main, and a removed id is never reused).
 */
const TOMBSTONE_TTL_MS = 30_000;

type SpeedSample = { t: number; bytes: number };

type State = {
  jobs: Job[];
  initialized: boolean;
  unsubscribe: (() => void) | null;
  /** Rolling per-job byte samples for speed calculation (not reactive). */
  samples: Map<string, SpeedSample[]>;
  /**
   * Job ids that the renderer has positively decided are gone — either because
   * the user removed them, auto-clear swept them, or main emitted a `removed`
   * event. Any `added` / `updated` event arriving for an id in this set is
   * dropped, which is the only reliable way to kill "ghost rows" caused by
   * late events arriving after an optimistic local sweep.
   *
   * Stored as `id → expiresAt` so entries can self-evict; anything older than
   * {@link TOMBSTONE_TTL_MS} is treated as if it isn't there.
   */
  tombstones: Map<string, number>;
  /** Max parallel transfers, mirrored from the main-process engine. The
   *  authoritative copy lives in main; this is just the latest value the
   *  renderer was told about, used to render the toolbar stepper. */
  concurrency: number;
};

export const useQueueStore = defineStore("queue", {
  state: (): State => ({
    jobs: [],
    initialized: false,
    unsubscribe: null,
    samples: new Map(),
    tombstones: new Map(),
    concurrency: DEFAULT_CONCURRENCY,
  }),
  getters: {
    stats(state): {
      active: number;
      queued: number;
      completed: number;
      failed: number;
      paused: number;
      cancelled: number;
      total: number;
    } {
      let active = 0;
      let queued = 0;
      let completed = 0;
      let failed = 0;
      let paused = 0;
      let cancelled = 0;
      for (const j of state.jobs) {
        switch (j.status) {
          case "running":
            active++;
            break;
          case "queued":
            queued++;
            break;
          case "completed":
            completed++;
            break;
          case "failed":
            failed++;
            break;
          case "paused":
            paused++;
            break;
          case "cancelled":
            cancelled++;
            break;
        }
      }
      return {
        active,
        queued,
        completed,
        failed,
        paused,
        cancelled,
        total: state.jobs.length,
      };
    },
    overallBytesPerSecond(state): number {
      let total = 0;
      const now = Date.now();
      for (const samples of state.samples.values()) {
        const fresh = samples.filter((s) => now - s.t <= SPEED_WINDOW_MS);
        if (fresh.length < 2) continue;
        const first = fresh[0];
        const last = fresh[fresh.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt <= 0) continue;
        const dBytes = Math.max(0, last.bytes - first.bytes);
        total += dBytes / dt;
      }
      return total;
    },
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return;
      this.initialized = true;
      const r = await window.api.transfer.list();
      if (r.ok) {
        this.jobs = r.data;
        for (const j of r.data) this.recordSample(j);
      }
      const c = await window.api.transfer.getConcurrency();
      if (c.ok) this.concurrency = c.data.global;
      this.unsubscribe = window.api.transfer.onEvent((e) => this.applyEvent(e));
    },
    teardown(): void {
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
      this.initialized = false;
      this.samples.clear();
    },
    applyEvent(e: TransferEvent): void {
      switch (e.type) {
        case "added": {
          // Dedupe by id. Duplicate "added" events can fire when the main
          // process broadcasts to multiple windows that each maintain their
          // own copy, or when an HMR-leaked listener coexists with a fresh
          // subscription. Without this guard the queue panel shows ghost
          // rows that look like a "reset" of the previous transfer.
          const idx = this.jobs.findIndex((j) => j.id === e.job.id);
          if (idx === -1) {
            this.jobs = [...this.jobs, e.job];
          } else {
            const next = this.jobs.slice();
            next[idx] = e.job;
            this.jobs = next;
          }
          this.recordSample(e.job);
          break;
        }
        case "updated": {
          const idx = this.jobs.findIndex((j) => j.id === e.job.id);
          if (idx === -1) {
            this.jobs = [...this.jobs, e.job];
          } else {
            const next = this.jobs.slice();
            next[idx] = e.job;
            this.jobs = next;
          }
          this.recordSample(e.job);
          break;
        }
        case "removed":
          this.jobs = this.jobs.filter((j) => j.id !== e.id);
          this.samples.delete(e.id);
          break;
        case "snapshot":
          this.jobs = e.jobs;
          this.samples.clear();
          for (const j of e.jobs) this.recordSample(j);
          break;
        case "reordered": {
          // Re-sort the existing jobs to match the new canonical order
          // without touching speed samples — speed should not visibly
          // stutter just because the user dragged a queued row around.
          const rank = new Map<string, number>();
          e.orderedIds.forEach((id, i) => rank.set(id, i));
          const TAIL = e.orderedIds.length;
          this.jobs = [...this.jobs].sort(
            (a, b) => (rank.get(a.id) ?? TAIL) - (rank.get(b.id) ?? TAIL),
          );
          break;
        }
      }
    },
    recordSample(job: Job): void {
      if (job.status !== "running") {
        this.samples.delete(job.id);
        return;
      }
      const samples = this.samples.get(job.id) ?? [];
      const now = Date.now();
      samples.push({ t: now, bytes: job.transferred });
      // Trim samples older than window.
      const cutoff = now - SPEED_WINDOW_MS;
      while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
      this.samples.set(job.id, samples);
    },
    async enqueue(jobs: JobInput[]): Promise<Job[]> {
      if (!jobs.length) return [];
      const r = await window.api.transfer.enqueue(jobs);
      return r.ok ? r.data : [];
    },
    async pause(id: string): Promise<void> {
      await window.api.transfer.pause(id);
    },
    async resume(id: string): Promise<void> {
      await window.api.transfer.resume(id);
    },
    async cancel(id: string): Promise<void> {
      await window.api.transfer.cancel(id);
    },
    async pauseAll(): Promise<void> {
      await window.api.transfer.pauseAll();
    },
    async resumeAll(): Promise<void> {
      await window.api.transfer.resumeAll();
    },
    async clearCompleted(): Promise<void> {
      // Optimistic local sweep so the UI feels instant. The main process
      // will re-broadcast a `removed` for each cleared job, which is a
      // no-op on the array filter below.
      const sweep = (s: Job["status"]): boolean =>
        s === "completed" || s === "cancelled";
      for (const j of this.jobs) {
        if (sweep(j.status)) this.samples.delete(j.id);
      }
      this.jobs = this.jobs.filter((j) => !sweep(j.status));
      await window.api.transfer.clearCompleted();
    },
    /** Optimistically reorder locally for snappy drag UX, then sync to main.
     *  The `reordered` event will arrive shortly and confirm the order. */
    async reorder(orderedIds: string[]): Promise<void> {
      const rank = new Map<string, number>();
      orderedIds.forEach((id, i) => rank.set(id, i));
      const TAIL = orderedIds.length;
      this.jobs = [...this.jobs].sort(
        (a, b) => (rank.get(a.id) ?? TAIL) - (rank.get(b.id) ?? TAIL),
      );
      await window.api.transfer.reorder(orderedIds);
    },
    /** Update the engine's max parallel transfers. We mirror the value
     *  optimistically so the toolbar stepper feels instantaneous, then sync
     *  to main and reconcile with whatever main clamped to. We push BOTH
     *  global and perSession to the same value because users think in
     *  "files at once", not in protocol-level cap distinctions. */
    async setConcurrency(n: number): Promise<void> {
      const clamped = Math.max(
        MIN_CONCURRENCY,
        Math.min(MAX_CONCURRENCY, Math.floor(n)),
      );
      if (clamped === this.concurrency) return;
      this.concurrency = clamped;
      const r = await window.api.transfer.setConcurrency({
        global: clamped,
        perSession: clamped,
      });
      if (r.ok) this.concurrency = r.data.global;
    },
    async remove(id: string): Promise<void> {
      // Optimistically drop the row. If the job lives only in the renderer
      // (a ghost from a missed event), this is the only way the row ever
      // disappears — the main process can't emit a `removed` for an id it
      // doesn't know about. If the job IS still in main, the `removed`
      // event will arrive shortly and re-apply the same filter (idempotent).
      this.jobs = this.jobs.filter((j) => j.id !== id);
      this.samples.delete(id);
      await window.api.transfer.remove(id);
    },
  },
});
