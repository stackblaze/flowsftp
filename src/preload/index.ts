import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import { synctronApi } from "./api";

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", synctronApi);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error legacy
  window.electron = electronAPI;
  // @ts-expect-error legacy
  window.api = synctronApi;
}
