/**
 * IPC surface for the renderer-driven update UI.
 *
 * The renderer never talks to `electron-updater` directly — it only sees
 * the `UpdateState` produced by `UpdateManager`. Three verbs cover the
 * entire flow:
 *
 *   - `getState`: synchronous-feeling snapshot, used right after the
 *     dialog mounts so it doesn't have to wait for the next push.
 *   - `check`/`download`/`install`: drive the state machine forward.
 *   - `setAutoDownload`: lets the renderer reflect a user preference into
 *     the manager (e.g. for users on metered connections).
 *
 * The state push channel (`flowsftp:update:event`) is wired in `UpdateManager`
 * directly so every renderer (multi-window) gets the same view.
 */

import { ipcMain } from "electron";
import type { Result, UpdateState } from "../../shared/types";
import type { UpdateManager } from "../update-manager";

export function registerUpdateIpc(updater: UpdateManager): void {
  ipcMain.removeHandler("flowsftp:update:getState");
  ipcMain.handle("flowsftp:update:getState", (): Result<UpdateState> => {
    return { ok: true, data: updater.getState() };
  });

  ipcMain.removeHandler("flowsftp:update:check");
  ipcMain.handle(
    "flowsftp:update:check",
    async (): Promise<Result<UpdateState>> => {
      const state = await updater.check();
      return { ok: true, data: state };
    },
  );

  ipcMain.removeHandler("flowsftp:update:download");
  ipcMain.handle(
    "flowsftp:update:download",
    async (): Promise<Result<UpdateState>> => {
      const state = await updater.download();
      return { ok: true, data: state };
    },
  );

  ipcMain.removeHandler("flowsftp:update:install");
  ipcMain.handle("flowsftp:update:install", (): Result<UpdateState> => {
    const state = updater.install();
    return { ok: true, data: state };
  });

  ipcMain.removeHandler("flowsftp:update:setAutoDownload");
  ipcMain.handle(
    "flowsftp:update:setAutoDownload",
    (_e, raw: unknown): Result<void> => {
      const value =
        typeof raw === "boolean"
          ? raw
          : typeof raw === "object" && raw && "value" in raw
            ? Boolean((raw as { value: unknown }).value)
            : null;
      if (value === null) {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "value (boolean) required" },
        };
      }
      updater.setAutoDownload(value);
      return { ok: true, data: undefined };
    },
  );
}
