import { BrowserWindow, shell } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import type { SftpManager } from "./sftp/sftp-manager";

/* The bundled icon path is exposed for callers that need it outside of
 * the BrowserWindow constructor (e.g. `app.dock.setIcon` on macOS). */
export const APP_ICON_PATH = icon;

/**
 * Creates a main FlowSFTP commander window. Each window is isolated (own Vue app).
 * SFTP connections are tied to `webContents.id` for progress events and cleanup on close.
 */
export function createMainWindow(sftp: SftpManager): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 800,
    minHeight: 520,
    show: false,
    title: "FlowSFTP",
    autoHideMenuBar: false,
    /* macOS ignores `icon` on BrowserWindow — the dock icon comes from the
     * packaged .icns. We still set it on Windows/Linux where it controls
     * the taskbar entry and (on Linux) the window decoration. */
    ...(process.platform !== "darwin" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // Capture the WebContents id eagerly: by the time `closed` fires, both the
  // BrowserWindow and its WebContents are destroyed and any property access
  // throws "Object has been destroyed".
  const ownerId = win.webContents.id;

  win.on("ready-to-show", () => {
    win.show();
  });

  win.on("closed", () => {
    void sftp.disconnectByOwner(ownerId);
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}
