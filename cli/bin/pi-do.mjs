#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

// Large stdout past the 64KB pipe buffer was lost when process.exit(0) cut
// the drain short (entries --all on long sessions). Success paths set exitCode
// and return so natural exit drains; the socket path below cannot rely on the
// loop draining (stdin stays open), so it exits through drainExit instead.
const realExit = process.exit.bind(process);
function drainExit(code) {
  const c = code ?? 0;
  if (c !== 0) realExit(c);
  else {
    process.exitCode = 0;
    try {
      process.stdout.write("", () => realExit(0));
    } catch {
      realExit(0);
    }
  }
}
const DEFAULT_BASE = "http://127.0.0.1:8787";
const T = (t, u, ...b) => `${t}\nusage: ${u}\n${b.length ? `${b.join("\n")}\n` : ""}`;
const HELP = {
  root: `pi-do — front door for the pi-do worker
usage:
  pi-do [--base URL] [--json] <command> [options]
commands:
  doctor | workspace create | session create | files put|get|ls|rm | exec | git
  run | claim | model | thinking | models | settings | entries | meta
  routines list|create|delete | inbox list|send | compact | archive | stream
flags: --base URL (default ${DEFAULT_BASE})  --json  --help, -h
examples:
  pi-do doctor
  pi-do workspace create
  pi-do files put --ws <id> --path hello.txt --body "hi"
  pi-do exec --ws <id> --command "echo hi"
`,
  doctor: T("pi-do doctor — check the worker is listening", "pi-do doctor [--base URL] [--json]", "Any HTTP response counts as listening (exit 0); connection failure is absent (exit 2)."),
  workspace: T("pi-do workspace — manage workspaces", "pi-do workspace create [--base URL] [--json]"),
  "workspace:create": T("pi-do workspace create — create a workspace", "pi-do workspace create [--base URL] [--json]", `POSTs /workspaces. Stdout is "workspace <id>" (raw JSON with --json).`),
  session: T("pi-do session — manage sessions", "pi-do session create --ws WS [--retention short|long] [--cwd D] [--base URL] [--json]"),
  "session:create": T("pi-do session create — mint a session [--backstory T] in a workspace", "pi-do session create --ws WS [--retention short|long] [--cwd D] [--base URL] [--json]", `POSTs /workspaces/:id/sessions with {retention, cwd}. Stdout is "session <id>" (raw JSON with --json).`),
  claim: T("pi-do claim — rotate the owner fence via revision CAS", "pi-do claim --ws WS --sid SID --fence F --expected N [--base URL] [--json]", "Wrong fence is 403, stale expected is 409. Success rotates fence and bumps revision."),
  run: T("pi-do run — one headless harness turn in a session", "pi-do run --ws WS --sid SID --prompt T [--plan] [--model provider/id] [--thinking L] [--fence F --expected N] [--base URL] [--json]", "Without --json stdout is the result text; with --json stdout is the raw server JSON. With --plan the turn is read-only: every write tool fails closed."),
  model: T("pi-do model — switch the session model mid-session", "pi-do model --ws WS --sid SID --model provider/id [--fence F --expected N] [--base URL] [--json]"),
  thinking: T("pi-do thinking — switch the session thinking level", "pi-do thinking --ws WS --sid SID --level L [--fence F --expected N] [--base URL] [--json]"),
  models: T("pi-do models — list catalog models with context windows", "pi-do models [--provider P] [--base URL] [--json]"),
  settings: T("pi-do settings — workspace default model triple for session mint", "pi-do settings --ws WS [--model provider/id] [--level L] [--base URL] [--json]", "No --model/--level reads the defaults (GET); with either it stores them (PUT)."),
  git: T("pi-do git — full git over a session (status, commit, branch, clone https, push, ...)", "pi-do git --ws WS --sid SID [--base URL] [--json] <argv...>", "POSTs {argv} to /workspaces/:id/sessions/:sid/git."),
  files: T("pi-do files — read/write/list/remove workspace files", "pi-do files put|get|ls|rm --ws WS [options]"),
  "files:put": T("pi-do files put — upload raw bytes to a workspace file", "pi-do files put --ws WS --path P (--body STR | --body-file F | piped stdin) [--base URL] [--json]"),
  "files:get": T("pi-do files get — download raw bytes of a workspace file", "pi-do files get --ws WS --path P [--out F] [--base URL] [--json]", "Stdout is the raw bytes (or nothing with --out)."),
  "files:ls": T("pi-do files ls — list workspace file entries", "pi-do files ls --ws WS [--path DIR] [--base URL] [--json]"),
  "files:rm": T("pi-do files rm — delete a workspace file or directory tree", "pi-do files rm --ws WS --path P [--recursive] [--base URL] [--json]"),
  exec: T("pi-do exec — run a one-off shell command in a workspace", "pi-do exec --ws WS --command CMD [--cwd D] [--base URL] [--json]"),
  entries: T("pi-do entries — ordered replay slice of persisted session entries", "pi-do entries --ws WS --sid SID [--after N] [--limit L] [--all] [--base URL] [--json]", "--all pages gaplessly and prints every entry (JSON mode prints one merged payload)."),
  meta: T("pi-do meta — resume cursor for a session", "pi-do meta --ws WS --sid SID [--system-prompt] [--base URL] [--json]"),
  compact: T("pi-do compact — summarize old entries and archive the originals", "pi-do compact --ws WS --sid SID [--base URL] [--json]"),
  archive: T("pi-do archive — re-read one paginated cold-storage page", "pi-do archive --ws WS --sid SID [--page N] [--base URL] [--json]"),
  inbox: T("pi-do inbox — durable peer messaging between sessions", "pi-do inbox list|send --ws WS --sid SID [options] [--base URL] [--json]"),
  routines: T("pi-do routines — scheduled durable turns on a session", "pi-do routines list|create|delete --ws WS --sid SID [options] [--base URL] [--json]"),
  "routines:list": T("pi-do routines list — every routine in the session, active first", "pi-do routines list --ws WS --sid SID [--base URL] [--json]"),
  "routines:create": T("pi-do routines create — schedule a prompt as a durable turn", "pi-do routines create --ws WS --sid SID --kind once|interval|weekly --spec S --prompt T [--expire-at ISO] [--max-runs N] [--request-id R] [--base URL] [--json]", `Spec: ISO timestamp (once), seconds >= 60 (interval), weekday:HH:MM like mon:09:30 (weekly). Stdout is "routine <id>".`),
  "routines:delete": T("pi-do routines delete — remove one routine", "pi-do routines delete --ws WS --sid SID --id ROUTINE [--base URL] [--json]"),
  inbox: T("pi-do inbox — durable peer messaging between sessions", "pi-do inbox list|send --ws WS --sid SID [options] [--base URL] [--json]"),
  "inbox:list": T("pi-do inbox list — messages to or from the session", "pi-do inbox list --ws WS --sid SID [--thread T] [--all] [--base URL] [--json]"),
  "inbox:send": T("pi-do inbox send — deliver a durable message to another session", "pi-do inbox send --ws WS --sid SID --to SESSION --body T [--thread T] [--request-id R] [--wait] [--timeout S] [--base URL] [--json]", `An unknown --to materializes a new named session on first message. --wait long-polls until the recipient's consuming turn completes (capped at 120s). Stdout is "inbox <id>".`),
  stream: T("pi-do stream — live turns over a WebSocket", "pi-do stream --ws WS --sid SID [--fence F --expected N] [--base URL] [--json]", `Stdin lines are prompts ("/abort", "/steer TEXT", or {raw JSON}); frames print on stdout.`, "Needs node >= 22 for the global WebSocket."),
};

