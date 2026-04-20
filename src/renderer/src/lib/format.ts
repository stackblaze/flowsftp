/**
 * Formatting helpers for transfer speeds, ETAs, and human-friendly times.
 * These complement {@link ./paths.ts:formatBytes} but are kept separate to
 * keep the path module focused on path semantics.
 */

/** Format a byte-per-second rate as "12.3 MB/s" or "—" when unknown. */
export function formatSpeed(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "—";
  }
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let v = bytesPerSec;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = v < 10 && i > 0 ? 1 : 0;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

/**
 * Format a remaining-seconds value as "1h 12m", "3m 5s" or "12s".
 * Returns "—" when the input is null, infinite, or non-positive.
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Render an absolute timestamp (ms since epoch) relative to now:
 * "just now" / "2m ago" / "3h ago" / "yesterday" / locale date.
 */
export function formatRelativeTime(
  ts: number | null | undefined,
  now: number = Date.now(),
): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/** Compact date+time for file lists. */
export function formatDateTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Percentage 0..100 with optional decimals. */
export function formatPercent(
  transferred: number,
  total: number,
  decimals = 0,
): string {
  if (!total || !Number.isFinite(total) || total <= 0) return "0%";
  const pct = Math.min(100, Math.max(0, (transferred / total) * 100));
  return `${pct.toFixed(decimals)}%`;
}
