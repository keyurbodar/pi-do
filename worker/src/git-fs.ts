// git-fs.ts — isomorphic-git fs adapter over the workspace files table.
//
// Shape reuse (not code) from refs/computer/packages/computer/src/git/adapter.ts:
// isomorphic-git wants an `fs` object whose `.promises` is an own property
// implementing the node:fs/promises subset it probes. We back that subset
// with one in-memory snapshot of the files table per request (flat key list,
// directories synthesized from prefixes). Read-only: write entry points throw
// EROFS so a buggy caller fails loudly instead of silently dropping a write.

export interface WorkspaceFile {
  path: string;
  body: Uint8Array;
}

function normalize(p: string): string | null {
  // Strip leading slashes, drop one trailing slash, reject dot-dot.
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

function erofs(op: string): Error {
  const e = new Error(`EROFS: writes deferred, '${op}' unavailable in PR05`) as Error & { code: string };
  e.code = "EROFS";
  return e;
}

export function createWorkspaceFs(files: WorkspaceFile[]): { promises: Record<string, unknown> } {
  const map = new Map<string, Uint8Array>();
  for (const f of files) {
    const key = normalize(f.path);
    if (key === null || key === "") continue;
    map.set(key, f.body);
  }
  // Ephemeral index overlay: statusMatrix refreshes `.git/index` (via an
  // `index.lock` + rename) even on pure reads. Those bytes live only in this
  // per-request map and never reach the files table — the VFS is unchanged.
  const overlay = new Map<string, Uint8Array>();
  const isEphemeralIndex = (key: string): boolean =>
    key === ".git/index" || key === ".git/index.lock";
  const fileBytes = (key: string): Uint8Array | undefined =>
    (isEphemeralIndex(key) ? overlay.get(key) : undefined) ?? map.get(key);
  const toBytes = (data: unknown): Uint8Array => {
    if (data instanceof Uint8Array) return data.slice(0);
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data !== null && typeof data === "object" && "buffer" in data) {
      const raw = data.buffer;
      if (raw instanceof ArrayBuffer) return new Uint8Array(raw.slice(0));
    }
    return new Uint8Array(0);
  };

  const isFile = (key: string): boolean => map.has(key) || overlay.has(key);
  const isDir = (key: string): boolean => {
    if (key === "") return map.size > 0;
    const prefix = `${key}/`;
    for (const k of map.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  // Fixed timestamps: determinism beats realism. isomorphic-git calls
  // stat.mtime.valueOf() during statusMatrix, so all three must exist.
  const STAMP = new Date("2025-01-01T00:00:00.000Z");
  const statLike = (key: string, display: string) => {
    if (isFile(key)) {
      const size = fileBytes(key)?.byteLength ?? 0;
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
      const bytes = fileBytes(key);
      if (!bytes) throw enoent(String(filePath));
      const enc = decodeOpt(options);
      if (enc && /utf-?8/i.test(enc)) return new TextDecoder().decode(bytes);
      return bytes.slice(0);
    },
    readdir: async (dirPath: string): Promise<string[]> => {
      const key = normalize(String(dirPath));
      if (key === null) throw enoent(String(dirPath));
      if (isFile(key)) {
        const e = new Error(`ENOTDIR: not a directory, scandir '${dirPath}'`) as Error & { code: string };
        e.code = "ENOTDIR";
        throw e;
      }
      if (!isDir(key)) throw enoent(String(dirPath));
      const prefix = key === "" ? "" : `${key}/`;
      const kids = new Set<string>();
      for (const k of [...map.keys(), ...overlay.keys()]) {
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
    // Write entry points: present so probing sees them, refusing everything
    // except the ephemeral index refresh described above.
    writeFile: async (p: string, data?: unknown): Promise<void> => {
      const key = normalize(String(p));
      if (key !== null && isEphemeralIndex(key)) {
        overlay.set(key, toBytes(data));
        return;
      }
      throw erofs(`writeFile ${p}`);
    },
    // Ensure-dir probe: isomorphic-git mkdirs the gitdir before reads.
    // No-op when the dir already exists in the snapshot (nothing changes);
    // anything else stays EROFS — writes wait.
    mkdir: async (p: string): Promise<void> => {
      const key = normalize(String(p));
      if (key !== null && (key === "" || isDir(key) || isFile(key))) return;
      throw erofs(`mkdir ${p}`);
    },
    // Lock release for the ephemeral index refresh: drop the overlay copy.
    // Anything outside `.git/index*` stays EROFS.
    unlink: async (p: string): Promise<void> => {
      const key = normalize(String(p));
      if (key !== null && isEphemeralIndex(key) && overlay.delete(key)) return;
      if (key !== null && isEphemeralIndex(key) && !map.has(key)) throw enoent(String(p));
      throw erofs(`unlink ${p}`);
    },
    // Lock commit for the ephemeral index refresh: move overlay bytes to the
    // overlay index copy. Never touches the files table.
    rename: async (oldP: string, newP: string): Promise<void> => {
      const oldKey = normalize(String(oldP));
      const newKey = normalize(String(newP));
      if (oldKey !== null && newKey !== null && isEphemeralIndex(oldKey) && isEphemeralIndex(newKey)) {
        const bytes = fileBytes(oldKey);
        if (!bytes) throw enoent(String(oldP));
        overlay.set(newKey, bytes);
        overlay.delete(oldKey);
        return;
      }
      throw erofs(`rename ${oldP} -> ${newP}`);
    },
    rmdir: async (p: string): Promise<void> => {
      throw erofs(`rmdir ${p}`);
    },
    rm: async (p: string): Promise<void> => {
      throw erofs(`rm ${p}`);
    },
    symlink: async (): Promise<void> => {
      throw erofs("symlink");
    },
    chmod: async (): Promise<void> => {
      throw erofs("chmod");
    },
  };

  return { promises };
}

/** True when the snapshot carries a `.git/` tree (leading slash tolerated). */
export function hasGitDir(files: WorkspaceFile[]): boolean {
  return files.some((f) => {
    const key = normalize(f.path);
    return key !== null && (key === ".git" || key.startsWith(".git/"));
  });
}