const R = {
  json(o) { process.stdout.write(`${JSON.stringify(o)}\n`); },
  note(t) { process.stderr.write(`${t}\n`); },
  out(t) { process.stdout.write(t.endsWith("\n") ? t : `${t}\n`); },
  show(json, data, text, hint) {
    if (json) { R.json(data); if (hint !== undefined) R.note(hint); }
    else if (text) R.out(text);
  },
  done(json, data, text, hint) { R.show(json, data, text, hint); process.exitCode = 0; return; },
  entries(es) { for (const e of es) process.stdout.write(`${e.cursor} ${e.type} ${e.body}\n`); },
  list(items, fn, empty) { return items.length === 0 ? empty : items.map(fn).join("\n"); },
  settings(s) { return `model ${s.modelProvider ?? "null"}/${s.modelId ?? "null"} thinking ${s.thinkingLevel ?? "null"}`; },
  usage(u) {
    const num = (n) => Number(n).toLocaleString("en-US");
    const parts = [`in ${num(u.inTokens ?? 0)}`, `out ${num(u.outTokens ?? 0)}`];
    if ((u.cacheRead ?? 0) > 0) parts.push(`cache ${num(u.cacheRead)}`);
    const ms = u.elapsedMs ?? 0;
    parts.push(`t ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}`);
    if (u.tokensPerSec !== null && u.tokensPerSec !== undefined) parts.push(`${u.tokensPerSec.toFixed(1)}/s`);
    const denom = (u.inTokens ?? 0) + (u.cacheRead ?? 0);
    const hit = denom > 0 ? ((u.cacheRead ?? 0) / denom) * 100 : 0;
    parts.push(`CH${hit.toFixed(1)}%`);
    parts.push(`ret ${u.retention ?? "short"}`);
    return parts.join("  ");
  },
  frame(f, json) {
    if (json) return R.json(f);
    if (f.entry) return process.stdout.write(`entry ${f.entry.cursor} ${f.entry.type} ${f.entry.body}\n`);
    if (f.done) {
      if (typeof f.fence === "string") process.stdout.write(`done fence=${f.fence} revision=${f.revision}\n`);
      else process.stdout.write(`done\n`);
      if (f.result) process.stdout.write(f.result.endsWith("\n") ? f.result : `${f.result}\n`);
      if (f.usage) process.stdout.write(`usage ${R.usage(f.usage)}\n`);
      if (f.halt) process.stdout.write(`halted: ${f.halt.reason ?? f.halt} - result may be incomplete\n`);
      return;
    }
    process.stdout.write(`${f.aborted ? `aborted run=${f.runId ?? ""}` : f.busy ? `busy ${f.hint ?? ""}` : f.ping ? `ping` : f.error ? `error ${f.error} ${f.hint ?? ""}` : f.live?.kind === "toolUpdate" ? `tool ${f.live.id} ${f.live.text}` : f.message !== undefined ? `message ${JSON.stringify(f.message)}` : f.tool !== undefined ? `tool ${JSON.stringify(f.tool)}` : f.agent !== undefined ? `agent ${JSON.stringify(f.agent)}` : JSON.stringify(f)}\n`);
  },
};

