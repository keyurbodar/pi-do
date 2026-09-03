// files.ts — file-table storage behind a small FileStore seam.
// SQL strings are byte-identical to the original workspace-do.ts inline queries.

export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): Iterable<unknown>;
}

export interface FileEntry {
  path: string;
  bytes: number;
}

export interface FileStore {
  ensureSchema(): void;
  put(ws: string, path: string, body: Uint8Array, updatedAt: string): number;
  get(ws: string, path: string): ArrayBuffer | undefined;
  list(ws: string, dir: string): FileEntry[];
  exists(ws: string, path: string): boolean;
  remove(ws: string, path: string): boolean;
}

export function createFileStore(sql: SqlLike): FileStore {
  return {
    ensureSchema(): void {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS files(ws TEXT, path TEXT, body BLOB, updated_at TEXT, PRIMARY KEY(ws, path))",
      );
    },

    put(ws: string, path: string, body: Uint8Array, updatedAt: string): number {
      sql.exec(
        "INSERT OR REPLACE INTO files(ws, path, body, updated_at) VALUES (?, ?, ?, ?)",
        ws,
        path,
        body,
        updatedAt,
      );
      return body.byteLength;
    },

    get(ws: string, path: string): ArrayBuffer | undefined {
      const rows = [
        ...sql.exec("SELECT body FROM files WHERE ws = ? AND path = ?", ws, path),
      ] as Array<{ body: ArrayBuffer }>;
      return rows.length === 0 ? undefined : rows[0].body;
    },

    list(ws: string, dir: string): FileEntry[] {
      const rows = [
        ...sql.exec(
          "SELECT path, length(body) AS bytes FROM files WHERE ws = ? AND path LIKE (? || '%') ORDER BY path",
          ws,
          dir,
        ),
      ] as Array<{ path: string; bytes: number }>;
      return rows.map((r) => ({ path: r.path, bytes: r.bytes }));
    },

    exists(ws: string, path: string): boolean {
      const rows = [
        ...sql.exec(
          "SELECT 1 FROM files WHERE ws = ? AND path = ? LIMIT 1",
          ws,
          path,
        ),
      ];
      return rows.length > 0;
    },

    remove(ws: string, path: string): boolean {
      const found = [
        ...sql.exec(
          "SELECT 1 FROM files WHERE ws = ? AND path = ? LIMIT 1",
          ws,
          path,
        ),
      ];
      if (found.length === 0) return false;
      sql.exec("DELETE FROM files WHERE ws = ? AND path = ?", ws, path);
      return true;
    },
  };
}
