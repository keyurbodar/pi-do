import { add, branch, checkout, commit, init, log, readBlob, readCommit, remove, resolveRef, statusMatrix } from "isomorphic-git";

export const READ_SUBCOMMANDS: Record<string, true> = { status: true, log: true, diff: true, show: true };
export const WRITE_SUBCOMMANDS: Record<string, true> = {
  add: true,
  commit: true,
  rm: true,
  checkout: true,
  switch: true,
  init: true,
};

const DEFERRED: Record<string, true> = {
  branch: true,
  tag: true,
  reset: true,
  stash: true,
  merge: true,
  rebase: true,
  "cherry-pick": true,
  revert: true,
  mv: true,
  clean: true,
  restore: true,
};

export const READ_HINT =
  "allowed argv: status, log, diff, show, add, commit, rm, checkout, switch, init; forbidden: clone, fetch, push";

export class NotARepoError extends Error {
  constructor(readonly dir = "/") {
    super(`not a git repository: ${dir}`);
    this.name = "NotARepoError";
  }
}

export function notARepoBody(): { error: string; hint: string } {
  return {
    error: "not a git repository",
    hint: "upload a .git directory via PUT /workspaces/:id/files?path=.git/HEAD (then objects/ + refs/), or run git init",
  };
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

type UnlinkFn = (p: string) => Promise<void>;

function unlinkOf(fs: object): UnlinkFn | undefined {
  if (fs !== null && typeof fs === "object" && "promises" in fs) {
    const promises = fs.promises;
    if (promises !== null && typeof promises === "object" && "unlink" in promises) {
      const unlink = promises.unlink;
      if (typeof unlink === "function") {
        const fn: UnlinkFn = unlink as UnlinkFn;
        return fn;
      }
    }
  }
  return undefined;
}

async function runStatus(fs: object): Promise<GitReadResult> {
  let rows: Array<[string, number, number, number]>;
  try {
    rows = (await statusMatrix({ fs: fs as never, dir: "/" })) as Array<[string, number, number, number]>;
  } catch (e) {
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git status failed: ${errMsg(e)}`);
  }
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
  let entries: Array<{ oid: string; commit: { message: string } }>;
  try {
    entries = (await log({ fs: fs as never, dir: "/", ref, depth: 20 })) as Array<{
      oid: string;
      commit: { message: string };
    }>;
  } catch (e) {
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git log failed: ${errMsg(e)}`);
  }
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
  try {
    if (rest.length === 0) {
      const oid = await resolveRef({ fs: fs as never, dir: "/", ref: "HEAD" });
      const c = (await readCommit({ fs: fs as never, dir: "/", oid })) as {
        oid: string;
        commit: { message: string };
      };
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
    const c = (await readCommit({ fs: fs as never, dir: "/", oid })) as {
      oid: string;
      commit: { message: string };
    };
    return { stdout: `commit ${c.oid}\n\n${c.commit.message}`, commit: { oid: c.oid, message: c.commit.message } };
  } catch (e) {
    if (e instanceof NotARepoError) throw e;
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git show failed: ${errMsg(e)}`);
  }
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
  if (rest.length === 0) throw new Error("git add needs <path...>");
  const paths = rest.map((p) => stripLeading(p));
  for (const p of paths) {
    if (!p) throw new Error("git add needs <path...>");
  }
  try {
    for (const filepath of paths) {
      await add({ fs: fs as never, dir: "/", filepath });
    }
  } catch (e) {
    if (e instanceof NotARepoError) throw e;
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git add failed: ${errMsg(e)}`);
  }
  const files = paths.map((path) => ({ path, change: "A" }));
  return { stdout: files.map((f) => `${f.change} ${f.path}`).join("\n") + "\n", files };
}

async function runRm(fs: object, rest: string[]): Promise<GitReadResult> {
  if (rest.length === 0) throw new Error("git rm needs <path...>");
  const paths = rest.map((p) => stripLeading(p));
  for (const p of paths) {
    if (!p) throw new Error("git rm needs <path...>");
  }
  try {
    const unlink = unlinkOf(fs);
    for (const filepath of paths) {
      await remove({ fs: fs as never, dir: "/", filepath });
      try {
        await unlink?.(filepath);
      } catch {
      }
    }
  } catch (e) {
    if (e instanceof NotARepoError) throw e;
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git rm failed: ${errMsg(e)}`);
  }
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
  for (const p of filepaths) {
    if (!p) throw new Error("git commit needs <path...>: bad path");
  }
  try {
    for (const filepath of filepaths) {
      await add({ fs: fs as never, dir: "/", filepath });
    }
    const oid = (await commit({ fs: fs as never, dir: "/", message, author: AUTHOR })) as unknown as string;
    return { stdout: `${oid} ${message.split("\n")[0]}\n`, commit: { oid, message } };
  } catch (e) {
    if (e instanceof NotARepoError) throw e;
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git commit failed: ${errMsg(e)}`);
  }
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
  try {
    if (create) {
      await branch({ fs: fs as never, dir: "/", ref, checkout: true });
    } else {
      await checkout({ fs: fs as never, dir: "/", ref });
    }
  } catch (e) {
    if (e instanceof NotARepoError) throw e;
    if (isNotARepoCause(e)) throw new NotARepoError("/");
    throw new Error(`git ${sub} failed: ${errMsg(e)}`);
  }
  return { stdout: `${sub} ${ref}\n`, ref };
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
