export interface WorkspaceFile {
  path: string;
  body: Uint8Array;
}

function normalize(p: string): string | null {
  const clean = p.replace(/^\/+/, "").replace(/\/$/, "");
  const parts = clean.split("/");
  for (const seg of parts) {
    if (seg === "..") return null;
  }
  return parts.filter((s) => s.length > 0 && s !== ".").join("/");
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: no such file or directory, stat '${p}'`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

function enotdir(p: string): Error {
  const e = new Error(`ENOTDIR: not a directory, scandir '${p}'`) as Error & { code: string };
  e.code = "ENOTDIR";
  return e;
}

function erofs(op: string): Error {
  const e = new Error(`EROFS: operation not supported, '${op}'`) as Error & { code: string };
  e.code = "EROFS";
  return e;
}

export function createWorkspaceFs(files: WorkspaceFile[]): {
  promises: Record<string, unknown>;
  dirty(): { upserts: WorkspaceFile[]; deletes: string[] };
} {
  const map = new Map<string, Uint8Array>();
  for (const f of files) {
    const key = normalize(f.path);
    if (key === null || key === "") continue;
    map.set(key, f.body.slice(0));
  }
  const snapshot = new Map<string, Uint8Array>();
  for (const [key, bytes] of map) snapshot.set(key, bytes.slice(0));

  const toBytes = (data: unknown): Uint8Array => {
    if (data instanceof Uint8Array) return data.slice(0);
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data !== null && typeof data === "object" && "buffer" in data) {
      const raw = data.buffer;
      if (raw instanceof ArrayBuffer) return new Uint8Array(raw.slice(0));
    }
    return new Uint8Array(0);
  };

  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };

  const isFile = (key: string): boolean => map.has(key);
  const isDir = (key: string): boolean => {
    if (key === "") return true;
    const prefix = `${key}/`;
    for (const k of map.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  const STAMP = new Date("2025-01-01T00:00:00.000Z");
  const statLike = (key: string, display: string) => {
    if (isFile(key)) {
      const size = map.get(key)?.byteLength ?? 0;
      return {
        type: "file" as const,
        mode: 0o100644,
        size,
        mtime: STAMP,
        ctime: STAMP,
        atime: STAMP,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    }
    if (isDir(key)) {
      return {
        type: "dir" as const,
        mode: 0o040000,
        size: 0,
        mtime: STAMP,
        ctime: STAMP,
        atime: STAMP,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    }
    throw enoent(display);
  };

  const decodeOpt = (o: unknown): string | null => {
    if (typeof o === "string") return o;
    if (o !== null && typeof o === "object") {
      const enc = (o as { encoding?: unknown }).encoding;
      if (typeof enc === "string") return enc;
    }
    return null;
  };

  const promises: Record<string, unknown> = {
    readFile: async (filePath: string, options?: unknown): Promise<Uint8Array | string> => {
      const key = normalize(String(filePath));
      if (key === null || key === "") throw enoent(String(filePath));
      const bytes = map.get(key);
      if (!bytes) throw enoent(String(filePath));
      const enc = decodeOpt(options);
      if (enc && /utf-?8/i.test(enc)) return new TextDecoder().decode(bytes);
      return bytes.slice(0);
    },
    readdir: async (dirPath: string): Promise<string[]> => {
      const key = normalize(String(dirPath));
      if (key === null) throw enoent(String(dirPath));
      if (isFile(key)) throw enotdir(String(dirPath));
      if (!isDir(key)) throw enoent(String(dirPath));
      const prefix = key === "" ? "" : `${key}/`;
      const kids = new Set<string>();
      for (const k of map.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) kids.add(seg);
      }
      return [...kids].sort();
    },
    stat: async (p: string) => statLike(normalize(String(p)) ?? "\0", String(p)),
    lstat: async (p: string) => statLike(normalize(String(p)) ?? "\0", String(p)),
    access: async (p: string) => {
      const key = normalize(String(p));
      if (key === null || (!isFile(key) && !isDir(key))) throw enoent(String(p));
    },
    readlink: async (p: string): Promise<string> => {
      throw enoent(String(p));
    },
    writeFile: async (p: string, data?: unknown): Promise<void> => {
      const key = normalize(String(p));
      if (key === null || key === "") throw enoent(String(p));
      map.set(key, toBytes(data));
    },
    appendFile: async (p: string, data?: unknown): Promise<void> => {
      const key = normalize(String(p));
      if (key === null || key === "") throw enoent(String(p));
      const prev = map.get(key) ?? new Uint8Array(0);
      const next = toBytes(data);
      const out = new Uint8Array(prev.byteLength + next.byteLength);
      out.set(prev, 0);
      out.set(next, prev.byteLength);
      map.set(key, out);
    },
    mkdir: async (p: string): Promise<void> => {
      const key = normalize(String(p));
      if (key === null) throw enoent(String(p));
    },
    unlink: async (p: string): Promise<void> => {
      const key = normalize(String(p));
      if (key === null || key === "") throw enoent(String(p));
      if (!map.delete(key)) throw enoent(String(p));
    },
    rename: async (oldP: string, newP: string): Promise<void> => {
      const oldKey = normalize(String(oldP));
      const newKey = normalize(String(newP));
      if (oldKey === null || oldKey === "" || newKey === null || newKey === "") throw enoent(String(oldP));
      const bytes = map.get(oldKey);
      if (!bytes) throw enoent(String(oldP));
      map.set(newKey, bytes);
      map.delete(oldKey);
    },
    rmdir: async (p: string): Promise<void> => {
      const key = normalize(String(p));
      if (key === null) throw enoent(String(p));
      if (isFile(key)) throw enotdir(String(p));
      if (!isDir(key)) throw enoent(String(p));
    },
    rm: async (p: string): Promise<void> => {
      const key = normalize(String(p));
      if (key === null || key === "") throw enoent(String(p));
      if (map.delete(key)) return;
      const prefix = `${key}/`;
      let found = false;
      for (const k of [...map.keys()]) {
        if (k.startsWith(prefix)) {
          map.delete(k);
          found = true;
        }
      }
      if (!found) throw enoent(String(p));
    },
    symlink: async (): Promise<void> => {
      throw erofs("symlink");
    },
    chmod: async (): Promise<void> => {
      throw erofs("chmod");
    },
  };

  return {
    promises,
    dirty: () => {
      const upserts: WorkspaceFile[] = [];
      const deletes: string[] = [];
      for (const [key, bytes] of map) {
        const orig = snapshot.get(key);
        if (!orig || !sameBytes(orig, bytes)) upserts.push({ path: key, body: bytes.slice(0) });
      }
      for (const key of snapshot.keys()) {
        if (!map.has(key)) deletes.push(key);
      }
      return { upserts, deletes };
    },
  };
}

export function hasGitDir(files: WorkspaceFile[]): boolean {
  return files.some((f) => {
    const key = normalize(f.path);
    return key !== null && (key === ".git" || key.startsWith(".git/"));
  });
}
