// tools-harness.mjs — drives the shipped pi-cf tool modules against live
// workspace bytes. Seeds come from the real server over HTTP (files get),
// the store mimics the DO files table, the shell is the same just-bash
// interpreter the worker runs, and every tool is the exact module workerd
// executes. Usage: node verify/tools-harness.mjs BASE WS OUT search|ready [NEEDLE]
// Exit nonzero on the first gap, PASS lines on stdout per check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bash } from "just-bash";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ComputerExecutionEnv } = await import("../packages/pi-cf/src/env.ts");
const { findTool, grepTool } = await import("../packages/pi-cf/src/search-tools.ts");
const { diagnosticsTool, testTool, pmTool } = await import("../packages/pi-cf/src/dev-tools.ts");
const { editTool } = await import("../packages/pi-cf/src/tools.ts");
const [BASE, WS, OUT, SUITE, NEEDLE] = process.argv.slice(2);
if (!BASE || !WS || !OUT || (SUITE !== "search" && SUITE !== "ready")) {
  console.error("usage: node verify/tools-harness.mjs BASE WS OUT search|ready [NEEDLE]");
  process.exit(2);
}

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function eq(step, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(step, b, a);
}

function has(step, got, want) {
  if (typeof got !== "string" || !got.includes(want)) fail(step, `output containing ${want}`, got);
}

function cli(...args) {
  return execFileSync("node", [join(ROOT, "cli/bin/pi-do.mjs"), ...args], { encoding: "utf8" });
}

function liveBytes(path) {
  const dest = join(OUT, "blob-" + path.replaceAll("/", "_"));
  cli("files", "get", "--ws", WS, "--path", path, "--base", BASE, "--out", dest);
  return new Uint8Array(readFileSync(dest));
}

function liveStore(paths) {
  const m = new Map();
  for (const p of paths) m.set(p, liveBytes(p));
  return {
    put: (ws, path, body) => {
      const buf = Uint8Array.from(body);
      m.set(path, buf);
      return buf.byteLength;
    },
    get: (ws, path) => m.get(path),
    list: (ws, dir) =>
      [...m.keys()]
        .filter((p) => p.startsWith(dir))
        .map((p) => ({ path: p, bytes: m.get(p).length }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    exists: (ws, path) => m.has(path),
    remove: (ws, path) => m.delete(path),
  };
}

function liveShell() {
  return {
    exec: async ({ command }) => {
      const bash = new Bash({ cwd: "/workspace", defenseInDepth: { enabled: false } });
      try {
        const r = await bash.exec(command, { cwd: "/workspace" });
        return { stdout: r.stdout, stderr: r.stderr, exit: r.exitCode, timedOut: false };
      } catch (e) {
        return { stdout: "", stderr: `${e instanceof Error ? e.message : String(e)}\n`, exit: 1, timedOut: false };
      }
    },
  };
}

function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

async function run(tool, env, params) {
  try {
    return { ok: true, out: textOf(await tool.execute("harness", params, undefined, undefined, { env })) };
  } catch (e) {
    return { ok: false, out: `${e?.error ?? e}: ${e?.hint ?? ""}` };
  }
}

if (SUITE === "search") {
  const env = new ComputerExecutionEnv(
    liveStore(["verify-search/src/app.ts", "verify-search/src/util.ts", "verify-search/README.md", "verify-search/blob.bin"]),
    WS,
  );
  const ranked = await run(findTool, env, { pattern: "*.ts", path: "verify-search" });
  eq("find-ranked", ranked.out, "verify-search/src/app.ts\nverify-search/src/util.ts");
  console.log("PASS search-find-ranked");
  const sub = await run(findTool, env, { pattern: "search" });
  eq(
    "find-substring",
    sub.out,
    "verify-search/README.md\nverify-search/blob.bin\nverify-search/src/app.ts\nverify-search/src/util.ts",
  );
  console.log("PASS search-find-substring");
  const g = await run(grepTool, env, { pattern: NEEDLE, path: "verify-search" });
  if (!g.ok) fail("grep-ok", "success", g.out);
  has("grep-match", g.out, `verify-search/src/app.ts:1: export const spot = "${NEEDLE}";`);
  has("grep-skip", g.out, "skipped non-UTF8: verify-search/blob.bin");
  console.log("PASS search-grep-match-skip");
  const trav = await run(grepTool, env, { pattern: "x", path: "../escape" });
  if (trav.ok) fail("grep-traversal", "throw", trav.out);
  has("grep-traversal", trav.out, "path escapes workspace");
  console.log("PASS search-grep-traversal-closed");
} else {
  const env = new ComputerExecutionEnv(
    liveStore(["verify-ready/app.ts", "verify-ready/fail.sh", "package.json", "package-lock.json"]),
    WS,
    liveShell(),
  );
  const clean = await run(diagnosticsTool, env, { path: "verify-ready/app.ts" });
  eq("diag-clean", clean.out, "(no issues in 1 file)");
  console.log("PASS ready-diagnostics-clean");
  const brk = await run(editTool, env, {
    path: "verify-ready/app.ts",
    edits: [{ oldText: "  return a + b;\n}", newText: "  return a + b;" }],
  });
  if (!brk.ok) fail("edit-break", "success", brk.out);
  const diag = await run(diagnosticsTool, env, { path: "verify-ready/app.ts" });
  if (!diag.ok) fail("diag-broken", "success", diag.out);
  has("diag-broken", diag.out, 'verify-ready/app.ts:1: unclosed "{" opened at line 1');
  console.log("PASS ready-edit-break-diagnostics");
  const t = await run(testTool, env, { file: "verify-ready/fail.sh" });
  if (!t.ok) fail("test-fail", "success", t.out);
  has("test-fail", t.out, "FAIL verify-ready/fail.sh (exit 1)");
  has("test-fail", t.out, "prove-fail-marker");
  console.log("PASS ready-test-fail-output");
  const pm = await run(pmTool, env, { action: "run", script: "test" });
  if (!pm.ok) fail("pm-run", "success", pm.out);
  if (!/^run \(exit \d+, lockfile: package-lock\.json\)/.test(pm.out)) {
    fail("pm-run", "structured lockfile head", pm.out);
  }
  console.log("PASS ready-pm-lockfile-structured");
  const unknown = await run(pmTool, env, { action: "run", script: "nope" });
  if (unknown.ok) fail("pm-unknown", "throw", unknown.out);
  has("pm-unknown", unknown.out, "unknown script: nope");
  console.log("PASS ready-pm-unknown-script-closed");
}
console.log(`PASS harness-${SUITE}`);
