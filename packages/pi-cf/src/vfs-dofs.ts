// vfs-dofs.ts — dofs-backed VFS over the files table in DO SQLite.
//
// Spike verdict (PR27): @cloudflare/shell 0.4.3 is experimental JS-in-a-Dynamic-Worker
// execution, not bash; its durable Workspace owns a separate SQLite schema and needs a
// Worker Loader binding plus the agents/codemode stack. The WorkspaceServiceProxy loopback
// belongs to @cloudflare/computer's worker-shell backend, which needs the full Workspace
// class, dofs Database, and sync machinery (@cloudflare/dofs is not on npm). Either path
// would add a second store or a continent of machinery against one files table, so the VFS
// stays on the existing table with byte-identical SQL and no new dependency.
//
// Directories are virtual: a path exists iff a row exists; mkdir is a validated no-op.

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
  stat(ws: string, path: string): VfsEntry | undefined;
  readRange(ws: string, path: string, offset: number, length?: number): Uint8Array | undefined;
  mkdir(ws: string, path: string): void;
  removeTree(ws: string, prefix: string): string[];
}

export function createDofsVfs(sql: VfsSql): FileStore {
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

    // Byte range sliced at storage so large reads never materialize the full blob.
    // SQLite substr is 1-indexed; offset is 0-indexed bytes. Missing file reads
    // undefined; an offset past the end reads an empty array.
    readRange(ws: string, path: string, offset: number, length?: number): Uint8Array | undefined {
      const start = Math.max(0, Math.floor(offset)) + 1;
      const rows =
        length === undefined
          ? ([
              ...sql.exec("SELECT substr(body, ?) AS body FROM files WHERE ws = ? AND path = ?", start, ws, path),
            ] as Array<{ body: ArrayBuffer | Uint8Array }>)
          : ([
              ...sql.exec(
                "SELECT substr(body, ?, ?) AS body FROM files WHERE ws = ? AND path = ?",
                start,
                Math.max(0, Math.floor(length)),
                ws,
                path,
              ),
            ] as Array<{ body: ArrayBuffer | Uint8Array }>);
      if (rows.length === 0) return undefined;
      const body = rows[0].body;
      return body instanceof Uint8Array ? body : new Uint8Array(body);
    },

    stat(ws: string, path: string): VfsEntry | undefined {
      const rows = [
        ...sql.exec("SELECT path, length(body) AS bytes FROM files WHERE ws = ? AND path = ?", ws, path),
      ] as Array<{ path: string; bytes: number }>;
      return rows.length === 0 ? undefined : { path: rows[0].path, bytes: rows[0].bytes };
    },

    list(ws: string, dir: string): VfsEntry[] {
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

    // Virtual directories need no rows; the call only rejects an empty path so
    // callers cannot mistake the workspace root for a created directory.
    mkdir(_ws: string, path: string): void {
      if (path === "") throw { error: "bad path", hint: "the workspace root always exists; mkdir needs a path under it" };
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

    // DELETE file-or-tree: removes every row under prefix in path order and
    // returns the removed paths. Callers enforce the recursive gate and root
    // refusal before reaching here.
    removeTree(ws: string, prefix: string): string[] {
      const rows = [
        ...sql.exec(
          "SELECT path FROM files WHERE ws = ? AND path LIKE (? || '%') ORDER BY path",
          ws,
          prefix,
        ),
      ] as Array<{ path: string }>;
      if (rows.length === 0) return [];
      sql.exec("DELETE FROM files WHERE ws = ? AND path LIKE (? || '%')", ws, prefix);
      return rows.map((r) => r.path);
    },
  };
}
