import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { app } from "electron";
import type { Session, SessionInput } from "../../shared/types";

/**
 * Persists sessions to <userData>/sessions.json with atomic writes.
 *
 * NOTE: Passwords are intentionally NOT stored. Secret storage (passwords,
 * passphrases) lands in M4 via keytar / OS keychain integration.
 */
export class SessionsStore {
  private readonly file: string;
  private cache: Session[] | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file ?? join(app.getPath("userData"), "sessions.json");
  }

  async list(): Promise<Session[]> {
    if (this.cache) return [...this.cache];
    const loaded = await this.read();
    this.cache = loaded;
    return [...loaded];
  }

  async create(input: SessionInput): Promise<Session> {
    const all = await this.list();
    const now = Date.now();
    const session: Session = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const next = [...all, session];
    await this.persist(next);
    return session;
  }

  async update(id: string, patch: Partial<SessionInput>): Promise<Session> {
    const all = await this.list();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) {
      throw new Error(`Session ${id} not found`);
    }
    const merged: Session = {
      ...all[idx],
      ...patch,
      id: all[idx].id,
      createdAt: all[idx].createdAt,
      updatedAt: Date.now(),
    };
    const next = [...all];
    next[idx] = merged;
    await this.persist(next);
    return merged;
  }

  async remove(id: string): Promise<void> {
    const all = await this.list();
    const next = all.filter((s) => s.id !== id);
    if (next.length === all.length) {
      throw new Error(`Session ${id} not found`);
    }
    await this.persist(next);
  }

  async duplicate(id: string): Promise<Session> {
    const all = await this.list();
    const orig = all.find((s) => s.id === id);
    if (!orig) {
      throw new Error(`Session ${id} not found`);
    }
    const now = Date.now();
    const copy: Session = {
      ...orig,
      id: randomUUID(),
      name: `${orig.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...all, copy];
    await this.persist(next);
    return copy;
  }

  /**
   * Bulk-import session inputs (already validated by the IPC layer).
   * Skips entries whose host+port+username triple already exists — a name
   * collision alone isn't enough to consider them duplicates because users
   * frequently rename hosts. Returns counts so the UI can confirm what
   * happened.
   */
  async importMany(
    inputs: SessionInput[],
  ): Promise<{ added: Session[]; skipped: number }> {
    const all = await this.list();
    const seen = new Set(all.map((s) => keyOf(s)));
    const now = Date.now();
    const added: Session[] = [];
    let skipped = 0;
    for (const input of inputs) {
      const k = keyOf(input);
      if (seen.has(k)) {
        skipped++;
        continue;
      }
      seen.add(k);
      added.push({
        ...input,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      });
    }
    if (added.length > 0) {
      await this.persist([...all, ...added]);
    }
    return { added, skipped };
  }

  private async read(): Promise<Session[]> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSession);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  }

  private async persist(next: Session[]): Promise<void> {
    this.cache = next;
    this.writeChain = this.writeChain.then(() => this.atomicWrite(next));
    await this.writeChain;
  }

  private async atomicWrite(data: Session[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const json = JSON.stringify(data, null, 2);
    await writeFile(tmp, json, "utf8");
    await rename(tmp, this.file);
  }
}

function isSession(v: unknown): v is Session {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.host === "string" &&
    typeof o.username === "string" &&
    typeof o.port === "number" &&
    o.protocol === "sftp"
  );
}

/** Identity key used for de-duplication during import. Name is intentionally
 *  excluded so renaming the same host doesn't bypass dedup. */
function keyOf(s: { host: string; port: number; username: string }): string {
  return `${s.username.toLowerCase()}@${s.host.toLowerCase()}:${s.port}`;
}
