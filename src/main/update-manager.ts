/**
 * Software update orchestration for FlowSFTP.
 *
 * Wraps `electron-updater` so the renderer can drive a clean state-machine
 * UI without knowing about the underlying autoUpdater event soup. The
 * manager:
 *
 *   - Owns a single `UpdateState` value, persisted in memory and broadcast
 *     to every renderer whenever it changes.
 *   - Exposes three verbs (`check`, `download`, `install`) that map to the
 *     buttons users actually press.
 *   - Auto-checks at startup (after a small delay so the first paint is
 *     snappy) and again on a daily timer.
 *   - Auto-downloads available updates by default — most users want the
 *     install to be ready when they're prompted.
 *
 * Provider configuration lives in `electron-builder.yml`'s `publish` block
 * (or `dev-app-update.yml` during local development), so this module is
 * provider-agnostic. Whether the bundled app fetches from GitHub Releases,
 * a generic HTTPS bucket, or S3 is purely a packaging decision.
 *
 * macOS caveat: code-signed builds get atomic in-place updates via
 * Squirrel.Mac. Unsigned dev builds will succeed at the download step but
 * `quitAndInstall()` won't actually replace the app. The renderer surfaces
 * a clear error in that case.
 */

import { app, BrowserWindow } from "electron";
import { is } from "@electron-toolkit/utils";
import log from "electron-log";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import type { UpdateState } from "../shared/types";

const UPDATE_EVENT_CH = "flowsftp:update:event";

/** Re-check interval when the app stays open for long stretches. */
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Brief delay before the first check so app start isn't competing with
 *  the network for resources. */
const STARTUP_CHECK_DELAY_MS = 8_000;

export class UpdateManager {
  private state: UpdateState;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private autoDownload = true;
  private listenersWired = false;

  constructor() {
    this.state = { status: "idle", currentVersion: app.getVersion() };
  }

  /** Wire autoUpdater + electron-log, kick off the first check. Safe to
   *  call multiple times — only the first call has effects. */
  start(): void {
    if (this.listenersWired) return;
    this.listenersWired = true;

    /* Pipe autoUpdater logs into electron-log so users can grep
     * ~/Library/Logs/<appname>/main.log when something goes wrong with
     * a release pipeline. transports.file.level controls verbosity. */
    log.transports.file.level = "info";
    autoUpdater.logger = log;
    autoUpdater.autoDownload = this.autoDownload;
    /* We surface the install via our own UI prompt — never auto-install on
     * quit, otherwise users would see a slow restart with no explanation. */
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => {
      this.setState({
        status: "checking",
        currentVersion: app.getVersion(),
      });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.setState({
        status: "available",
        currentVersion: app.getVersion(),
        version: info.version,
        releaseDate:
          typeof info.releaseDate === "string" ? info.releaseDate : undefined,
        releaseNotes:
          typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
        autoDownloading: this.autoDownload,
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.setState({
        status: "not-available",
        currentVersion: app.getVersion(),
        checkedAt: Date.now(),
      });
    });
    autoUpdater.on("download-progress", (p: ProgressInfo) => {
      this.setState({
        status: "downloading",
        currentVersion: app.getVersion(),
        version:
          this.state.status === "downloading" ||
          this.state.status === "available"
            ? this.state.version
            : "",
        percent: Math.round(p.percent),
        bytesPerSecond: Math.round(p.bytesPerSecond),
        transferred: p.transferred,
        total: p.total,
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
      this.setState({
        status: "downloaded",
        currentVersion: app.getVersion(),
        version: info.version,
        releaseNotes:
          typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
      });
    });
    autoUpdater.on("error", (err) => {
      this.setState({
        status: "error",
        currentVersion: app.getVersion(),
        message: err?.message ?? String(err),
      });
    });

    /* In dev mode without a `dev-app-update.yml` electron-updater throws
     * when asked to check. Detect and surface a clear "dev-disabled" state
     * instead of letting the renderer see a confusing error toast. */
    if (is.dev) {
      try {
        // Reading the property triggers config-file resolution; a missing
        // file throws synchronously. This is the cheapest way to detect
        // the "no dev config" case without actually firing a check.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        autoUpdater.currentVersion;
      } catch (e) {
        log.warn("[update] disabled in dev:", (e as Error).message);
        this.setState({
          status: "dev-disabled",
          currentVersion: app.getVersion(),
        });
        return;
      }
    }

    this.scheduleStartupCheck();
    this.schedulePeriodicChecks();
  }

  destroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.startupTimer = null;
    this.periodicTimer = null;
    autoUpdater.removeAllListeners();
    this.listenersWired = false;
  }

  /** Snapshot of the current state — used when a renderer asks "what's
   *  going on right now?" without waiting for the next event. */
  getState(): UpdateState {
    return this.state;
  }

  /** Trigger an update check. No-op when running in dev without config. */
  async check(): Promise<UpdateState> {
    if (this.state.status === "dev-disabled") return this.state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.setState({
        status: "error",
        currentVersion: app.getVersion(),
        message: (err as Error).message ?? String(err),
      });
    }
    return this.state;
  }

  /** Manually start a download (used when autoDownload is off, or the user
   *  declined and changed their mind). */
  async download(): Promise<UpdateState> {
    if (this.state.status !== "available" && this.state.status !== "error") {
      return this.state;
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.setState({
        status: "error",
        currentVersion: app.getVersion(),
        message: (err as Error).message ?? String(err),
      });
    }
    return this.state;
  }

  /** Quit and install. Fires a final state event so the dialog can show
   *  "Restarting…" before windows close. */
  install(): UpdateState {
    if (this.state.status !== "downloaded") return this.state;
    /* `isSilent: false` shows the squirrel installer UI on Windows; users
     * see the install actually happening rather than a frozen-looking
     * window. `isForceRunAfter: true` re-launches FlowSFTP cleanly. */
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        this.setState({
          status: "error",
          currentVersion: app.getVersion(),
          message: (err as Error).message ?? String(err),
        });
      }
    });
    return this.state;
  }

  /** Toggle auto-download. Off lets the user explicitly opt-in to the
   *  download (useful on metered connections). */
  setAutoDownload(value: boolean): void {
    this.autoDownload = value;
    autoUpdater.autoDownload = value;
  }

  private scheduleStartupCheck(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.check();
    }, STARTUP_CHECK_DELAY_MS);
  }

  private schedulePeriodicChecks(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = setInterval(() => {
      void this.check();
    }, PERIODIC_CHECK_MS);
  }

  private setState(next: UpdateState): void {
    this.state = next;
    /* Broadcast to every renderer (multi-window): they all share one
     * update state. The renderer composable filters duplicates by status
     * timestamp if needed. */
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      try {
        w.webContents.send(UPDATE_EVENT_CH, { state: next });
      } catch {
        /* Renderer might be navigating; safe to drop the event — the
         * renderer can call `getState` after load to reconcile. */
      }
    }
  }
}

export const UPDATE_EVENT_CHANNEL = UPDATE_EVENT_CH;
