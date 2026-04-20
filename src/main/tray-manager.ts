import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
// macOS template icons must be mostly-black with an alpha channel — the menu
// bar then tints them automatically for light/dark mode. We ship a 22pt
// glyph with a 2x retina variant; Electron picks @2x by suffix convention.
import macTrayIcon from "../../resources/tray-iconTemplate.png?asset";
import macTrayIcon2x from "../../resources/tray-iconTemplate@2x.png?asset";
import winTrayIcon from "../../resources/tray-icon.png?asset";
import type { TransferEngine } from "./transfer/engine";
import type { TransferQueue } from "./transfer/queue";
import type { Job } from "../shared/types";

type Stats = {
  running: number;
  queued: number;
  paused: number;
  completed: number;
  failed: number;
  active: number;
  total: number;
};

function computeStats(jobs: readonly Job[]): Stats {
  let running = 0;
  let queued = 0;
  let paused = 0;
  let completed = 0;
  let failed = 0;
  for (const j of jobs) {
    if (j.status === "running") running++;
    else if (j.status === "queued") queued++;
    else if (j.status === "paused") paused++;
    else if (j.status === "completed") completed++;
    else if (j.status === "failed") failed++;
  }
  return {
    running,
    queued,
    paused,
    completed,
    failed,
    active: running + queued + paused,
    total: jobs.length,
  };
}

function summarize(s: Stats): string {
  if (s.active === 0 && s.total === 0) return "No transfers";
  const parts: string[] = [];
  if (s.running) parts.push(`${s.running} running`);
  if (s.queued) parts.push(`${s.queued} queued`);
  if (s.paused) parts.push(`${s.paused} paused`);
  if (s.failed) parts.push(`${s.failed} failed`);
  if (parts.length === 0 && s.completed) {
    return `${s.completed} completed`;
  }
  return parts.join(" · ") || "Idle";
}

/**
 * Creates a system-tray (menu-bar) icon for FlowSFTP so the user can
 * minimize the main window during long transfers and still see/control the
 * queue. The tray menu shows a live summary of running/queued/paused jobs and
 * exposes Pause/Resume All + Quit. Click (Win/Linux) restores the window;
 * macOS shows the context menu on click as is conventional.
 */
export class TrayManager {
  private tray: Tray | null = null;
  private unsubscribe: (() => void) | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private lastJobs: readonly Job[] = [];

  constructor(
    private readonly queue: TransferQueue,
    private readonly engine: TransferEngine,
    private readonly openWindow: () => void,
  ) {}

  start(): void {
    if (this.tray) return;

    const isMac = process.platform === "darwin";
    let image: Electron.NativeImage;
    if (isMac) {
      image = nativeImage.createFromPath(macTrayIcon);
      // Attach the retina variant explicitly. (Electron also picks up the
      // `@2x` suffix automatically when both files sit next to each other,
      // but `?asset` may emit them into different output paths in dev.)
      const hi = nativeImage.createFromPath(macTrayIcon2x);
      if (!hi.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
      image.setTemplateImage(true);
    } else {
      image = nativeImage.createFromPath(winTrayIcon);
    }

    this.tray = new Tray(image);
    this.tray.setToolTip("FlowSFTP");

    if (!isMac) {
      // On Windows/Linux, single-clicking the tray icon should restore the
      // app. macOS users expect the context menu, so we skip there.
      this.tray.on("click", () => this.showWindow());
    }

    this.lastJobs = this.queue.list();
    this.rebuildMenu();

    // The queue emits per-byte progress updates while a transfer is running,
    // so we coalesce rebuilds into ~500ms ticks to avoid menu thrashing.
    this.unsubscribe = this.queue.on(() => {
      this.lastJobs = this.queue.list();
      this.scheduleRebuild();
    });
  }

  destroy(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tray?.destroy();
    this.tray = null;
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildMenu();
    }, 500);
  }

  private showWindow(): void {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      this.openWindow();
      return;
    }
    const w = wins.find((x) => !x.isDestroyed()) ?? wins[0];
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const stats = computeStats(this.lastJobs);
    const summary = summarize(stats);

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: "Show FlowSFTP", click: () => this.showWindow() },
      { type: "separator" },
      { label: summary, enabled: false },
      { type: "separator" },
      {
        label: "Pause all transfers",
        enabled: stats.running + stats.queued > 0,
        click: () => this.engine.pauseAll(),
      },
      {
        label: "Resume all transfers",
        enabled: stats.paused > 0,
        click: () => this.engine.resumeAll(),
      },
      { type: "separator" },
      { label: "Quit FlowSFTP", click: () => app.quit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
    this.tray.setToolTip(
      stats.active === 0
        ? "FlowSFTP — idle"
        : `FlowSFTP — ${summary}`,
    );
  }
}
