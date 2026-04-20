import { ipcMain } from "electron";
import {
  connectionIdSchema,
  sftpChmodSchema,
  sftpHashSchema,
  sftpPathSchema,
  sftpReadTextSchema,
  sftpRemoveSchema,
  sftpRenameSchema,
  sftpWriteTextSchema,
} from "../../shared/schemas";
import type { FileStat, Result, WalkedEntry } from "../../shared/types";
import type { SftpManager } from "../sftp/sftp-manager";

function validationMessage(err: {
  issues: readonly { message: string }[];
}): string {
  return err.issues[0]?.message ?? "Invalid input";
}

function validationResult(err: {
  issues: readonly { message: string }[];
}): Result<never> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: validationMessage(err),
      details: err.issues,
    },
  };
}

export function registerSftpOpsIpc(sftp: SftpManager): void {
  ipcMain.removeHandler("flowsftp:sftp:cwd");
  ipcMain.handle(
    "flowsftp:sftp:cwd",
    async (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = connectionIdSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.cwd(parsed.data.connectionId);
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:realPath");
  ipcMain.handle(
    "flowsftp:sftp:realPath",
    async (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = sftpPathSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.realPath(parsed.data.connectionId, parsed.data.path);
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:mkdir");
  ipcMain.handle(
    "flowsftp:sftp:mkdir",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = sftpPathSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.mkdir(parsed.data.connectionId, parsed.data.path);
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:rename");
  ipcMain.handle(
    "flowsftp:sftp:rename",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = sftpRenameSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.rename(
        parsed.data.connectionId,
        parsed.data.oldPath,
        parsed.data.newPath,
      );
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:remove");
  ipcMain.handle(
    "flowsftp:sftp:remove",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = sftpRemoveSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.remove(
        parsed.data.connectionId,
        parsed.data.path,
        parsed.data.recursive,
      );
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:chmod");
  ipcMain.handle(
    "flowsftp:sftp:chmod",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = sftpChmodSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.chmod(
        parsed.data.connectionId,
        parsed.data.path,
        parsed.data.mode,
      );
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:stat");
  ipcMain.handle(
    "flowsftp:sftp:stat",
    async (_e, raw: unknown): Promise<Result<FileStat>> => {
      const parsed = sftpPathSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.stat(parsed.data.connectionId, parsed.data.path);
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:readText");
  ipcMain.handle(
    "flowsftp:sftp:readText",
    async (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = sftpReadTextSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.readText(
        parsed.data.connectionId,
        parsed.data.path,
        parsed.data.maxBytes,
      );
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:writeText");
  ipcMain.handle(
    "flowsftp:sftp:writeText",
    async (_e, raw: unknown): Promise<Result<void>> => {
      const parsed = sftpWriteTextSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.writeText(
        parsed.data.connectionId,
        parsed.data.path,
        parsed.data.contents,
      );
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:walk");
  ipcMain.handle(
    "flowsftp:sftp:walk",
    async (_e, raw: unknown): Promise<Result<WalkedEntry[]>> => {
      const parsed = sftpPathSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.walk(parsed.data.connectionId, parsed.data.path);
    },
  );

  ipcMain.removeHandler("flowsftp:sftp:hash");
  ipcMain.handle(
    "flowsftp:sftp:hash",
    async (_e, raw: unknown): Promise<Result<string>> => {
      const parsed = sftpHashSchema.safeParse(raw);
      if (!parsed.success) return validationResult(parsed.error);
      return sftp.hash(
        parsed.data.connectionId,
        parsed.data.path,
        parsed.data.algorithm,
      );
    },
  );
}
