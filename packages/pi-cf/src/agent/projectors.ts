import { ENTRY_PROJECTION, type EntryProjection } from "../store/sql-util.ts";

export type { EntryProjection };

// Custom entry projectors. Registered types project through the registry;
// unregistered types fall back to the fixed ENTRY_PROJECTION table, and types
// in neither keep the old "unprojected" skip.
const custom: Record<string, EntryProjection> = {};

export function registerProjector(type: string, proj: EntryProjection): void {
  custom[type] = proj;
}

export function projectEntry(type: string): EntryProjection | undefined {
  return custom[type] ?? ENTRY_PROJECTION[type];
}
