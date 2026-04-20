import { describe, expect, it, vi } from "vitest";
import { TransferQueue } from "../../src/main/transfer/queue";
import type { JobInput, TransferEvent } from "../../src/shared/types";
// Renderer store imports — included so that any type/regression in the
// stores breaks this test (they are otherwise untouched by the frontend
// agent's vue file rewrites).
import { useSessionsStore } from "../../src/renderer/src/stores/sessions";
import { useQueueStore } from "../../src/renderer/src/stores/queue";
import { useTabsStore } from "../../src/renderer/src/stores/tabs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONN_ID = "11111111-1111-4111-8111-111111111111";

function input(over: Partial<JobInput> = {}): JobInput {
  return {
    connectionId: CONN_ID,
    kind: "upload",
    src: "/local/file.bin",
    dst: "/remote/file.bin",
    size: 1024,
    priority: "normal",
    ...over,
  };
}

describe("TransferQueue.enqueue", () => {
  it("creates a job with status='queued' and a uuid id", () => {
    const q = new TransferQueue();
    const job = q.enqueue(input());

    expect(job.status).toBe("queued");
    expect(job.id).toMatch(UUID_RE);
    expect(job.transferred).toBe(0);
    expect(job.attempt).toBe(0);
    expect(job.size).toBe(1024);
    expect(job.connectionId).toBe(CONN_ID);
    expect(job.priority).toBe("normal");
  });

  it("emits 'added' for a new job", () => {
    const q = new TransferQueue();
    const events: TransferEvent[] = [];
    q.on((e) => events.push(e));

    const job = q.enqueue(input());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("added");
    if (events[0].type === "added") {
      expect(events[0].job.id).toBe(job.id);
    }
  });
});

describe("TransferQueue.pause / resume / cancel", () => {
  it("pause moves a running job to 'paused' and emits 'updated'", () => {
    const q = new TransferQueue();
    const job = q.enqueue(input());
    q.update(job.id, { status: "running" });

    const events: TransferEvent[] = [];
    q.on((e) => events.push(e));

    q.pause(job.id);

    const after = q.get(job.id);
    expect(after?.status).toBe("paused");
    expect(events.some((e) => e.type === "updated")).toBe(true);
  });

  it("resume moves a paused job back to 'queued' and clears error", () => {
    const q = new TransferQueue();
    const job = q.enqueue(input());
    q.update(job.id, { status: "paused", error: "boom" });

    q.resume(job.id);
    const after = q.get(job.id);
    expect(after?.status).toBe("queued");
    expect(after?.error).toBeUndefined();
  });

  it("cancel sets status='cancelled' and stamps finishedAt", () => {
    const q = new TransferQueue();
    const job = q.enqueue(input());
    q.update(job.id, { status: "running" });

    q.cancel(job.id);
    const after = q.get(job.id);
    expect(after?.status).toBe("cancelled");
    expect(typeof after?.finishedAt).toBe("number");
  });

  it("pause is a no-op for completed/cancelled jobs", () => {
    const q = new TransferQueue();
    // Distinct src/dst so the enqueue() dedupe doesn't collapse them.
    const a = q.enqueue(input({ src: "/local/a", dst: "/remote/a" }));
    const b = q.enqueue(input({ src: "/local/b", dst: "/remote/b" }));
    q.update(a.id, { status: "completed" });
    q.update(b.id, { status: "cancelled" });

    q.pause(a.id);
    q.pause(b.id);

    expect(q.get(a.id)?.status).toBe("completed");
    expect(q.get(b.id)?.status).toBe("cancelled");
  });
});

describe("TransferQueue.clearCompleted", () => {
  it("removes completed and cancelled jobs but preserves running/queued/paused", () => {
    const q = new TransferQueue();
    const queued = q.enqueue(input({ src: "/q" }));
    const running = q.enqueue(input({ src: "/r" }));
    const paused = q.enqueue(input({ src: "/p" }));
    const done = q.enqueue(input({ src: "/d" }));
    const cancelled = q.enqueue(input({ src: "/c" }));

    q.update(running.id, { status: "running" });
    q.update(paused.id, { status: "paused" });
    q.update(done.id, { status: "completed" });
    q.update(cancelled.id, { status: "cancelled" });

    const removed: string[] = [];
    q.on((e) => {
      if (e.type === "removed") removed.push(e.id);
    });

    q.clearCompleted();

    const ids = q.list().map((j) => j.id).sort();
    expect(ids).toEqual([queued.id, running.id, paused.id].sort());
    expect(removed.sort()).toEqual([done.id, cancelled.id].sort());
  });
});

describe("TransferQueue events", () => {
  it("emits 'updated' on update and unsubscribes cleanly", () => {
    const q = new TransferQueue();
    const job = q.enqueue(input());
    const listener = vi.fn();
    const off = q.on(listener);

    q.update(job.id, { transferred: 512 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      type: "updated",
      job: { id: job.id, transferred: 512 },
    });

    off();
    q.update(job.id, { transferred: 1024 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("emits 'snapshot' on demand", () => {
    const q = new TransferQueue();
    q.enqueue(input({ src: "/a" }));
    q.enqueue(input({ src: "/b" }));
    const events: TransferEvent[] = [];
    q.on((e) => events.push(e));

    q.emitSnapshot();
    const snap = events.find((e) => e.type === "snapshot");
    expect(snap).toBeTruthy();
    if (snap?.type === "snapshot") {
      expect(snap.jobs).toHaveLength(2);
    }
  });

  it("listener errors do not break subsequent listeners", () => {
    const q = new TransferQueue();
    const bad = vi.fn(() => {
      throw new Error("nope");
    });
    const good = vi.fn();
    q.on(bad);
    q.on(good);
    q.enqueue(input());
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});

describe("renderer stores typecheck imports", () => {
  it("imports cleanly", () => {
    expect(typeof useSessionsStore).toBe("function");
    expect(typeof useQueueStore).toBe("function");
    expect(typeof useTabsStore).toBe("function");
  });
});
