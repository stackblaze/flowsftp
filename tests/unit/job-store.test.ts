import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/main/transfer/job-store";
import { TransferQueue } from "../../src/main/transfer/queue";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "synctron-jobstore-"));
  dbPath = join(tmpDir, "queue.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("JobStore", () => {
  it("survives close/reopen and rehydrates jobs in order", () => {
    {
      const store = new JobStore(dbPath);
      const q = new TransferQueue(store);
      q.enqueue({
        connectionId: "c1",
        kind: "upload",
        src: "/a/1",
        dst: "/r/1",
        size: 10,
      });
      q.enqueue({
        connectionId: "c1",
        kind: "upload",
        src: "/a/2",
        dst: "/r/2",
        size: 20,
      });
      q.enqueue({
        connectionId: "c1",
        kind: "upload",
        src: "/a/3",
        dst: "/r/3",
        size: 30,
      });
      q.close();
    }

    const store2 = new JobStore(dbPath);
    const q2 = new TransferQueue(store2);
    const list = q2.list();
    expect(list.map((j) => j.src)).toEqual(["/a/1", "/a/2", "/a/3"]);
    expect(list.every((j) => j.status === "queued")).toBe(true);
    q2.close();
  });

  it("resets orphaned 'running' jobs to 'queued' on hydrate", () => {
    {
      const store = new JobStore(dbPath);
      const q = new TransferQueue(store);
      const j = q.enqueue({
        connectionId: "c1",
        kind: "upload",
        src: "/a/1",
        dst: "/r/1",
        size: 100,
      });
      // Simulate a transfer that was mid-flight when the app died.
      q.update(j.id, { status: "running", transferred: 42, startedAt: 123 });
      q.close();
    }

    const q2 = new TransferQueue(new JobStore(dbPath));
    const [hydrated] = q2.list();
    expect(hydrated.status).toBe("queued");
    expect(hydrated.transferred).toBe(42);
    expect(hydrated.startedAt).toBe(123);
    q2.close();
  });

  it("removes deleted jobs from disk", () => {
    const store = new JobStore(dbPath);
    const q = new TransferQueue(store);
    const a = q.enqueue({
      connectionId: "c1",
      kind: "upload",
      src: "/a",
      dst: "/r/a",
      size: 1,
    });
    const b = q.enqueue({
      connectionId: "c1",
      kind: "upload",
      src: "/b",
      dst: "/r/b",
      size: 1,
    });
    q.remove(a.id);
    q.close();

    const q2 = new TransferQueue(new JobStore(dbPath));
    const ids = q2.list().map((j) => j.id);
    expect(ids).toEqual([b.id]);
    q2.close();
  });

  it("persists reorder across restart", () => {
    const store = new JobStore(dbPath);
    const q = new TransferQueue(store);
    const a = q.enqueue({
      connectionId: "c1",
      kind: "upload",
      src: "/a",
      dst: "/r/a",
      size: 1,
    });
    const b = q.enqueue({
      connectionId: "c1",
      kind: "upload",
      src: "/b",
      dst: "/r/b",
      size: 1,
    });
    const c = q.enqueue({
      connectionId: "c1",
      kind: "upload",
      src: "/c",
      dst: "/r/c",
      size: 1,
    });
    q.reorder([c.id, a.id, b.id]);
    q.close();

    const q2 = new TransferQueue(new JobStore(dbPath));
    expect(q2.list().map((j) => j.src)).toEqual(["/c", "/a", "/b"]);
    q2.close();
  });

  it("flushes throttled progress writes on close", () => {
    {
      const store = new JobStore(dbPath);
      const q = new TransferQueue(store);
      const j = q.enqueue({
        connectionId: "c1",
        kind: "upload",
        src: "/a",
        dst: "/r/a",
        size: 1000,
      });
      // First progress write goes through (no last-persist timestamp);
      // subsequent ones land in the deferred set until flush.
      q.update(j.id, { transferred: 100 });
      q.update(j.id, { transferred: 500 });
      q.update(j.id, { transferred: 900 });
      q.close();
    }

    const q2 = new TransferQueue(new JobStore(dbPath));
    expect(q2.list()[0].transferred).toBe(900);
    q2.close();
  });
});
