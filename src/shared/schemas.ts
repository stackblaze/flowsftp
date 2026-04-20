import { z } from "zod";

/** SFTP session connect — password and/or private key path (validated in handler). */
export const sftpConnectSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).optional().default(22),
  username: z.string().min(1),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
});

export const connectionIdSchema = z.object({
  connectionId: z.string().uuid(),
});

export const sftpListSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
});

export const sftpUploadSchema = z.object({
  connectionId: z.string().uuid(),
  localPath: z.string().min(1),
  remotePath: z.string().min(1),
});

export const sftpOpenRemoteSchema = z.object({
  connectionId: z.string().uuid(),
  remotePath: z.string().min(1),
});

export const sftpDownloadSchema = z.object({
  connectionId: z.string().uuid(),
  remotePath: z.string().min(1),
  localPath: z.string().min(1),
});

export const localListSchema = z.object({
  path: z.string().min(1),
});

/** Saved sessions (no secrets persisted — keytar comes in M4). */
export const sessionInputSchema = z.object({
  name: z.string().min(1).max(120),
  group: z.string().max(120).optional(),
  protocol: z.literal("sftp"),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  privateKeyPath: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

export const sessionUpdateSchema = z.object({
  id: z.string().uuid(),
  patch: sessionInputSchema.partial(),
});

export const sessionIdSchema = z.object({
  id: z.string().uuid(),
});

/** Transfer queue. */
export const jobPrioritySchema = z.enum(["low", "normal", "high"]);

export const jobInputSchema = z.object({
  connectionId: z.string().uuid(),
  kind: z.enum(["upload", "download"]),
  src: z.string().min(1),
  dst: z.string().min(1),
  size: z.coerce.number().int().nonnegative().optional(),
  priority: jobPrioritySchema.optional(),
});

export const enqueueJobsSchema = z.object({
  jobs: z.array(jobInputSchema).min(1),
});

export const jobIdSchema = z.object({
  id: z.string().uuid(),
});

export const reorderJobsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

/** Runtime concurrency caps for the transfer engine. Both fields optional;
 *  the engine only updates the ones provided. The 1..8 ceiling matches
 *  `MAX_CONCURRENCY` / the SFTP per-connection pool ceiling. */
export const concurrencySchema = z
  .object({
    global: z.coerce.number().int().min(1).max(8).optional(),
    perSession: z.coerce.number().int().min(1).max(8).optional(),
  })
  .refine((v) => v.global !== undefined || v.perSession !== undefined, {
    message: "At least one of global or perSession must be provided",
  });

/** Local FS ops (M5: editor, rename, mkdir, delete, etc.). */
export const localPathSchema = z.object({
  path: z.string().min(1),
});

export const localRenameSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
});

export const localRemoveSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
});

export const localReadTextSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
});

export const localWriteTextSchema = z.object({
  path: z.string().min(1),
  contents: z.string(),
});

/** Remote (SFTP) FS ops. */
export const sftpPathSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
});

export const sftpRenameSchema = z.object({
  connectionId: z.string().uuid(),
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
});

export const sftpRemoveSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
  recursive: z.boolean().default(false),
});

export const sftpChmodSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
  mode: z.number().int().nonnegative(),
});

export const sftpReadTextSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
});

/** Hash algorithms exposed to the renderer. Kept narrow on purpose so the
 *  main process can switch on a known set without trusting renderer input. */
export const hashAlgorithmSchema = z.enum(["md5", "sha1", "sha256"]);

export const localHashSchema = z.object({
  path: z.string().min(1),
  algorithm: hashAlgorithmSchema,
});

export const sftpHashSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
  algorithm: hashAlgorithmSchema,
});

export const sftpWriteTextSchema = z.object({
  connectionId: z.string().uuid(),
  path: z.string().min(1),
  contents: z.string(),
});
