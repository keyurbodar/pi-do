import { create } from 'zustand';
import type { Entry, FenceState } from './pi-do-ws';

export interface SessionStore {
  session: string | null;
  entries: Entry[];
  leaf: string | null;
  fence: FenceState | null;
  revision: number;
  setSession: (session: string | null) => void;
  setEntries: (entries: Entry[]) => void;
  setLeaf: (leaf: string | null) => void;
  setFence: (fence: FenceState | null) => void;
  setRevision: (revision: number) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionStore>()((set) => ({
  session: null,
  entries: [],
  leaf: null,
  fence: null,
  revision: 0,
  setSession: (session) => set({ session }),
  setEntries: (entries) => set({ entries }),
  setLeaf: (leaf) => set({ leaf }),
  setFence: (fence) => set({ fence }),
  setRevision: (revision) => set({ revision }),
  reset: () =>
    set({ session: null, entries: [], leaf: null, fence: null, revision: 0 }),
}));
