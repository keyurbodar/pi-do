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

  const isFile = (key: string): boolean => map.has(key);
  const isDir = (key: string): boolean => {
    if (key === "") return map.size > 0;
    const prefix = `${key}/`;
    for (const k of map.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  const statLike = (key: string, display: string) => {
    if (isFile(key)) {
      const size = map.get(key)?.byteLength ?? 0;
      return {
        type: "file" as const,
        mode: 0o100644,
        size,
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
      if (isFile(key)) {
        const e = new Error(`ENOTDIR: not a directory, scandir '${dirPath}'`) as Error & { code: string };
        e.code = "ENOTDIR";
        throw e;
      }
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
    // Write entry points: present so probing sees them, always refusing.
    writeFile: async (p: string): Promise<void> => {
      throw erofs(`writeFile ${p}`);
    },
    mkdir: async (p: string): Promise<void> => {
      throw erofs(`mkdir ${p}`);
    },
    unlink: async (p: string): Promise<void> => {
      throw erofs(`unlink ${p}`);
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
