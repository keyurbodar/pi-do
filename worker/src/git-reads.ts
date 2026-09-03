// git-reads.ts — narrow argv dispatcher for PR05.
//
// Reuses the argv-dispatcher shape from refs/computer/src/git/cli.ts (single
// `runGitCli`-style switch over argv[0] onto dependency-injected cores), not
// the code: the allowlist gate runs before anything executes, reads go through
// isomorphic-git over the workspace fs adapter, writes never execute.

import { log, readBlob, readCommit, resolveRef, statusMatrix } from "isomorphic-git";
export const READ_SUBCOMMANDS: Record<string, true> = { status: true, log: true, diff: true, show: true };

// Local writes with no network side effects. Deferred to a later PR; they
// answer 501 so callers can distinguish "forbidden" (403) from "not yet" (501).
const DEFERRED_WRITES: Record<string, true> = {
  add: true,
  commit: true,
  rm: true,
  checkout: true,
  switch: true,
  branch: true,
  tag: true,
  reset: true,
  stash: true,
  merge: true,
  rebase: true,
  "cherry-pick": true,
  revert: true,
  init: true,
  mv: true,
  clean: true,
  restore: true,
};

export const READ_HINT = "allowed argv: status, log, diff, show; writes are deferred";

export class NotARepoError extends Error {
  constructor(readonly dir = "/") {
    super(`not a git repository: ${dir}`);
    this.name = "NotARepoError";
  }
}

export function notARepoBody(): { error: string; hint: string } {
  return {
    error: "not a git repository",
    hint: "upload a .git directory via PUT /workspaces/:id/files?path=.git/HEAD (then objects/ + refs/), or wait for git init (lands after PR05)",
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
  if (DEFERRED_WRITES[sub] === true) {
    return { ok: false, status: 501, error: `git ${sub} deferred`, hint: `writes land after PR05; ${READ_HINT}` };
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
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
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
