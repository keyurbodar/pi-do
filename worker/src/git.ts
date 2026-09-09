import { createGitClient, type GitCliResult } from "@cloudflare/computer/git";

export interface WorkspaceFile {
  path: string;
  body: Uint8Array;
}

function normalize(p: string): string | null {
  const parts = p.replace(/^\/+/, "").replace(/\/$/, "").split("/");
  for (const seg of parts) {
    if (seg === "..") return null;
  }
  return parts.filter((s) => s.length > 0 && s !== ".").join("/");
}

function err(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

const enoent = (p: string): Error => err("ENOENT", `ENOENT: no such file or directory, stat '${p}'`);
const enotdir = (p: string): Error => err("ENOTDIR", `ENOTDIR: not a directory, scandir '${p}'`);
const erofs = (op: string): Error => err("EROFS", `EROFS: operation not supported, '${op}'`);

export function createWorkspaceFs(files: WorkspaceFile[]): {
  promises: Record<string, unknown>;
  dirty(): { upserts: WorkspaceFile[]; deletes: string[] };
} {
  const map = new Map<string, Uint8Array>();
  for (const f of files) {
    const k = normalize(f.path);
    if (k === null || k === "") continue;
    map.set(k, f.body.slice(0));
  }
  const snapshot = new Map<string, Uint8Array>();
  for (const [k, bytes] of map) snapshot.set(k, bytes.slice(0));
  const toBytes = (data: unknown): Uint8Array => {
    if (data instanceof Uint8Array) return data.slice(0);
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data !== null && typeof data === "object" && "buffer" in data) {
      const raw = (data as { buffer: unknown }).buffer;
      if (raw instanceof ArrayBuffer) return new Uint8Array(raw.slice(0));
    }
    return new Uint8Array(0);
  };
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const isFile = (k: string): boolean => map.has(k);
  const isDir = (k: string): boolean => {
    if (k === "") return true;
    const prefix = `${k}/`;
    for (const key of map.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };
  const STAMP = new Date("2025-01-01T00:00:00.000Z");
  const statLike = (k: string, display: string) => {
    if (isFile(k)) {
      return { type: "file" as const, mode: 0o100644, size: map.get(k)?.byteLength ?? 0, mtime: STAMP, ctime: STAMP, atime: STAMP, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    }
    if (isDir(k)) {
      return { type: "dir" as const, mode: 0o040000, size: 0, mtime: STAMP, ctime: STAMP, atime: STAMP, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
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
    readFile: async (p: string, o?: unknown): Promise<Uint8Array | string> => {
      const k = normalize(String(p));
      if (k === null || k === "") throw enoent(String(p));
      const bytes = map.get(k);
      if (!bytes) throw enoent(String(p));
      const enc = decodeOpt(o);
      if (enc && /utf-?8/i.test(enc)) return new TextDecoder().decode(bytes);
      return bytes.slice(0);
    },
    readdir: async (p: string): Promise<string[]> => {
      const k = normalize(String(p));
      if (k === null) throw enoent(String(p));
      if (isFile(k)) throw enotdir(String(p));
      if (!isDir(k)) throw enoent(String(p));
      const prefix = k === "" ? "" : `${k}/`;
      const kids = new Set<string>();
      for (const key of map.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split("/")[0];
        if (seg) kids.add(seg);
      }
      return [...kids].sort();
    },
    stat: async (p: string) => statLike(normalize(String(p)) ?? "\0", String(p)),
    lstat: async (p: string) => statLike(normalize(String(p)) ?? "\0", String(p)),
    access: async (p: string) => {
      const k = normalize(String(p));
      if (k === null || (!isFile(k) && !isDir(k))) throw enoent(String(p));
    },
    readlink: async (p: string): Promise<string> => {
      throw enoent(String(p));
    },
    writeFile: async (p: string, data?: unknown): Promise<void> => {
      const k = normalize(String(p));
      if (k === null || k === "") throw enoent(String(p));
      map.set(k, toBytes(data));
    },
    appendFile: async (p: string, data?: unknown): Promise<void> => {
      const k = normalize(String(p));
      if (k === null || k === "") throw enoent(String(p));
      const prev = map.get(k) ?? new Uint8Array(0);
      const next = toBytes(data);
      const out = new Uint8Array(prev.byteLength + next.byteLength);
      out.set(prev, 0);
      out.set(next, prev.byteLength);
      map.set(k, out);
    },
    mkdir: async (p: string): Promise<void> => {
      if (normalize(String(p)) === null) throw enoent(String(p));
    },
    unlink: async (p: string): Promise<void> => {
      const k = normalize(String(p));
      if (k === null || k === "") throw enoent(String(p));
      if (!map.delete(k)) throw enoent(String(p));
    },
    rename: async (o: string, n: string): Promise<void> => {
      const ok = normalize(String(o));
      const nk = normalize(String(n));
      if (ok === null || ok === "" || nk === null || nk === "") throw enoent(String(o));
      const bytes = map.get(ok);
      if (!bytes) throw enoent(String(o));
      map.set(nk, bytes);
      map.delete(ok);
    },
    rmdir: async (p: string): Promise<void> => {
      const k = normalize(String(p));
      if (k === null) throw enoent(String(p));
      if (isFile(k)) throw enotdir(String(p));
      if (!isDir(k)) throw enoent(String(p));
    },
    rm: async (p: string): Promise<void> => {
      const k = normalize(String(p));
      if (k === null || k === "") throw enoent(String(p));
      if (map.delete(k)) return;
      const prefix = `${k}/`;
      let found = false;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
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
      for (const [k, bytes] of map) {
        const orig = snapshot.get(k);
        if (!orig || !sameBytes(orig, bytes)) upserts.push({ path: k, body: bytes.slice(0) });
      }
      for (const k of snapshot.keys()) if (!map.has(k)) deletes.push(k);
      return { upserts, deletes };
    },
  };
}

export function hasGitDir(files: WorkspaceFile[]): boolean {
  return files.some((f) => {
    const k = normalize(f.path);
    return k !== null && (k === ".git" || k.startsWith(".git/"));
  });
}
export const READ_HINT = "git argv runs against the workspace repo: status, log, diff, show, add, commit, rm, checkout, switch, init, branch, tag, stash, merge, reset, clean, remote, fetch, pull, push, clone (https only, shallow by default)";

export class NotARepoError extends Error {
  constructor(readonly dir = "/") {
    super(`not a git repository: ${dir}`);
    this.name = "NotARepoError";
  }
}

export function notARepoBody(): { error: string; hint: string } {
  return { error: "not a git repository", hint: "run git init, or clone an https remote into the workspace" };
}

export function isNotARepoCause(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/Could not find (HEAD|refs\/)/.test(msg)) return true;
  if (/not a (git )?repository/i.test(msg)) return true;
  if (/ENOTAREPO/.test(msg)) return true;
  const m = msg.toLowerCase();
  return m.includes(".git") && (m.includes("enoent") || m.includes("could not find") || m.includes("does not exist") || m.includes("not found"));
}

export type ArgvGate =
  | { ok: true; argv: string[] }
  | { ok: false; status: 403; error: string; hint: string };

export function gateArgv(argv: unknown): ArgvGate {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, status: 403, error: "missing argv", hint: `POST { "argv": ["status"] }; ${READ_HINT}` };
  }
  const [sub, ...rest] = argv;
  if (typeof sub !== "string" || sub.length === 0) {
    return { ok: false, status: 403, error: "missing argv", hint: `POST { "argv": ["status"] }; ${READ_HINT}` };
  }
  if (!rest.every((a) => typeof a === "string")) {
    return { ok: false, status: 403, error: `git ${sub} forbidden`, hint: READ_HINT };
  }
  if (sub === "clone" && rest.some((a) => /^(--depth=(0|Infinity)|--no-single-branch)$/.test(a))) {
    return { ok: false, status: 403, error: "git clone: full history refused", hint: "clone shallow (the default); pass --depth N for a deeper cut" };
  }
  return { ok: true, argv: [sub, ...(rest as string[])] };
}

const DEFAULT_IDENTITY = { name: "pi-do", email: "pi-do@local" };

export interface GitRunResult extends GitCliResult {
  upserts: WorkspaceFile[];
  deletes: string[];
}

export async function runGitArgv(files: WorkspaceFile[], argv: string[]): Promise<GitRunResult> {
  const handle = createWorkspaceFs(files);
  const factory = createGitClient({ adapter: async () => ({ promises: handle.promises }) });
  const client = factory({ ws: { provider: () => undefined as never }, defaultIdentity: DEFAULT_IDENTITY });
  const result = await client.cli({ argv, cwd: "/", env: {} });
  if (result.exitCode === 128 && isNotARepoCause(result.stderr)) throw new NotARepoError("/");
  if (result.exitCode === 0 && argv[0] === "rm") {
    const maybeRm: unknown = handle.promises["rm"];
    const rm: ((p: string) => Promise<void>) | undefined =
      typeof maybeRm === "function" ? (maybeRm as (p: string) => Promise<void>) : undefined;
    for (const p of argv.slice(1)) {
      if (p.startsWith("-") || p === "") continue;
      try {
        await rm?.(p);
      } catch {
      }
    }
  }
  const { upserts, deletes } = handle.dirty();
  return { ...result, upserts, deletes };
}
