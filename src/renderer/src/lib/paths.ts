/** File name segment from a local or remote path. */
export function fileName(p: string): string {
  const n = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return n === -1 ? p : p.slice(n + 1);
}

/** Join POSIX remote path segments. */
export function joinRemotePath(cwd: string, name: string): string {
  if (cwd === "/") return `/${name}`.replace(/\/+/g, "/");
  return `${cwd.replace(/\/$/, "")}/${name}`.replace(/\/+/g, "/");
}

/** Parent directory for Windows or POSIX local paths. */
export function parentLocalPath(p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    const norm = p.replace(/\//g, "\\");
    const m = norm.match(/^(.*)[\\]([^\\]+)$/);
    if (!m) return norm.endsWith("\\") ? norm.slice(0, 3) : norm;
    if (m[1].endsWith(":")) return `${m[1]}\\`;
    return m[1];
  }
  if (p === "/" || p === "") return "/";
  const n = p.replace(/\/$/, "");
  const i = n.lastIndexOf("/");
  if (i <= 0) return "/";
  return n.slice(0, i) || "/";
}

export function parentRemotePath(p: string): string {
  if (!p || p === "/") return "/";
  const n = p.replace(/\/$/, "");
  const i = n.lastIndexOf("/");
  if (i <= 0) return "/";
  return n.slice(0, i) || "/";
}

/**
 * Human-friendly byte size. Uses binary units (KiB increments) but labels
 * them in the more common KB/MB/GB/... form. The unit array starts at "B"
 * so the index always matches the number of divisions performed (e.g. one
 * /1024 → KB, two → MB) — without this a 236 MB file rendered as 236 GB.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  const d = v < 10 ? 1 : 0;
  return `${v.toFixed(d)} ${units[i]}`;
}
