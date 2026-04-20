import { defineStore } from "pinia";
import type {
  Session,
  SessionInput,
  SessionsExportResult,
  SessionsImportResult,
} from "@shared/types";

type State = {
  sessions: Session[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

export const useSessionsStore = defineStore("sessions", {
  state: (): State => ({
    sessions: [],
    loaded: false,
    loading: false,
    error: null,
  }),
  getters: {
    byId: (state) => (id: string) =>
      state.sessions.find((s) => s.id === id) ?? null,
    grouped: (state) => {
      const groups = new Map<string, Session[]>();
      for (const s of state.sessions) {
        const key = s.group?.trim() || "Ungrouped";
        const arr = groups.get(key) ?? [];
        arr.push(s);
        groups.set(key, arr);
      }
      return [...groups.entries()]
        .map(([group, items]) => ({
          group,
          items: items.slice().sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.group.localeCompare(b.group));
    },
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      const r = await window.api.sessions.list();
      this.loading = false;
      if (r.ok) {
        this.sessions = r.data;
        this.loaded = true;
      } else {
        this.error = r.error.message;
      }
    },
    async create(input: SessionInput): Promise<Session | null> {
      const r = await window.api.sessions.create(input);
      if (r.ok) {
        this.sessions = [...this.sessions, r.data];
        return r.data;
      }
      this.error = r.error.message;
      return null;
    },
    async update(
      id: string,
      patch: Partial<SessionInput>,
    ): Promise<Session | null> {
      const r = await window.api.sessions.update(id, patch);
      if (r.ok) {
        this.sessions = this.sessions.map((s) => (s.id === id ? r.data : s));
        return r.data;
      }
      this.error = r.error.message;
      return null;
    },
    async remove(id: string): Promise<boolean> {
      const r = await window.api.sessions.remove(id);
      if (r.ok) {
        this.sessions = this.sessions.filter((s) => s.id !== id);
        return true;
      }
      this.error = r.error.message;
      return false;
    },
    async duplicate(id: string): Promise<Session | null> {
      const r = await window.api.sessions.duplicate(id);
      if (r.ok) {
        this.sessions = [...this.sessions, r.data];
        return r.data;
      }
      this.error = r.error.message;
      return null;
    },
    async exportToFile(): Promise<SessionsExportResult | null> {
      const r = await window.api.sessions.exportToFile();
      if (r.ok) return r.data;
      this.error = r.error.message;
      return null;
    },
    /* Refresh the in-memory list after a successful import so the
     * sidebar immediately reflects the new sites without forcing the
     * caller to re-load. */
    async importFromFile(): Promise<SessionsImportResult | null> {
      const r = await window.api.sessions.importFromFile();
      if (!r.ok) {
        this.error = r.error.message;
        return null;
      }
      if (r.data.added > 0) {
        await this.load();
      }
      return r.data;
    },
  },
});
