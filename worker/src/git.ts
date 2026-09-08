import { add, branch, checkout, commit, init, log, readBlob, readCommit, remove, resolveRef, statusMatrix } from "isomorphic-git";

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

export const READ_SUBCOMMANDS: Record<string, true> = { status: true, log: true, diff: true, show: true };
export const WRITE_SUBCOMMANDS: Record<string, true> = { add: true, commit: true, rm: true, checkout: true, switch: true, init: true };
const DEFERRED: Record<string, true> = { branch: true, tag: true, reset: true, stash: true, merge: true, rebase: true, "cherry-pick": true, revert: true, mv: true, clean: true, restore: true };
export const READ_HINT = "allowed argv: status, log, diff, show, add, commit, rm, checkout, switch, init; forbidden: clone, fetch, push";

export class NotARepoError extends Error {
  constructor(readonly dir = "/") {
    super(`not a git repository: ${dir}`);
    this.name = "NotARepoError";
  }
}

export function notARepoBody(): { error: string; hint: string } {
  return { error: "not a git repository", hint: "upload a .git directory via PUT /workspaces/:id/files?path=.git/HEAD (then objects/ + refs/), or run git init" };
}

export function isNotARepoCause(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/Could not find (HEAD|refs\/)/.test(msg)) return true;
  const m = msg.toLowerCase();
  return m.includes(".git") && (m.includes("enoent") || m.includes("could not find") || m.includes("does not exist") || m.includes("not found"));
}

export type Gate =
  | { ok: true; sub: string; rest: string[] }
  | { ok: false; status: 403 | 501; error: string; hint: string };

export function gateArgv(argv: unknown): Gate {
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
  if (READ_SUBCOMMANDS[sub] === true) return { ok: true, sub, rest: rest as string[] };
  if (WRITE_SUBCOMMANDS[sub] === true) return { ok: true, sub, rest: rest as string[] };
  if (DEFERRED[sub] === true) {
    return { ok: false, status: 501, error: `git ${sub} not yet supported`, hint: READ_HINT };
  }
  return { ok: false, status: 403, error: `git ${sub} forbidden`, hint: READ_HINT };
}

export interface GitReadResult {
  stdout: string;
  files?: Array<{ path: string; index?: string; worktree?: string; change?: string }>;
  commits?: Array<{ oid: string; message: string }>;
  commit?: { oid: string; message: string };
  ref?: string;
}

const AUTHOR = { name: "pi-do", email: "pi-do@local" };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

function stripLeading(p: string): string {
  return p.replace(/^\/+/, "");
}

function cleanPaths(rest: string[], need: string): string[] {
  if (rest.length === 0) throw new Error(need);
  const paths = rest.map((p) => stripLeading(p));
  for (const p of paths) if (!p) throw new Error(need);
  return paths;
}

