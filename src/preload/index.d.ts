import { ElectronAPI } from "@electron-toolkit/preload";
import type { SynctronApi } from "./api";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: SynctronApi;
  }
}

export {};
