// Spike verdict (PR27): @cloudflare/shell 0.4.3 is experimental JS-in-a-Dynamic-Worker
// execution, not bash; its durable Workspace owns a separate SQLite schema and needs a
// Worker Loader binding plus the agents/codemode stack. The WorkspaceServiceProxy loopback
// belongs to @cloudflare/computer's worker-shell backend, which needs the full Workspace
// class, dofs Database, and sync machinery (@cloudflare/dofs is not on npm). Either path
// would add a second store or a continent of machinery against one files table, so the VFS
// stays on the existing table with byte-identical SQL and no new dependency.

import { CREATE_TABLES, FILES_QUERIES, ensureTables, existsBy, readSingleRow } from "./sql-util.ts";

export interface VfsSql {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
}

export interface VfsEntry {
  path: string;
  bytes: number;
}

export interface FileStore {
  ensureSchema(): void;
  put(ws: string, path: string, body: Uint8Array, updatedAt: string): number;
  get(ws: string, path: string): ArrayBuffer | undefined;
  list(ws: string, dir: string): VfsEntry[];
  exists(ws: string, path: string): boolean;
  remove(ws: string, path: string): boolean;
  mkdir(ws: string, path: string): void;
  removeTree(ws: string, prefix: string): string[];
}

export function createDofsVfs(sql: VfsSql): FileStore {
  return {
    ensureSchema(): void {
      ensureTables(sql, [CREATE_TABLES.files]);
    },

    put(ws: string, path: string, body: Uint8Array, updatedAt: string): number {
      sql.exec(FILES_QUERIES.put, ws, path, body, updatedAt);
      return body.byteLength;
    },

    get(ws: string, path: string): ArrayBuffer | undefined {
      const row = readSingleRow(sql, FILES_QUERIES.get, ws, path);
      if (row === null) return undefined;
      return row.body as ArrayBuffer | undefined;
    },

    list(ws: string, dir: string): VfsEntry[] {
      const rows = [...sql.exec(FILES_QUERIES.list, ws, dir)] as Array<{ path: string; bytes: number }>;
      return rows.map((r) => ({ path: r.path, bytes: r.bytes }));
    },

    exists(ws: string, path: string): boolean {
      return existsBy(sql, FILES_QUERIES.exists, ws, path);
    },

    mkdir(_ws: string, path: string): void {
      if (path === "") throw { error: "bad path", hint: "the workspace root always exists; mkdir needs a path under it" };
    },

    remove(ws: string, path: string): boolean {
      if (!existsBy(sql, FILES_QUERIES.exists, ws, path)) return false;
      sql.exec(FILES_QUERIES.remove, ws, path);
      return true;
    },

    removeTree(ws: string, prefix: string): string[] {
      const rows = [...sql.exec(FILES_QUERIES.listPaths, ws, prefix)] as Array<{ path: string }>;
      if (rows.length === 0) return [];
      sql.exec(FILES_QUERIES.deleteByPrefix, ws, prefix);
      return rows.map((r) => r.path);
    },
  };
}
