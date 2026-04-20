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

const EVENT_CHANNEL = "flowsftp:transfer:event";

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

  ipcMain.removeHandler("flowsftp:transfer:list");
  ipcMain.handle("flowsftp:transfer:list", (): Result<Job[]> => {
    return { ok: true, data: queue.list() };
  });

  ipcMain.removeHandler("flowsftp:transfer:enqueue");
  ipcMain.handle(
    "flowsftp:transfer:enqueue",
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

  ipcMain.removeHandler("flowsftp:transfer:pause");
  ipcMain.handle("flowsftp:transfer:pause", (_e, raw: unknown): Result<void> => {
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

  ipcMain.removeHandler("flowsftp:transfer:resume");
  ipcMain.handle("flowsftp:transfer:resume", (_e, raw: unknown): Result<void> => {
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

  ipcMain.removeHandler("flowsftp:transfer:cancel");
  ipcMain.handle("flowsftp:transfer:cancel", (_e, raw: unknown): Result<void> => {
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

  ipcMain.removeHandler("flowsftp:transfer:pauseAll");
  ipcMain.handle("flowsftp:transfer:pauseAll", (): Result<void> => {
    engine.pauseAll();
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("flowsftp:transfer:resumeAll");
  ipcMain.handle("flowsftp:transfer:resumeAll", (): Result<void> => {
    engine.resumeAll();
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("flowsftp:transfer:clearCompleted");
  ipcMain.handle("flowsftp:transfer:clearCompleted", (): Result<void> => {
    engine.clearCompleted();
    return { ok: true, data: undefined };
  });

  ipcMain.removeHandler("flowsftp:transfer:reorder");
  ipcMain.handle(
    "flowsftp:transfer:reorder",
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

  ipcMain.removeHandler("flowsftp:transfer:remove");
  ipcMain.handle("flowsftp:transfer:remove", (_e, raw: unknown): Result<void> => {
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

  ipcMain.removeHandler("flowsftp:transfer:getConcurrency");
  ipcMain.handle(
    "flowsftp:transfer:getConcurrency",
    (): Result<{ global: number; perSession: number }> => {
      return { ok: true, data: engine.getConcurrency() };
    },
  );

  ipcMain.removeHandler("flowsftp:transfer:setConcurrency");
  ipcMain.handle(
    "flowsftp:transfer:setConcurrency",
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