function failUsage(message, help) {
  process.stderr.write(`pi-do: ${message}\n`);
  if (help) process.stderr.write(`\n${help}`);
  else process.stderr.write(`Run 'pi-do --help' for usage.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { base: DEFAULT_BASE, json: false, help: false, all: false };
  const keys = {
    "--base": "base", "--ws": "ws", "--workspace": "ws", "--sid": "sid", "--session": "sid",
    "--path": "path", "--body": "body", "--body-file": "bodyFile", "--out": "out", "-o": "out",
    "--command": "command", "--cwd": "cwd", "--fence": "fence", "--expected": "expected", "--prompt": "prompt",
    "--after": "after", "--limit": "limit", "--page": "page", "--model": "model", "--level": "level", "--kind": "kind", "--spec": "spec", "--expire-at": "expireAt", "--max-runs": "maxRuns", "--request-id": "requestId", "--id": "id", "--to": "to", "--thread": "thread", "--backstory": "backstory", "--system-prompt": "systemPrompt", "--timeout": "timeout",
    "--thinking": "level", "--provider": "provider", "--retention": "retention",
  };
  const flags = { "--json": "json", "--help": "help", "-h": "help", "--all": "all", "--recursive": "recursive", "--plan": "plan", "--wait": "wait", "--system-prompt": "systemPrompt" };
  const positionals = [];
  let baseSet = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (Object.hasOwn(flags, tok)) { opts[flags[tok]] = true; continue; }
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const key = keys[flag];
    if (key === undefined) { positionals.push(tok); continue; }
    const v = eq !== -1 ? tok.slice(eq + 1) : argv[i + 1];
    if (eq === -1) {
      if (v === undefined || v.startsWith("--")) failUsage(`flag ${flag} needs a value.`);
      i++;
    }
    opts[key] = v;
    if (key === "base") baseSet = true;
  }
  if (baseSet && opts.base === "") failUsage(`flag --base needs a value.`);
  return { opts, positionals };
}

function stripBase(base) {
  return base.replace(/\/+$/, "");
}
function wsUrl(base, ws, rest = "") {
  return `${stripBase(base)}/workspaces/${encodeURIComponent(ws)}${rest}`;
}
function sessUrl(base, ws, sid, rest = "") {
  return `${wsUrl(base, ws)}/sessions/${encodeURIComponent(sid)}${rest}`;
}
function splitProviderId(raw, message, help) {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) failUsage(message, help);
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}
function need(val, message, help) {
  if (val === undefined || val === null || val === false || val === "") failUsage(message, help);
}
function needWsSid(opts, what, help) {
  need(opts.ws, `${what} needs --ws WS.`, help);
  need(opts.sid, `${what} needs --sid SID.`, help);
}
function needNo(opts, ks, message, help) {
  if (ks.some((k) => opts[k] !== undefined)) failUsage(message, help);
}
function checkedUint(raw, message, help, min = 0, max = Number.POSITIVE_INFINITY) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) failUsage(message, help);
  return n;
}
function fenceExpected(opts, what, help) {
  if ((opts.fence !== undefined) !== (opts.expected !== undefined))
    failUsage(`${what} needs both --fence F and --expected N together, or neither.`, help);
  if (opts.expected === undefined) return undefined;
  return checkedUint(opts.expected, `${what} needs --expected N (a non-negative integer).`, help);
}
async function doFetch(base, json, url, init) {
  const secs = Number(process.env.PI_DO_TIMEOUT_SECS || 300);
  const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 300000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const timedOut = e && (e.name === "AbortError" || /timed out/.test(e.message || ""));
    if (timedOut) R.note(`error: no response in ${Math.round(ms / 1000)}s (override: PI_DO_TIMEOUT_SECS=N)`);
    else R.note(`error: cannot reach server at ${base}`);
    R.note(`hint: the turn may still complete server-side; check entries before retrying`);
    if (!timedOut) R.note(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) R.json({ error: timedOut ? "request timed out" : "cannot reach server", base });
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const msg = parsed && typeof parsed.error === "string" ? parsed.error : `request failed (HTTP ${res.status})`;
    const hint = parsed && typeof parsed.hint === "string" ? parsed.hint : text.slice(0, 500);
    R.note(`error: ${msg}`);
    if (hint) R.note(`hint: ${hint}`);
    if (json) R.json(parsed ?? { error: msg, status: res.status });
    process.exit(1);
  }
  return res;
}
async function getJson(base, json, url) {
  return (await doFetch(base, json, url)).json();
}
async function postJson(base, json, url, payload, method = "POST") {
  const init = payload === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  return (await doFetch(base, json, url, init)).json();
}
function helpFor(cmd, sub) {
  const key = sub === undefined ? cmd : `${cmd}:${sub}`;
  return Object.hasOwn(HELP, key) ? HELP[key] : Object.hasOwn(HELP, cmd) ? HELP[cmd] : HELP.root;
}
async function readStdinBytes() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function resolvePutBody(opts) {
  if (opts.body !== undefined && opts.bodyFile !== undefined)
    failUsage(`--body and --body-file are mutually exclusive.`, HELP["files:put"]);
  if (opts.body !== undefined) return Buffer.from(opts.body, "utf8");
  if (opts.bodyFile !== undefined) {
    try { return await readFile(opts.bodyFile); } catch (e) { failUsage(`cannot read --body-file ${opts.bodyFile}: ${e.message}.`); }
  }
  const piped = await readStdinBytes();
  if (piped === null) failUsage(`need --body STR, --body-file F, or piped stdin bytes.`, HELP["files:put"]);
  return piped;
}
async function doDoctor(base, json) {
  let res;
  try {
    res = await fetch(`${stripBase(base)}/`);
  } catch (e) {
    R.note(`pi-do doctor: absent — no server listening at ${base} (is 'wrangler dev' running?).`); R.note(`detail: ${e.cause?.message ?? e.message}`);
    if (json) R.json({ ok: false, base, error: "absent" });
    process.exit(2);
  }
  if (json) R.json({ ok: true, base, status: res.status });
  R.note(`ok — server listening at ${base} (status ${res.status})`);
  process.exitCode = 0; return;
}
async function doWorkspaceCreate(base, json) {
  const data = await postJson(base, json, `${stripBase(base)}/workspaces`);
  R.done(json, data, `workspace ${data.workspaceId}`, `workspace ${data.workspaceId}`);
}
async function doSessionCreate(base, json, opts) {
  need(opts.ws, `session create needs --ws WS.`, HELP["session:create"]);
  if (opts.retention !== undefined && opts.retention !== "short" && opts.retention !== "long") failUsage(`session create needs --retention short|long.`, HELP["session:create"]);
  const payload = {};
  if (opts.retention !== undefined) payload.retention = opts.retention;
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  if (opts.backstory !== undefined) payload.backstory = opts.backstory;
  const data = await postJson(base, json, wsUrl(base, opts.ws, "/sessions"), Object.keys(payload).length > 0 ? payload : undefined);
  R.done(json, data, `session ${data.sessionId} ret ${data.retention ?? "short"}`, `session ${data.sessionId} ret ${data.retention ?? "short"}`);
}
async function doRun(base, json, opts) {
  needWsSid(opts, "run", HELP.run);
  if (opts.prompt === undefined) failUsage(`run needs --prompt T.`, HELP.run);
  const expected = fenceExpected(opts, "run", HELP.run);
  const payload = { prompt: opts.prompt };
  if (opts.plan === true) payload.plan = true;
  if (opts.fence !== undefined) { payload.fence = opts.fence; payload.expected = expected; }
  if (opts.model !== undefined) payload.model = splitProviderId(opts.model, `run needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, HELP.run);
  if (opts.level !== undefined) payload.thinking = opts.level;
  const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/run"), payload);
  const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
  const note = `run ok: ${calls.length} tool calls`;
  R.show(json, data, data.result, note);
  if (!json) {
    R.note(note);
    if (data.usage) R.note(`usage ${R.usage(data.usage)}`);
    if (data.halt) R.note(`halted: ${data.halt.reason ?? data.halt} - result may be incomplete`);
  }
  process.exitCode = 0; return;
}
async function doClaim(base, json, opts) {
  needWsSid(opts, "claim", HELP.claim);
  if (opts.fence === undefined) failUsage(`claim needs --fence F.`, HELP.claim);
  if (opts.expected === undefined) failUsage(`claim needs --expected N.`, HELP.claim);
  const expected = checkedUint(opts.expected, `claim needs --expected N (a non-negative integer).`, HELP.claim);
  const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/claim"), { fence: opts.fence, expected });
  R.done(json, data, `fence ${data.fence} revision ${data.revision}`, `claim ok: revision ${data.revision}`);
}
async function doModel(base, json, opts) {
  needWsSid(opts, "model", HELP.model);
  if (opts.model === undefined) failUsage(`model needs --model provider/id.`, HELP.model);
  const expected = fenceExpected(opts, "model", HELP.model);
  const { provider, id } = splitProviderId(opts.model, `model needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, HELP.model);
  const payload = { provider, id };
  if (opts.fence !== undefined) { payload.fence = opts.fence; payload.expected = expected; }
  const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/model"), payload);
  R.done(json, data, `model ${data.model.provider}/${data.model.id} revision ${data.revision}`, `model ok: ${data.model.provider}/${data.model.id} (revision ${data.revision})`);
}
async function doThinking(base, json, opts) {
  needWsSid(opts, "thinking", HELP.thinking);
  if (opts.level === undefined) failUsage(`thinking needs --level L.`, HELP.thinking);
  const expected = fenceExpected(opts, "thinking", HELP.thinking);
  const payload = { level: opts.level };
  if (opts.fence !== undefined) { payload.fence = opts.fence; payload.expected = expected; }
  const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/thinking"), payload);
  R.done(json, data, `thinking ${data.thinking} revision ${data.revision}`, `thinking ok: ${data.thinking} (revision ${data.revision})`);
}
async function doModels(base, json, opts) {
  let url = `${stripBase(base)}/models`;
  if (opts.provider !== undefined) url += `?provider=${encodeURIComponent(opts.provider)}`;
  const data = await getJson(base, json, url);
  const models = Array.isArray(data.models) ? data.models : [];
  R.done(json, data, R.list(models, (m) => `${m.provider}/${m.id} (ctx ${m.contextWindow})`, `(empty)`), `${models.length} models`);
}
async function doSettings(base, json, opts) {
  need(opts.ws, `settings needs --ws WS.`, HELP.settings);
  const url = wsUrl(base, opts.ws, "/settings");
  if (opts.model === undefined && opts.level === undefined) {
    const data = await getJson(base, json, url);
    R.done(json, data, R.settings(data.settings ?? {}), `settings shown`);
    return;
  }
  const patch = {};
  if (opts.model !== undefined) {
    const { provider, id } = splitProviderId(opts.model, `settings needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, HELP.settings);
    patch.modelProvider = provider;
    patch.modelId = id;
  }
  if (opts.level !== undefined) patch.thinkingLevel = opts.level;
  const data = await postJson(base, json, url, patch, "PUT");
  R.done(json, data, R.settings(data.settings ?? {}), `settings stored`);
}
async function doGit(base, json, opts, gitArgv) {
  needWsSid(opts, "git", HELP.git);
  if (gitArgv.length === 0) failUsage(`git needs an argv (e.g. pi-do git --ws WS --sid SID status).`, HELP.git);
  const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/git"), { argv: gitArgv });
  const out = typeof data.stdout === "string" && data.stdout.length > 0 ? data.stdout : undefined;
  R.done(json, data, out ?? JSON.stringify(data), out);
}
async function doFilesPut(base, json, opts) {
  need(opts.ws, `files put needs --ws WS.`, HELP["files:put"]);
  if (opts.path === undefined) failUsage(`files put needs --path P.`, HELP["files:put"]);
  needNo(opts, ["out"], `files put takes no --out (did you mean files get?).`, HELP["files:put"]);
  const body = await resolvePutBody(opts);
  const url = wsUrl(base, opts.ws, `/files?path=${encodeURIComponent(opts.path)}`);
  const res = await doFetch(base, json, url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body });
  const data = await res.json();
  R.done(json, data, `wrote ${data.bytes} bytes to ${data.path}`, `wrote ${data.bytes} bytes to ${data.path}`);
}
async function doFilesGet(base, json, opts) {
  need(opts.ws, `files get needs --ws WS.`, HELP["files:get"]);
  if (opts.path === undefined) failUsage(`files get needs --path P.`, HELP["files:get"]);
  needNo(opts, ["body", "bodyFile"], `files get takes no --body/--body-file (did you mean files put?).`, HELP["files:get"]);
  const res = await doFetch(base, json, wsUrl(base, opts.ws, `/files?path=${encodeURIComponent(opts.path)}`));
  const bytes = Buffer.from(await res.arrayBuffer());
  if (opts.out !== undefined) {
    try { await writeFile(opts.out, bytes); } catch (e) { failUsage(`cannot write --out ${opts.out}: ${e.message}.`); }
    R.note(`${bytes.length} bytes from ${opts.path} -> ${opts.out}`);
    if (json) R.note(JSON.stringify({ path: opts.path, bytes: bytes.length, out: opts.out }));
  } else {
    await new Promise((resolve, reject) => {
      process.stdout.write(bytes, (e) => (e ? reject(e) : resolve()));
    });
    R.note(`${bytes.length} bytes from ${opts.path}`);
    if (json) R.note(JSON.stringify({ path: opts.path, bytes: bytes.length }));
  }
  process.exitCode = 0; return;
}
async function doFilesLs(base, json, opts) {
  need(opts.ws, `files ls needs --ws WS.`, HELP["files:ls"]);
  needNo(opts, ["body", "bodyFile", "out"], `files ls takes no --body/--body-file/--out.`, HELP["files:ls"]);
  const dir = opts.path ?? "";
  const data = await getJson(base, json, wsUrl(base, opts.ws, `/files?list=${encodeURIComponent(dir)}`));
  const entries = Array.isArray(data.entries) ? data.entries : [];
  R.done(json, data, R.list(entries, (e) => `${e.path} (${e.bytes} bytes)`, `(empty)`), `${entries.length} entries under "${dir}"`);
}
async function doFilesRm(base, json, opts) {
  need(opts.ws, `files rm needs --ws WS.`, HELP["files:rm"]);
  if (opts.path === undefined) failUsage(`files rm needs --path P.`, HELP["files:rm"]);
  needNo(opts, ["body", "bodyFile", "out"], `files rm takes no --body/--body-file/--out.`, HELP["files:rm"]);
  const rec = opts.recursive === true ? "&recursive=true" : "";
  const data = await (await doFetch(base, json, wsUrl(base, opts.ws, `/files?path=${encodeURIComponent(opts.path)}${rec}`), { method: "DELETE" })).json();
  const removed = Array.isArray(data.removed) ? data.removed : [];
  R.done(json, data, R.list(removed, (p) => `removed ${p}`, `(removed nothing)`), `removed ${removed.length} path(s)`);
}
async function fetchEntriesPage(base, json, ws, sid, after, limit) {
  return getJson(base, json, sessUrl(base, ws, sid, `/entries?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`));
}
async function doEntries(base, json, opts) {
  needWsSid(opts, "entries", HELP.entries);
  const after = String(checkedUint(opts.after ?? "0", `entries needs --after N (a non-negative integer).`, HELP.entries));
  const limit = String(checkedUint(opts.limit ?? "100", `entries needs --limit L (a non-negative integer up to 1000).`, HELP.entries, 0, 1000));
  if (!opts.all) {
    const data = await fetchEntriesPage(base, json, opts.ws, opts.sid, after, limit);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    R.show(json, data);
    if (!json) R.entries(entries);
    R.note(`entries ${entries.length} (after ${after} limit ${limit} head ${data.head} count ${data.count})`);
    process.exitCode = 0; return;
  }
  const entries = [];
  let cursor = after;
  let head;
  let count;
  for (let page = 0; page < 100; page++) {
    const data = await fetchEntriesPage(base, json, opts.ws, opts.sid, cursor, limit);
    const slice = Array.isArray(data.entries) ? data.entries : [];
    head = data.head;
    count = data.count;
    if (slice.length === 0) break;
    for (const e of slice) entries.push(e);
    if (!json) R.entries(slice);
    cursor = String(slice[slice.length - 1].cursor);
  }
  R.show(json, { entries, head, count });
  R.note(`entries ${entries.length} (after ${after} limit ${limit} head ${head} count ${count})`);
  process.exitCode = 0; return;
}
async function doMeta(base, json, opts) {
  needWsSid(opts, "meta", HELP.meta);
  const qs = opts.systemPrompt === true ? "?systemPrompt=1" : "";
  const data = await getJson(base, json, sessUrl(base, opts.ws, opts.sid, `/meta${qs}`));
  R.show(json, data, `sid ${data.sid}\nws ${data.ws}\ncreated ${data.created}\nhead ${data.head}\ncount ${data.count}\nopenRun ${data.openRun ?? "null"}\nbackstory ${data.backstory ?? "null"}${data.systemPrompt !== undefined ? `\nsystemPrompt:\n${data.systemPrompt}` : ""}`, `meta head ${data.head} count ${data.count} openRun ${data.openRun ?? "null"}`);
  if (!json) R.note(`meta head ${data.head} count ${data.count}`);
  process.exitCode = 0; return;
}
async function doCompact(base, json, opts) {
  needWsSid(opts, "compact", HELP.compact);
  const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/compact"));
  R.show(json, data, `compacted ${data.compacted} live ${data.live} archived ${data.archived} summary ${data.summaryCursor ?? "null"} pages ${data.pages}`);
  R.note(`compacted ${data.compacted} live ${data.live}`);
  process.exitCode = 0; return;
}
async function doArchive(base, json, opts) {
  needWsSid(opts, "archive", HELP.archive);
  const page = String(checkedUint(opts.page ?? "1", `archive needs --page N (a positive integer).`, HELP.archive, 1));
  const data = await getJson(base, json, sessUrl(base, opts.ws, opts.sid, `/archive?page=${encodeURIComponent(page)}`));
  const entries = Array.isArray(data.entries) ? data.entries : [];
  R.show(json, data);
  if (!json) R.entries(entries);
  R.note(`archive page ${data.page}/${data.pages} entries ${entries.length} total ${data.total}`);
  process.exitCode = 0; return;
}
async function doStream(base, json, opts) {
  needWsSid(opts, "stream", HELP.stream);
  let expected = fenceExpected(opts, "stream", HELP.stream);
  if (typeof WebSocket === "undefined") {
    R.note(`error: this node has no global WebSocket`); R.note(`hint: use node >= 22 for 'pi-do stream', or drive the socket from verify/stream-protocol.sh`);
    process.exit(1);
  }
  const wsBase = stripBase(base).replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const url = new URL(`${wsBase}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/stream`);
  let fence = opts.fence;
  if (fence !== undefined) {
    url.searchParams.set("fence", fence);
    url.searchParams.set("expected", String(expected));
  }
  const sock = new WebSocket(url.toString());
  const sendRaw = (obj) => sock.send(JSON.stringify(obj));
  const withFence = (frame) => {
    if (fence === undefined) return frame;
    frame.fence = fence;
    frame.expected = expected;
    return frame;
  };
  const sendLine = (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "/abort") return sendRaw({ abort: true });
    if (text === "/steer" || text.startsWith("/steer ")) return sendRaw(withFence({ steer: true, text: text.slice("/steer".length).trim() }));
    if (text.startsWith("{")) return sock.send(text);
    sendRaw(withFence({ prompt: text }));
  };
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    try { sock.close(); } catch { drainExit(code); return; }
    drainExit(code);
  };
  // Server close codes map to exit codes: clean 0, fenced 3, conflict 4,
  // unknown 5, anything else non-zero.
  const exitForClose = (code) => {
    if (code === 4403) return 3;
    if (code === 4409) return 4;
    if (code === 4404) return 5;
    if (code === 1000 || code === 1005) return 0;
    return 1;
  };
  // Max entry cursor seen on the socket; the close-time replay fetches
  // everything after it in case the server persisted rows the socket
  // never delivered (crash, raced close).
  let lastCursor = 0;
  const replayMissed = async () => {
    if (lastCursor === 0) return;
    let after = lastCursor;
    for (;;) {
      let data;
      try {
        data = await fetchEntriesPage(base, json, opts.ws, opts.sid, after, 1000);
      } catch {
        if (json) R.json({ error: "replay fetch failed", hint: `retry with GET /workspaces/${opts.ws}/sessions/${opts.sid}/entries?after=${after}&limit=1000` });
        else { R.note(`error: replay fetch after close failed`); R.note(`hint: run 'pi-do entries --ws ${opts.ws} --sid ${opts.sid} --after ${after} --all' to recover missed rows`); }
        return;
      }
      const rows = Array.isArray(data.entries) ? data.entries : [];
      for (const row of rows) {
        if (typeof row.cursor === "number" && row.cursor > lastCursor) lastCursor = row.cursor;
        if (json) R.json({ replay: row });
        else process.stdout.write(`replay ${row.cursor} ${row.type} ${row.body}\n`);
      }
      if (rows.length < 1000) return;
      const last = rows[rows.length - 1].cursor;
      if (typeof last !== "number" || last <= after) return;
      if (typeof data.head === "number" && last >= data.head) return;
      after = last;
    }
  };
  sock.onopen = () => {
    R.note(`stream open ${url.toString()}`);
    if (process.stdin.isTTY) R.note(`hint: type prompts line by line; Ctrl-D ends stdin, Ctrl-C closes the socket`);
    let rest = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      rest += chunk;
      let idx;
      while ((idx = rest.indexOf("\n")) !== -1) {
        const line = rest.slice(0, idx);
        rest = rest.slice(idx + 1);
        sendLine(line);
      }
    });
    process.stdin.on("end", () => { if (rest.trim()) sendLine(rest); });
    process.stdin.resume();
  };
  sock.onmessage = (event) => {
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch {
      R.note(`error: non-JSON frame from server`); R.note(`hint: the stream speaks one JSON object per message; reconnect and retry`);
      finish(1);
      return;
    }
    // Track the freshest revision from any frame carrying one so a fenced
    // client can re-claim with the current revision after close.
    if (typeof frame.revision === "number") expected = frame.revision;
    if (frame.done === true && typeof frame.fence === "string") fence = frame.fence;
    if (frame.entry && typeof frame.entry.cursor === "number" && frame.entry.cursor > lastCursor) lastCursor = frame.entry.cursor;
    if (frame.error && !frame.entry) R.note(`error: ${frame.error}`);
    if (frame.error && frame.hint) R.note(`hint: ${frame.hint}`);
    R.frame(frame, json);
  };
  sock.onerror = () => {
    R.note(`error: socket error talking to ${base}`); R.note(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) R.json({ error: "socket error", base });
    // No exit here: the close event always follows and maps the code.
  };
  sock.onclose = async (event) => {
    R.note(`stream close code=${event.code} reason=${event.reason || "-"}`);
    const code = exitForClose(event.code);
    await replayMissed();
    finish(code);
  };
  process.on("SIGINT", () => finish(0));
}
async function doRoutines(base, json, opts, sub) {
  const help = (k) => HELP[k] ?? HELP.routines;
  if (sub === "list") {
    needWsSid(opts, "routines list", help("routines:list"));
    const data = await getJson(base, json, sessUrl(base, opts.ws, opts.sid, "/routines"));
    const list = Array.isArray(data.routines) ? data.routines : [];
    R.done(json, data, R.list(list, (r) => `${r.id} ${r.schedule.kind}:${r.schedule.spec} runs=${r.runCount} next=${r.nextRunAt ?? "inactive"} ${r.prompt}`, `(empty)`), `${list.length} routine(s)`);
    return;
  }
  if (sub === "create") {
    needWsSid(opts, "routines create", help("routines:create"));
    need(opts.kind, `routines create needs --kind once|interval|weekly.`, help("routines:create"));
    need(opts.spec, `routines create needs --spec S.`, help("routines:create"));
    need(opts.prompt, `routines create needs --prompt T.`, help("routines:create"));
    if (!["once", "interval", "weekly"].includes(opts.kind)) failUsage(`routines create needs --kind once|interval|weekly.`, help("routines:create"));
    const payload = { kind: opts.kind, spec: opts.spec, prompt: opts.prompt };
    if (opts.expireAt !== undefined) payload.expireAt = opts.expireAt;
    if (opts.maxRuns !== undefined) payload.maxRuns = checkedUint(opts.maxRuns, `routines create needs --max-runs N (an integer >= 1).`, help("routines:create"), 1);
    if (opts.requestId !== undefined) payload.requestId = opts.requestId;
    const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/routines"), payload);
    R.done(json, data, `routine ${data.routine.id} next=${data.routine.nextRunAt}`, `routine ${data.routine.id} next=${data.routine.nextRunAt}`);
    return;
  }
  if (sub === "delete") {
    needWsSid(opts, "routines delete", help("routines:delete"));
    need(opts.id, `routines delete needs --id ROUTINE.`, help("routines:delete"));
    const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, `/routines?id=${encodeURIComponent(opts.id)}`), undefined, "DELETE");
    R.done(json, data, `deleted ${data.deleted}`, `deleted ${data.deleted}`);
    return;
  }
  failUsage(`routines needs a subcommand (list|create|delete).`, HELP.routines);
}
async function doInbox(base, json, opts, sub) {
  const help = (k) => HELP[k] ?? HELP.inbox;
  if (sub === "list") {
    needWsSid(opts, "inbox list", help("inbox:list"));
    const qs = new URLSearchParams();
    if (opts.thread !== undefined) qs.set("thread", opts.thread);
    if (opts.all) qs.set("all", "1");
    const data = await getJson(base, json, sessUrl(base, opts.ws, opts.sid, `/inbox${qs.size > 0 ? `?${qs}` : ""}`));
    const list = Array.isArray(data.messages) ? data.messages : [];
    R.done(json, data, R.list(list, (m) => `${m.id} from=${m.from} to=${m.to}${m.thread ? ` thread=${m.thread}` : ""} delivered=${m.deliveredAt ?? "no"} ${m.body}`, `(empty)`), `${list.length} message(s)`);
    return;
  }
  if (sub === "send") {
    needWsSid(opts, "inbox send", help("inbox:send"));
    need(opts.to, `inbox send needs --to SESSION (a session id or name).`, help("inbox:send"));
    need(opts.body, `inbox send needs --body T.`, help("inbox:send"));
    const payload = { to: opts.to, body: opts.body };
    if (opts.thread !== undefined) payload.thread = opts.thread;
    if (opts.requestId !== undefined) payload.requestId = opts.requestId;
    if (opts.wait === true) { payload.wait = true; payload.timeout = opts.timeout === undefined ? undefined : checkedUint(opts.timeout, `inbox send needs --timeout S (seconds).`, help("inbox:send"), 1); }
    const data = await postJson(base, json, sessUrl(base, opts.ws, opts.sid, "/inbox"), payload);
    R.done(json, data, `inbox ${data.message.id} to=${data.message.to} delivered=${data.message.deliveredAt ?? "no"}`, `inbox ${data.message.id} to=${data.message.to} delivered=${data.message.deliveredAt ?? "no"}`);
    return;
  }
  failUsage(`inbox needs a subcommand (list|send).`, HELP.inbox);
}
async function doExec(base, json, opts) {
  need(opts.ws, `exec needs --ws WS.`, HELP.exec);
  if (opts.command === undefined) failUsage(`exec needs --command CMD.`, HELP.exec);
  needNo(opts, ["path", "body", "bodyFile", "out"], `exec takes no --path/--body/--body-file/--out.`, HELP.exec);
  const payload = { command: opts.command };
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  const data = await postJson(base, json, wsUrl(base, opts.ws, "/exec"), payload);
  const note = `exit ${data.exit}`;
  R.show(json, data, typeof data.stdout === "string" && data.stdout.length > 0 ? data.stdout : undefined, note);
  if (!json) {
    if (data.stderr) process.stderr.write(data.stderr.endsWith("\n") ? data.stderr : `${data.stderr}\n`);
    R.note(note);
  }
  process.exitCode = 0; return;
}
const PLAIN = {
  doctor: doDoctor, exec: doExec, entries: doEntries, meta: doMeta,
  compact: doCompact, archive: doArchive, claim: doClaim, run: doRun,
  stream: doStream, model: doModel, thinking: doThinking, models: doModels,
};
const FILES_CMDS = { put: doFilesPut, get: doFilesGet, ls: doFilesLs, rm: doFilesRm };
async function main() {
  const { opts, positionals } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...extra] = positionals;
  if (opts.help) {
    process.stdout.write(helpFor(cmd, sub));
    process.exitCode = 0; return;
  }
  if (!cmd || cmd === "help") {
    process.stdout.write(sub ? helpFor(sub, extra[0]) : HELP.root);
    process.exitCode = 0; return;
  }
  if (Object.hasOwn(PLAIN, cmd)) {
    if (sub !== undefined || extra.length > 0) failUsage(`${cmd} takes no subcommand.`, HELP[cmd]);
    await PLAIN[cmd](opts.base, opts.json, opts);
  } else if (cmd === "workspace") {
    if (sub === undefined) failUsage(`workspace needs a subcommand (create).`, HELP.workspace);
    if (sub !== "create" || extra.length > 0) failUsage(`unknown workspace subcommand '${sub ?? ""}'.`, HELP.workspace);
    await doWorkspaceCreate(opts.base, opts.json);
  } else if (cmd === "files") {
    if (sub === undefined) failUsage(`files needs a subcommand (put|get|ls|rm).`, HELP.files);
    if (!Object.hasOwn(FILES_CMDS, sub) || extra.length > 0) failUsage(`unknown files subcommand '${sub}'.`, HELP.files);
    await FILES_CMDS[sub](opts.base, opts.json, opts);
  } else if (cmd === "git") {
    await doGit(opts.base, opts.json, opts, sub === undefined ? [...extra] : [sub, ...extra]);
  } else if (cmd === "session") {
    if (sub !== "create" || extra.length > 0) failUsage(`unknown session subcommand '${sub ?? ""}'.`, HELP.session);
    await doSessionCreate(opts.base, opts.json, opts);
  } else if (cmd === "routines") {
    await doRoutines(opts.base, opts.json, opts, sub);
  } else if (cmd === "inbox") {
    await doInbox(opts.base, opts.json, opts, sub);
  } else if (cmd === "settings") {
    await doSettings(opts.base, opts.json, opts);
  } else {
    failUsage(`unknown command '${cmd}'.`, HELP.root);
  }
}
main().catch((e) => {
  process.stderr.write(`pi-do: unexpected failure: ${e?.message ?? e}\n`);
  process.exit(1);
});
