// exec.test.mjs — stale-handle conformance for the shell worker: pty handles
// live only in isolate memory, so a fresh import (empty maps) is the
// post-restart state and every unknown handle must fail loud naming it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// shell-exec.ts imports "cloudflare:workers" (unresolvable in plain node) and
// extensionless "./async-util" (unresolvable to the ESM loader), so shim both
// through a loader hook written to tmpdir at runtime — no repo helper needed.
const dir = mkdtempSync(join(tmpdir(), "pi-do-exec-test-"));
const stubPath = join(dir, "cloudflare-workers-stub.mjs");
writeFileSync(stubPath, "export class WorkerEntrypoint {}\n");
writeFileSync(
  join(dir, "hooks.mjs"),
  `const stubUrl = ${JSON.stringify(pathToFileURL(stubPath).href)};\n` +
    `const asyncUtilUrl = ${JSON.stringify(new URL("../src/async-util.ts", import.meta.url).href)};\n` +
    `export async function resolve(specifier, context, next) {\n` +
    `  if (specifier === "cloudflare:workers") return { url: stubUrl, shortCircuit: true };\n` +
    `  if (specifier === "./async-util" && context.parentURL.endsWith("/worker/src/shell-exec.ts")) return { url: asyncUtilUrl, shortCircuit: true };\n` +
    `  return next(specifier, context);\n` +
    `}\n`,
);
register(pathToFileURL(join(dir, "hooks.mjs")));

const { ShellWorker, StaleHandleError } = await import("../src/shell-exec.ts");

test("kill on a stale session handle fails loud with the restart named", async () => {
  await assert.rejects(new ShellWorker().kill({ sid: "sess-stale" }), (e) => {
    assert.ok(e instanceof StaleHandleError, `want StaleHandleError, got ${e?.constructor?.name}`);
    assert.equal(e.code, "stale-exec-session");
    // Legacy prefix intact: the routes match on it for their 404 path.
    assert.ok(e.message.startsWith("no such exec session: sess-stale"), e.message);
    assert.match(e.message, /restart/);
    assert.match(e.hint, /create the session/);
    return true;
  });
});

test("bgRead on a stale handle fails loud with the restart named", async () => {
  await assert.rejects(new ShellWorker().bgRead({ handle: "bg-stale" }), (e) => {
    assert.ok(e instanceof StaleHandleError, `want StaleHandleError, got ${e?.constructor?.name}`);
    assert.equal(e.code, "stale-bg-process");
    assert.ok(e.message.startsWith("no such bg process: bg-stale"), e.message);
    assert.match(e.message, /restart/);
    assert.match(e.hint, /POST \/workspaces\/:id\/bg/);
    return true;
  });
});

test("bgKill on a stale handle fails loud with the restart named", async () => {
  await assert.rejects(new ShellWorker().bgKill({ handle: "bg-stale" }), (e) => {
    assert.ok(e instanceof StaleHandleError, `want StaleHandleError, got ${e?.constructor?.name}`);
    assert.equal(e.code, "stale-bg-process");
    assert.ok(e.message.startsWith("no such bg process: bg-stale"), e.message);
    assert.match(e.message, /restart/);
    assert.match(e.hint, /POST \/workspaces\/:id\/bg/);
    return true;
  });
});

test("dispose stays idempotent on unknown handles (routes call it without a catch)", async () => {
  assert.deepEqual(await new ShellWorker().dispose({ sid: "sess-stale" }), {
    disposed: true,
    stdoutBytes: 0,
    stderrBytes: 0,
  });
});

test("neighboring validation errors are untouched", async () => {
  const worker = new ShellWorker();
  await assert.rejects(worker.kill({ sid: "" }), /kill needs a session id string/);
  await assert.rejects(worker.bgRead({ handle: "" }), /bg needs a handle string/);
  await assert.rejects(worker.bgKill({ handle: "" }), /bg needs a handle string/);
});