async function guard<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotARepoError) throw e;
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git ${sub} failed: ${errMsg(e)}`);
  }
}

function unlinkOf(fs: object): ((p: string) => Promise<void>) | undefined {
  const u = (fs as { promises?: { unlink?: unknown } }).promises?.unlink;
  return typeof u === "function" ? (u as (p: string) => Promise<void>) : undefined;
}

function indexCode(head: number, stage: number): " " | "A" | "M" | "D" {
  if (head === 0 && stage !== 0) return "A";
  if (head === 1 && stage === 0) return "D";
  if (stage === 2 || stage === 3) return "M";
  return " ";
}

function worktreeCode(head: number, workdir: number, stage: number): " " | "M" | "D" | "?" {
  if (head === 0 && workdir === 2 && stage === 0) return "?";
  if (workdir === 0 && head === 1) return "D";
  if (workdir === 2) return "M";
  return " ";
}

async function runStatus(fs: object): Promise<GitReadResult> {
  const rows = (await guard("status", () => statusMatrix({ fs: fs as never, dir: "/" }))) as Array<[string, number, number, number]>;
  const files: GitReadResult["files"] = [];
  const lines: string[] = [];
  for (const [path, head, workdir, stage] of rows) {
    if (head === 1 && workdir === 1 && stage === 1) continue;
    const index = indexCode(head, stage);
    const worktree = worktreeCode(head, workdir, stage);
    if (index === " " && worktree === " ") continue;
    files.push({ path, index, worktree });
    lines.push(`${index}${worktree} ${path}`);
  }
  return { stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""), files };
}

async function runLog(fs: object, rest: string[]): Promise<GitReadResult> {
  const ref = rest[0] ?? "HEAD";
  const entries = (await guard("log", () => log({ fs: fs as never, dir: "/", ref, depth: 20 }))) as Array<{ oid: string; commit: { message: string } }>;
  const commits = entries.map((e) => ({ oid: e.oid, message: e.commit.message }));
  const stdout = commits.map((c) => `${c.oid.slice(0, 7)} ${c.message.split("\n")[0]}`).join("\n") + (commits.length > 0 ? "\n" : "");
  return { stdout, commits };
}

async function runDiff(fs: object): Promise<GitReadResult> {
  const base = await runStatus(fs);
  const files = (base.files ?? []).map((f) => {
    const change = f.index === "A" || f.worktree === "?" ? "A" : f.worktree === "D" || f.index === "D" ? "D" : "M";
    return { path: f.path, change };
  });
  const stdout = files.map((f) => `${f.change} ${f.path}`).join("\n") + (files.length > 0 ? "\n" : "");
  return { stdout, files };
}

async function runShow(fs: object, rest: string[]): Promise<GitReadResult> {
  return guard("show", async () => {
    if (rest.length === 0) {
      const oid = await resolveRef({ fs: fs as never, dir: "/", ref: "HEAD" });
      const c = (await readCommit({ fs: fs as never, dir: "/", oid })) as { oid: string; commit: { message: string } };
      return { stdout: `commit ${c.oid}\n\n${c.commit.message}`, commit: { oid: c.oid, message: c.commit.message } };
    }
    const arg = rest[0];
    const colon = arg.indexOf(":");
    if (colon !== -1) {
      const ref = arg.slice(0, colon) || "HEAD";
      const filepath = arg.slice(colon + 1);
      if (!filepath) throw new Error(`bad show arg '${arg}': want <ref>:<path>`);
      const oid = await resolveRef({ fs: fs as never, dir: "/", ref });
      const blob = (await readBlob({ fs: fs as never, dir: "/", oid, filepath })) as { blob: Uint8Array };
      return { stdout: new TextDecoder().decode(blob.blob) };
    }
    let oid: string;
    try {
      oid = await resolveRef({ fs: fs as never, dir: "/", ref: arg });
    } catch {
      oid = arg;
    }
    const c = (await readCommit({ fs: fs as never, dir: "/", oid })) as { oid: string; commit: { message: string } };
    return { stdout: `commit ${c.oid}\n\n${c.commit.message}`, commit: { oid: c.oid, message: c.commit.message } };
  });
}

export async function runGitRead(fs: object, sub: string, rest: string[]): Promise<GitReadResult> {
  switch (sub) {
    case "status":
      return runStatus(fs);
    case "log":
      return runLog(fs, rest);
    case "diff":
      return runDiff(fs);
    case "show":
      return runShow(fs, rest);
    default:
      throw new Error(`git ${sub} forbidden`);
  }
}

async function runAdd(fs: object, rest: string[]): Promise<GitReadResult> {
  const paths = cleanPaths(rest, "git add needs <path...>");
  await guard("add", async () => {
    for (const filepath of paths) await add({ fs: fs as never, dir: "/", filepath });
  });
  const files = paths.map((path) => ({ path, change: "A" }));
  return { stdout: files.map((f) => `${f.change} ${f.path}`).join("\n") + "\n", files };
}

async function runRm(fs: object, rest: string[]): Promise<GitReadResult> {
  const paths = cleanPaths(rest, "git rm needs <path...>");
  await guard("rm", async () => {
    const unlink = unlinkOf(fs);
    for (const filepath of paths) {
      await remove({ fs: fs as never, dir: "/", filepath });
      try {
        await unlink?.(filepath);
      } catch {
      }
    }
  });
  const files = paths.map((path) => ({ path, change: "D" }));
  return { stdout: files.map((f) => `${f.change} ${f.path}`).join("\n") + "\n", files };
}

async function runCommit(fs: object, rest: string[]): Promise<GitReadResult> {
  let message: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-m" || arg === "--message") {
      const value = rest[i + 1];
      if (value === undefined) throw new Error("git commit needs -m <message>");
      message = value;
      i++;
    } else if (arg === "--") {
      paths.push(...rest.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`git commit needs -m <message>: unknown flag '${arg}'`);
    } else {
      paths.push(arg);
    }
  }
  if (message === undefined || message.length === 0) throw new Error("git commit needs -m <message>");
  const filepaths = paths.map((p) => stripLeading(p));
  for (const p of filepaths) if (!p) throw new Error("git commit needs <path...>: bad path");
  const msg: string = message;
  return guard("commit", async () => {
    for (const filepath of filepaths) await add({ fs: fs as never, dir: "/", filepath });
    const oid = (await commit({ fs: fs as never, dir: "/", message: msg, author: AUTHOR })) as unknown as string;
    return { stdout: `${oid} ${msg.split("\n")[0]}\n`, commit: { oid, message: msg } };
  });
}

async function runCheckout(fs: object, sub: string, rest: string[]): Promise<GitReadResult> {
  let ref: string | undefined;
  let create = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-b" || arg === "-c") {
      const value = rest[i + 1];
      if (value === undefined) throw new Error(`git ${sub} needs <ref> or -b <new-branch>`);
      ref = stripLeading(value);
      create = true;
      i++;
    } else if (arg.startsWith("-")) {
      throw new Error(`git ${sub} needs <ref> or -b <new-branch>: unknown flag '${arg}'`);
    } else {
      if (ref !== undefined) throw new Error(`git ${sub} needs <ref> or -b <new-branch>: too many args`);
      ref = arg;
    }
  }
  if (ref === undefined || ref === "") throw new Error(`git ${sub} needs <ref> or -b <new-branch>`);
  const target: string = ref;
  await guard(sub, async () => {
    if (create) await branch({ fs: fs as never, dir: "/", ref: target, checkout: true });
    else await checkout({ fs: fs as never, dir: "/", ref: target });
  });
  return { stdout: `${sub} ${target}\n`, ref: target };
}

async function runInit(fs: object, rest: string[]): Promise<GitReadResult> {
  let defaultBranch = "main";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-b" || arg === "--default-branch") {
      const value = rest[i + 1];
      if (value === undefined || value === "") throw new Error("git init takes [] or [-b|--default-branch <branch>]");
      defaultBranch = stripLeading(value) || "main";
      i++;
    } else if (arg.startsWith("-")) {
      throw new Error("git init takes [] or [-b|--default-branch <branch>]: unknown flag");
    } else {
      throw new Error("git init takes [] or [-b|--default-branch <branch>]");
    }
  }
  try {
    await init({ fs: fs as never, dir: "/", defaultBranch });
  } catch (e) {
    throw new Error(`git init failed: ${errMsg(e)}`);
  }
  return { stdout: `init ${defaultBranch}\n`, ref: defaultBranch };
}

export async function runGitWrite(fs: object, sub: string, rest: string[]): Promise<GitReadResult> {
  switch (sub) {
    case "add":
      return runAdd(fs, rest);
    case "rm":
      return runRm(fs, rest);
    case "commit":
      return runCommit(fs, rest);
    case "checkout":
    case "switch":
      return runCheckout(fs, sub, rest);
    case "init":
      return runInit(fs, rest);
    default:
      throw new Error(`git ${sub} forbidden`);
  }
}
