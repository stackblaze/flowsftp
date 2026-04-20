import { Menu, app, BrowserWindow, webContents } from "electron";
import type { MenuCommand } from "@shared/types";

/**
 * Send a menu command to the currently focused renderer (or, as a fallback,
 * the first BrowserWindow). The renderer subscribes via
 * `window.api.app.onMenuCommand(cb)`.
 */
function dispatch(cmd: MenuCommand): void {
  const focused = webContents.getFocusedWebContents();
  const target =
    focused ??
    BrowserWindow.getFocusedWindow()?.webContents ??
    BrowserWindow.getAllWindows()[0]?.webContents ??
    null;
  if (!target) return;
  target.send("synctron:menu:command", cmd);
}

const send =
  (cmd: MenuCommand): (() => void) =>
  () =>
    dispatch(cmd);

export function setAppMenu(
  createMainWindow: () => void,
  /** Optional hook to also kick the main-process UpdateManager when the
   *  user clicks "Check for updates…". The renderer toast/dialog still
   *  drives the UI; this just makes the verb feel instant. */
  onCheckForUpdates?: () => void,
): void {
  const isMac = process.platform === "darwin";
  const checkForUpdates = (): void => {
    onCheckForUpdates?.();
    dispatch("checkForUpdates");
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              {
                label: "Check for Updates…",
                click: checkForUpdates,
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => createMainWindow(),
        },
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: send("newTab"),
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: send("closeTab"),
        },
        { type: "separator" },
        { role: "close", label: isMac ? "Close Window" : "Close" },
        ...(isMac
          ? []
          : ([
              { type: "separator" as const },
              { role: "quit" as const, label: "Exit" },
            ] as const)),
      ],
    },
    {
      label: "Session",
      submenu: [
        {
          label: "Login…",
          accelerator: "CmdOrCtrl+L",
          click: send("login"),
        },
        {
          label: "Disconnect",
          accelerator: "CmdOrCtrl+D",
          click: send("disconnect"),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" as const },
              { role: "delete" as const },
              { role: "selectAll" as const },
            ]
          : [
              { role: "delete" as const },
              { type: "separator" as const },
              { role: "selectAll" as const },
            ]),
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Refresh",
          accelerator: "F5",
          click: send("refreshBoth"),
        },
        {
          label: "Parent Directory",
          accelerator: "Backspace",
          click: send("parentDir"),
        },
        { type: "separator" },
        {
          label: "Toggle Theme",
          accelerator: "CmdOrCtrl+Shift+T",
          click: send("toggleTheme"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    {
      label: "Commands",
      submenu: [
        {
          label: "Refresh Both Panes",
          accelerator: "CmdOrCtrl+R",
          click: send("refreshBoth"),
        },
        {
          label: "Go to Parent Directory",
          click: send("parentDir"),
        },
      ],
    },
    {
      label: "Queue",
      submenu: [
        {
          label: "Show / Hide Queue Panel",
          accelerator: "CmdOrCtrl+Q",
          click: send("toggleQueuePanel"),
        },
        {
          label: "Show / Hide Transfer Window",
          accelerator: "CmdOrCtrl+Shift+P",
          click: send("toggleTransferDialog"),
        },
        { type: "separator" },
        { label: "Pause All", click: send("pauseAll") },
        { label: "Resume All", click: send("resumeAll") },
        { type: "separator" },
        { label: "Clear Completed", click: send("clearCompleted") },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates…",
          click: checkForUpdates,
        },
        { type: "separator" },
        {
          label: "About Synctron",
          click: send("about"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
