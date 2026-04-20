import { ElectronAPI } from "@electron-toolkit/preload";
import type { FlowSftpApi } from "./api";

declare global {
  interface Window {
    electron: ElectronAPI;
    api: FlowSftpApi;
  }
}

export {};
