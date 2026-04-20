import { BrowserWindow, ipcMain } from "electron";
import {
  concurrencySchema,
  enqueueJobsSchema,
  jobIdSchema,
  reorderJobsSchema,
} from "../../shared/schemas";
import type { Job, Result, TransferEvent } from "../../shared/types";
import type { TransferEngine } from "../transfer/engine";
import type { TransferQueue } from "../transfer/queue";

const EVENT_CHANNEL = "synctron:transfer:event";

function validationMessage(err: {
  issues: readonly { message: string }[];
}): string {
  return err.issues[0]?.message ?? "Invalid input";
}

function broadcast(event: TransferEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    wc.send(EVENT_CHANNEL, event);
  }
}

export function registerTransferIpc(
  engine: TransferEngine,
  queue: TransferQueue,
): void {
  queue.on(broadcast);

  ipcMain.removeHandler("synctron:transfer:list");
  ipcMain.handle("synctron:transfer:list", (): Result<Job[]> => {
    return { ok: true, data: queue.list() };
  });

  ipcMain.removeHandler("synctron:transfer:enqueue");
  ipcMain.handle(
    "synctron:transfer:enqueue",
    (_e, raw: unknown): Result<Job[]> => {
      const parsed = enqueueJobsSchema.safeParse(raw);
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
      const created = parsed.data.jobs.map((j) => queue.enqueue(j));
      return { ok: true, data: created };
    },
  );

  ipcMain.removeHandler("synctron:transfer:pause");
  ipcMain.handle("synctron:transfer:pause", (_e, raw: unknown): Result<void> => {
    const parsed = jobIdSchema.safeParse(raw);
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
    engine.pause(parsed.data.id);
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:resume");
  ipcMain.handle("synctron:transfer:resume", (_e, raw: unknown): Result<void> => {
    const parsed = jobIdSchema.safeParse(raw);
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
    engine.resume(parsed.data.id);
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:cancel");
  ipcMain.handle("synctron:transfer:cancel", (_e, raw: unknown): Result<void> => {
    const parsed = jobIdSchema.safeParse(raw);
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
    engine.cancel(parsed.data.id);
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:pauseAll");
  ipcMain.handle("synctron:transfer:pauseAll", (): Result<void> => {
    engine.pauseAll();
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:resumeAll");
  ipcMain.handle("synctron:transfer:resumeAll", (): Result<void> => {
    engine.resumeAll();
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:clearCompleted");
  ipcMain.handle("synctron:transfer:clearCompleted", (): Result<void> => {
    engine.clearCompleted();
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:reorder");
  ipcMain.handle(
    "synctron:transfer:reorder",
    (_e, raw: unknown): Result<void> => {
      const parsed = reorderJobsSchema.safeParse(raw);
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
      engine.reorder(parsed.data.orderedIds);
      return { ok: true, data: undefined };
    },
  );

  ipcMain.removeHandler("synctron:transfer:remove");
  ipcMain.handle("synctron:transfer:remove", (_e, raw: unknown): Result<void> => {
    const parsed = jobIdSchema.safeParse(raw);
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
    engine.removeJob(parsed.data.id);
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("synctron:transfer:getConcurrency");
  ipcMain.handle(
    "synctron:transfer:getConcurrency",
    (): Result<{ global: number; perSession: number }> => {
      return { ok: true, data: engine.getConcurrency() };
    },
  );

  ipcMain.removeHandler("synctron:transfer:setConcurrency");
  ipcMain.handle(
    "synctron:transfer:setConcurrency",
    (_e, raw: unknown): Result<{ global: number; perSession: number }> => {
      const parsed = concurrencySchema.safeParse(raw);
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
      const next = engine.setConcurrency(parsed.data);
      return { ok: true, data: next };
    },
  );
}
