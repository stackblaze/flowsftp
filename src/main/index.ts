import { app, BrowserWindow, nativeImage } from "electron";
import { join } from "path";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { SftpManager } from "./sftp/sftp-manager";
import { registerFlowSftpIpc } from "./ipc/flowsftp-ipc";
import { registerFsOpsIpc } from "./ipc/fs-ops-ipc";
import { registerSftpOpsIpc } from "./ipc/sftp-ops-ipc";
import { registerSessionsIpc } from "./sessions/sessions-ipc";
import { registerTransferIpc } from "./ipc/transfer-ipc";
import { SessionsStore } from "./sessions/sessions-store";
import { JobStore } from "./transfer/job-store";
import { TransferQueue } from "./transfer/queue";
import { TransferEngine } from "./transfer/engine";
import { APP_ICON_PATH, createMainWindow } from "./window-manager";
import { setAppMenu } from "./app-menu";
import { TrayManager } from "./tray-manager";
import { UpdateManager } from "./update-manager";
import { registerUpdateIpc } from "./ipc/update-ipc";

const sftpManager = new SftpManager();

// The queue is constructed lazily inside `app.whenReady()` because
// `app.getPath("userData")` is only safe to call after the `ready` event,
// and the JobStore needs that path to locate its on-disk JSON file.
let transferQueue: TransferQueue;
let transferEngine: TransferEngine;
let trayManager: TrayManager | null = null;
let updateManager: UpdateManager | null = null;

function openWindow(): void {
  createMainWindow(sftpManager);
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.flowsftp.app");

  /* In dev, the macOS dock shows the bundled Electron icon (the atom)
   * because the app isn't packaged yet. `app.dock.setIcon()` overrides
   * it at runtime so the developer sees the real FlowSFTP brand. In
   * production the .icns from electron-builder takes over and this is
   * a harmless no-op. */
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
    } catch {
      /* Non-fatal — the worst case is the dock keeps showing the
       * Electron atom in dev. */
    }
  }

  const sessionsStore = new SessionsStore();

  // Persistence file lives in the OS-standard userData dir
  // (~/Library/Application Support/<appname>/queue.json on macOS, etc.) so
  // it survives reinstalls and isn't tangled up with the bundled app.
  const jobStore = new JobStore(join(app.getPath("userData"), "queue.json"));
  transferQueue = new TransferQueue(jobStore);
  transferEngine = new TransferEngine(transferQueue, sftpManager);

  updateManager = new UpdateManager();

  registerFlowSftpIpc(sftpManager, openWindow);
  registerSessionsIpc(sessionsStore);
  registerTransferIpc(transferEngine, transferQueue);
  registerFsOpsIpc();
  registerSftpOpsIpc(sftpManager);
  registerUpdateIpc(updateManager);
  setAppMenu(openWindow, () => {
    void updateManager?.check();
  });

  trayManager = new TrayManager(transferQueue, transferEngine, openWindow);
  trayManager.start();

  openWindow();
  // Kick off auto-update wiring after the first window exists so the
  // initial state event has somewhere to land.
  updateManager.start();

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("before-quit", async () => {
  updateManager?.destroy();
  updateManager = null;
  trayManager?.destroy();
  trayManager = null;
  transferEngine?.stop();
  // Drain any throttled progress writes so the on-disk transferred-bytes
  // match the last value the user saw on screen, then close the SQLite
  // handle cleanly to release the WAL files.
  transferEngine && transferQueue?.close();
  await sftpManager.disconnectAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
