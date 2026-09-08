#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_BASE = "http://127.0.0.1:8787";

const HELP = {
  root: `pi-do — front door for the pi-do worker
usage:
  pi-do [--base URL] [--json] <command> [options]
commands:
  doctor | workspace create | session create | files put|get|ls|rm | exec | git
  run | claim | model | thinking | models | settings | entries | meta
  compact | archive | stream
flags: --base URL (default ${DEFAULT_BASE})  --json  --help, -h
examples:
  pi-do doctor
  pi-do workspace create
  pi-do files put --ws <id> --path hello.txt --body "hi"
  pi-do exec --ws <id> --command "echo hi"
`,
  doctor: `pi-do doctor — check the worker is listening
usage: pi-do doctor [--base URL] [--json]
Any HTTP response counts as listening (exit 0); connection failure is absent (exit 2).
`,
  workspace: `pi-do workspace — manage workspaces
usage: pi-do workspace create [--base URL] [--json]
`,
  "workspace:create": `pi-do workspace create — create a workspace
usage: pi-do workspace create [--base URL] [--json]
POSTs /workspaces. Stdout is "workspace <id>" (raw JSON with --json).
`,
  session: `pi-do session — manage sessions
usage: pi-do session create --ws WS [--retention short|long] [--base URL] [--json]
`,
  "session:create": `pi-do session create — mint a session in a workspace
usage: pi-do session create --ws WS [--retention short|long] [--base URL] [--json]
POSTs /workspaces/:id/sessions. Stdout is "session <id>" (raw JSON with --json).
`,
  claim: `pi-do claim — rotate the owner fence via revision CAS
usage: pi-do claim --ws WS --sid SID --fence F --expected N [--base URL] [--json]
Wrong fence is 403, stale expected is 409. Success rotates fence and bumps revision.
`,
  run: `pi-do run — one headless harness turn in a session
usage: pi-do run --ws WS --sid SID --prompt T [--model provider/id] [--thinking L] [--fence F --expected N] [--base URL] [--json]
Without --json stdout is the result text; with --json stdout is the raw server JSON.
`,
  model: `pi-do model — switch the session model mid-session
usage: pi-do model --ws WS --sid SID --model provider/id [--fence F --expected N] [--base URL] [--json]
`,
  thinking: `pi-do thinking — switch the session thinking level
usage: pi-do thinking --ws WS --sid SID --level L [--fence F --expected N] [--base URL] [--json]
`,
  models: `pi-do models — list catalog models with context windows
usage: pi-do models [--provider P] [--base URL] [--json]
`,
  settings: `pi-do settings — workspace default model triple for session mint
usage: pi-do settings --ws WS [--model provider/id] [--level L] [--base URL] [--json]
No --model/--level reads the defaults (GET); with either it stores them (PUT).
`,
  git: `pi-do git — narrow git reads and local writes over a session
usage: pi-do git --ws WS --sid SID [--base URL] [--json] <argv...>
POSTs {argv} to /workspaces/:id/sessions/:sid/git.
`,
  files: `pi-do files — read/write/list/remove workspace files
usage: pi-do files put|get|ls|rm --ws WS [options]
`,
  "files:put": `pi-do files put — upload raw bytes to a workspace file
usage: pi-do files put --ws WS --path P (--body STR | --body-file F | piped stdin) [--base URL] [--json]
`,
  "files:get": `pi-do files get — download raw bytes of a workspace file
usage: pi-do files get --ws WS --path P [--out F] [--base URL] [--json]
Stdout is the raw bytes (or nothing with --out).
`,
  "files:ls": `pi-do files ls — list workspace file entries
usage: pi-do files ls --ws WS [--path DIR] [--base URL] [--json]
`,
  "files:rm": `pi-do files rm — delete a workspace file or directory tree
usage: pi-do files rm --ws WS --path P [--recursive] [--base URL] [--json]
`,
  exec: `pi-do exec — run a one-off shell command in a workspace
usage: pi-do exec --ws WS --command CMD [--cwd D] [--base URL] [--json]
`,
  entries: `pi-do entries — ordered replay slice of persisted session entries
usage: pi-do entries --ws WS --sid SID [--after N] [--limit L] [--all] [--base URL] [--json]
--all pages gaplessly and prints every entry (JSON mode prints one merged payload).
`,
  meta: `pi-do meta — resume cursor for a session
usage: pi-do meta --ws WS --sid SID [--base URL] [--json]
`,
  compact: `pi-do compact — summarize old entries and archive the originals
usage: pi-do compact --ws WS --sid SID [--base URL] [--json]
`,
  archive: `pi-do archive — re-read one paginated cold-storage page
usage: pi-do archive --ws WS --sid SID [--page N] [--base URL] [--json]
`,
  stream: `pi-do stream — live turns over a WebSocket
usage: pi-do stream --ws WS --sid SID [--fence F --expected N] [--base URL] [--json]
Stdin lines are prompts ("/abort", "/steer TEXT", or {raw JSON}); frames print on stdout.
Needs node >= 22 for the global WebSocket.
`,
};

function failUsage(message, help) {
  process.stderr.write(`pi-do: ${message}\n`);
  if (help) process.stderr.write(`\n${help}`);
  else process.stderr.write(`Run 'pi-do --help' for usage.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE, json: false, help: false, ws: undefined, sid: undefined, prompt: undefined,
    fence: undefined, expected: undefined, after: undefined, limit: undefined, page: undefined,
    path: undefined, body: undefined, bodyFile: undefined, out: undefined, command: undefined,
    cwd: undefined, model: undefined, level: undefined, provider: undefined, retention: undefined, all: false,
  };
  const keys = {
    "--base": "base", "--ws": "ws", "--workspace": "ws", "--sid": "sid", "--session": "sid",
    "--path": "path", "--body": "body", "--body-file": "bodyFile", "--out": "out", "-o": "out",
    "--command": "command", "--cwd": "cwd", "--fence": "fence", "--expected": "expected", "--prompt": "prompt",
    "--after": "after", "--limit": "limit", "--page": "page", "--model": "model", "--level": "level",
    "--thinking": "level", "--provider": "provider", "--retention": "retention",
  };
  const positionals = [];
  let baseSet = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (tok === "--json") { opts.json = true; continue; }
    if (tok === "--help" || tok === "-h") { opts.help = true; continue; }
    if (tok === "--all") { opts.all = true; continue; }
    if (tok === "--recursive") { opts.recursive = true; continue; }
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const key = keys[flag];
    if (key === undefined) {
      positionals.push(tok);
      continue;
    }
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

function human(text) {
  process.stderr.write(`${text}\n`);
}

function splitProviderId(raw, message, help) {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) failUsage(message, help);
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emit(json, data, { text, hint } = {}) {
  if (json) {
    printJson(data);
    if (hint !== undefined) human(hint);
  } else if (text) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
}

function fmtEntry(e) {
  return `${e.cursor} ${e.type} ${e.body}`;
}

function printEntries(entries) {
  for (const e of entries) process.stdout.write(`${fmtEntry(e)}\n`);
}

async function failFromResponse(res, json) {
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const errorMsg = parsed && typeof parsed.error === "string" ? parsed.error : `request failed (HTTP ${res.status})`;
  const hint = parsed && typeof parsed.hint === "string" ? parsed.hint : text.slice(0, 500);
  human(`error: ${errorMsg}`);
  if (hint) human(`hint: ${hint}`);
  if (json) printJson(parsed ?? { error: errorMsg, status: res.status });
  process.exit(1);
}

async function doFetch(base, json, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    human(`error: cannot reach server at ${base}`); human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  return res;
}

function need(val, message, help) {
  if (val === undefined || val === null || val === false || val === "") failUsage(message, help);
}

function needWsSid(opts, what, help) {
  need(opts.ws, `${what} needs --ws WS.`, help);
  need(opts.sid, `${what} needs --sid SID.`, help);
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

function formatUsageRow(usage) {
  const num = (n) => Number(n).toLocaleString("en-US");
  const parts = [`in ${num(usage.inTokens ?? 0)}`, `out ${num(usage.outTokens ?? 0)}`];
  if ((usage.cacheRead ?? 0) > 0) parts.push(`cache ${num(usage.cacheRead)}`);
  const ms = usage.elapsedMs ?? 0;
  parts.push(`t ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}`);
  if (usage.tokensPerSec !== null && usage.tokensPerSec !== undefined) parts.push(`${usage.tokensPerSec.toFixed(1)}/s`);
  const denom = (usage.inTokens ?? 0) + (usage.cacheRead ?? 0);
  const hit = denom > 0 ? ((usage.cacheRead ?? 0) / denom) * 100 : 0;
  parts.push(`CH${hit.toFixed(1)}%`);
  parts.push(`ret ${usage.retention ?? "short"}`);
  return parts.join("  ");
}

function printStreamFrame(frame, json) {
  if (json) return printJson(frame);
  if (frame.entry) return process.stdout.write(`entry ${fmtEntry(frame.entry)}\n`);
  if (frame.done) {
    if (typeof frame.fence === "string") process.stdout.write(`done fence=${frame.fence} revision=${frame.revision}\n`);
    else process.stdout.write(`done\n`);
    if (frame.result) process.stdout.write(frame.result.endsWith("\n") ? frame.result : `${frame.result}\n`);
    if (frame.usage) process.stdout.write(`usage ${formatUsageRow(frame.usage)}\n`);
    if (frame.halt) process.stdout.write(`halt: ${frame.halt.reason ?? frame.halt}\n`);
    return;
  }
  const line =
    frame.aborted ? `aborted run=${frame.runId ?? ""}` :
    frame.busy ? `busy ${frame.hint ?? ""}` :
    frame.ping ? `ping` :
    frame.error ? `error ${frame.error} ${frame.hint ?? ""}` :
    frame.message !== undefined ? `message ${JSON.stringify(frame.message)}` :
    frame.tool !== undefined ? `tool ${JSON.stringify(frame.tool)}` :
    frame.agent !== undefined ? `agent ${JSON.stringify(frame.agent)}` :
    JSON.stringify(frame);
  process.stdout.write(`${line}\n`);
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
    human(`pi-do doctor: absent — no server listening at ${base} (is 'wrangler dev' running?).`); human(`detail: ${e.cause?.message ?? e.message}`);
    if (json) printJson({ ok: false, base, error: "absent" });
    process.exit(2);
  }
  if (json) printJson({ ok: true, base, status: res.status });
  human(`ok — server listening at ${base} (status ${res.status})`);
  process.exit(0);
}

async function doWorkspaceCreate(base, json) {
  const res = await doFetch(base, json, `${stripBase(base)}/workspaces`, { method: "POST" });
  const data = await res.json();
  emit(json, data, { text: `workspace ${data.workspaceId}`, hint: `workspace ${data.workspaceId}` });
  process.exit(0);
}

async function doSessionCreate(base, json, opts) {
  need(opts.ws, `session create needs --ws WS.`, HELP["session:create"]);
  if (opts.retention !== undefined && opts.retention !== "short" && opts.retention !== "long") failUsage(`session create needs --retention short|long.`, HELP["session:create"]);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions`;
  const init = opts.retention === undefined
    ? { method: "POST" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retention: opts.retention }) };
  const res = await doFetch(base, json, url, init);
  const data = await res.json();
  emit(json, data, { text: `session ${data.sessionId} ret ${data.retention ?? "short"}`, hint: `session ${data.sessionId} ret ${data.retention ?? "short"}` });
  process.exit(0);
}

async function doRun(base, json, opts) {
  needWsSid(opts, "run", HELP.run);
  if (opts.prompt === undefined) failUsage(`run needs --prompt T.`, HELP.run);
  const expected = fenceExpected(opts, "run", HELP.run);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/run`;
  const payload = { prompt: opts.prompt };
  if (opts.fence !== undefined) { payload.fence = opts.fence; payload.expected = expected; }
  if (opts.model !== undefined) payload.model = splitProviderId(opts.model, `run needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, HELP.run);
  if (opts.level !== undefined) payload.thinking = opts.level;
  const res = await doFetch(base, json, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
  const note = `run ok: ${calls.length} tool calls`;
  emit(json, data, { text: data.result, hint: note });
  if (!json) {
    human(note);
    if (data.usage) human(`usage ${formatUsageRow(data.usage)}`);
    if (data.halt) human(`halt: ${data.halt.reason ?? data.halt}`);
  }
  process.exit(0);
}

async function doClaim(base, json, opts) {
  needWsSid(opts, "claim", HELP.claim);
  if (opts.fence === undefined) failUsage(`claim needs --fence F.`, HELP.claim);
  if (opts.expected === undefined) failUsage(`claim needs --expected N.`, HELP.claim);
  const expected = checkedUint(opts.expected, `claim needs --expected N (a non-negative integer).`, HELP.claim);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/claim`;
  const res = await doFetch(base, json, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fence: opts.fence, expected }),
  });
  const data = await res.json();
  emit(json, data, { text: `fence ${data.fence} revision ${data.revision}`, hint: `claim ok: revision ${data.revision}` });
  process.exit(0);
}

async function doModel(base, json, opts) {
  needWsSid(opts, "model", HELP.model);
  if (opts.model === undefined) failUsage(`model needs --model provider/id.`, HELP.model);
  const expected = fenceExpected(opts, "model", HELP.model);
  const { provider, id } = splitProviderId(opts.model, `model needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, HELP.model);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/model`;
  const payload = { provider, id };
  if (opts.fence !== undefined) { payload.fence = opts.fence; payload.expected = expected; }
  const res = await doFetch(base, json, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  emit(json, data, { text: `model ${data.model.provider}/${data.model.id} revision ${data.revision}`, hint: `model ok: ${data.model.provider}/${data.model.id} (revision ${data.revision})` });
  process.exit(0);
}

async function doThinking(base, json, opts) {
  needWsSid(opts, "thinking", HELP.thinking);
  if (opts.level === undefined) failUsage(`thinking needs --level L.`, HELP.thinking);
  const expected = fenceExpected(opts, "thinking", HELP.thinking);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/thinking`;
  const payload = { level: opts.level };
  if (opts.fence !== undefined) { payload.fence = opts.fence; payload.expected = expected; }
  const res = await doFetch(base, json, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  emit(json, data, { text: `thinking ${data.thinking} revision ${data.revision}`, hint: `thinking ok: ${data.thinking} (revision ${data.revision})` });
  process.exit(0);
}

async function doModels(base, json, opts) {
  let url = `${stripBase(base)}/models`;
  if (opts.provider !== undefined) url += `?provider=${encodeURIComponent(opts.provider)}`;
  const res = await doFetch(base, json, url);
  const data = await res.json();
  const models = Array.isArray(data.models) ? data.models : [];
  const text = models.length === 0 ? `(empty)` : models.map((m) => `${m.provider}/${m.id} (ctx ${m.contextWindow})`).join("\n");
  emit(json, data, { text, hint: `${models.length} models` });
  process.exit(0);
}

function settingsText(s) {
  return `model ${s.modelProvider ?? "null"}/${s.modelId ?? "null"} thinking ${s.thinkingLevel ?? "null"}`;
}

async function doSettings(base, json, opts) {
  need(opts.ws, `settings needs --ws WS.`, HELP.settings);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/settings`;
  if (opts.model === undefined && opts.level === undefined) {
    const res = await doFetch(base, json, url);
    const data = await res.json();
    emit(json, data, { text: settingsText(data.settings ?? {}), hint: `settings shown` });
    process.exit(0);
  }
  const patch = {};
  if (opts.model !== undefined) {
    const { provider, id } = splitProviderId(opts.model, `settings needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, HELP.settings);
    patch.modelProvider = provider;
    patch.modelId = id;
  }
  if (opts.level !== undefined) patch.thinkingLevel = opts.level;
  const res = await doFetch(base, json, url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  emit(json, data, { text: settingsText(data.settings ?? {}), hint: `settings stored` });
  process.exit(0);
}

async function doGit(base, json, opts, gitArgv) {
  needWsSid(opts, "git", HELP.git);
  if (gitArgv.length === 0) failUsage(`git needs an argv (e.g. pi-do git --ws WS --sid SID status).`, HELP.git);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/git`;
  const res = await doFetch(base, json, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv: gitArgv }),
  });
  const data = await res.json();
  const out = typeof data.stdout === "string" && data.stdout.length > 0 ? data.stdout : undefined;
  emit(json, data, { text: out ?? JSON.stringify(data), hint: out });
  process.exit(0);
}

async function doFilesPut(base, json, opts) {
  need(opts.ws, `files put needs --ws WS.`, HELP["files:put"]);
  if (opts.path === undefined) failUsage(`files put needs --path P.`, HELP["files:put"]);
  if (opts.out !== undefined) failUsage(`files put takes no --out (did you mean files get?).`, HELP["files:put"]);
  const body = await resolvePutBody(opts);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?path=${encodeURIComponent(opts.path)}`;
  const res = await doFetch(base, json, url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  const data = await res.json();
  emit(json, data, { text: `wrote ${data.bytes} bytes to ${data.path}`, hint: `wrote ${data.bytes} bytes to ${data.path}` });
  process.exit(0);
}

async function doFilesGet(base, json, opts) {
  need(opts.ws, `files get needs --ws WS.`, HELP["files:get"]);
  if (opts.path === undefined) failUsage(`files get needs --path P.`, HELP["files:get"]);
  if (opts.body !== undefined || opts.bodyFile !== undefined)
    failUsage(`files get takes no --body/--body-file (did you mean files put?).`, HELP["files:get"]);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?path=${encodeURIComponent(opts.path)}`;
  const res = await doFetch(base, json, url);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (opts.out !== undefined) {
    try { await writeFile(opts.out, bytes); } catch (e) { failUsage(`cannot write --out ${opts.out}: ${e.message}.`); }
    human(`${bytes.length} bytes from ${opts.path} -> ${opts.out}`);
    if (json) human(JSON.stringify({ path: opts.path, bytes: bytes.length, out: opts.out }));
  } else {
    await new Promise((resolve, reject) => {
      process.stdout.write(bytes, (e) => (e ? reject(e) : resolve()));
    });
    human(`${bytes.length} bytes from ${opts.path}`);
    if (json) human(JSON.stringify({ path: opts.path, bytes: bytes.length }));
  }
  process.exit(0);
}

async function doFilesLs(base, json, opts) {
  need(opts.ws, `files ls needs --ws WS.`, HELP["files:ls"]);
  if (opts.body !== undefined || opts.bodyFile !== undefined || opts.out !== undefined)
    failUsage(`files ls takes no --body/--body-file/--out.`, HELP["files:ls"]);
  const dir = opts.path ?? "";
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?list=${encodeURIComponent(dir)}`;
  const res = await doFetch(base, json, url);
  const data = await res.json();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const text = entries.length === 0 ? `(empty)` : entries.map((e) => `${e.path} (${e.bytes} bytes)`).join("\n");
  emit(json, data, { text, hint: `${entries.length} entries under "${dir}"` });
  process.exit(0);
}

async function doFilesRm(base, json, opts) {
  need(opts.ws, `files rm needs --ws WS.`, HELP["files:rm"]);
  if (opts.path === undefined) failUsage(`files rm needs --path P.`, HELP["files:rm"]);
  if (opts.body !== undefined || opts.bodyFile !== undefined || opts.out !== undefined)
    failUsage(`files rm takes no --body/--body-file/--out.`, HELP["files:rm"]);
  const rec = opts.recursive === true ? "&recursive=true" : "";
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?path=${encodeURIComponent(opts.path)}${rec}`;
  const res = await doFetch(base, json, url, { method: "DELETE" });
  const data = await res.json();
  const removed = Array.isArray(data.removed) ? data.removed : [];
  const text = removed.length === 0 ? `(removed nothing)` : removed.map((p) => `removed ${p}`).join("\n");
  emit(json, data, { text, hint: `removed ${removed.length} path(s)` });
  process.exit(0);
}

async function fetchEntriesPage(base, json, ws, sid, after, limit) {
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/entries?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`;
  const res = await doFetch(base, json, url);
  return res.json();
}

async function doEntries(base, json, opts) {
  needWsSid(opts, "entries", HELP.entries);
  const after = String(checkedUint(opts.after ?? "0", `entries needs --after N (a non-negative integer).`, HELP.entries));
  const limit = String(checkedUint(opts.limit ?? "100", `entries needs --limit L (a non-negative integer up to 1000).`, HELP.entries, 0, 1000));
  if (!opts.all) {
    const data = await fetchEntriesPage(base, json, opts.ws, opts.sid, after, limit);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    emit(json, data);
    if (!json) printEntries(entries);
    human(`entries ${entries.length} (after ${after} limit ${limit} head ${data.head} count ${data.count})`);
    process.exit(0);
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
    if (!json) printEntries(slice);
    cursor = String(slice[slice.length - 1].cursor);
  }
  emit(json, { entries, head, count });
  human(`entries ${entries.length} (after ${after} limit ${limit} head ${head} count ${count})`);
  process.exit(0);
}

async function doMeta(base, json, opts) {
  needWsSid(opts, "meta", HELP.meta);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/meta`;
  const res = await doFetch(base, json, url);
  const data = await res.json();
  const text = `sid ${data.sid}\nws ${data.ws}\ncreated ${data.created}\nhead ${data.head}\ncount ${data.count}\nopenRun ${data.openRun ?? "null"}`;
  emit(json, data, { text, hint: `meta head ${data.head} count ${data.count} openRun ${data.openRun ?? "null"}` });
  if (!json) human(`meta head ${data.head} count ${data.count}`);
  process.exit(0);
}

async function doCompact(base, json, opts) {
  needWsSid(opts, "compact", HELP.compact);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/compact`;
  const res = await doFetch(base, json, url, { method: "POST" });
  const data = await res.json();
  emit(json, data, { text: `compacted ${data.compacted} live ${data.live} archived ${data.archived} summary ${data.summaryCursor ?? "null"} pages ${data.pages}` });
  human(`compacted ${data.compacted} live ${data.live}`);
  process.exit(0);
}

async function doArchive(base, json, opts) {
  needWsSid(opts, "archive", HELP.archive);
  const page = String(checkedUint(opts.page ?? "1", `archive needs --page N (a positive integer).`, HELP.archive, 1));
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/archive?page=${encodeURIComponent(page)}`;
  const res = await doFetch(base, json, url);
  const data = await res.json();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  emit(json, data);
  if (!json) printEntries(entries);
  human(`archive page ${data.page}/${data.pages} entries ${entries.length} total ${data.total}`);
  process.exit(0);
}

async function doStream(base, json, opts) {
  needWsSid(opts, "stream", HELP.stream);
  let expected = fenceExpected(opts, "stream", HELP.stream);
  if (typeof WebSocket === "undefined") {
    human(`error: this node has no global WebSocket`); human(`hint: use node >= 22 for 'pi-do stream', or drive the socket from verify/stream-protocol.sh`);
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
    try { sock.close(); } catch { process.exit(code); }
    process.exit(code);
  };
  sock.onopen = () => {
    human(`stream open ${url.toString()}`);
    if (process.stdin.isTTY)
      human(`hint: type prompts line by line; Ctrl-D ends stdin, Ctrl-C closes the socket`);
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
      human(`error: non-JSON frame from server`); human(`hint: the stream speaks one JSON object per message; reconnect and retry`);
      finish(1);
      return;
    }
    if (frame.done === true && typeof frame.fence === "string") { fence = frame.fence; expected = frame.revision; }
    if (frame.error && !frame.entry) human(`error: ${frame.error}`);
    if (frame.error && frame.hint) human(`hint: ${frame.hint}`);
    printStreamFrame(frame, json);
  };
  sock.onerror = () => {
    human(`error: socket error talking to ${base}`); human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "socket error", base });
    finish(1);
  };
  sock.onclose = (event) => {
    human(`stream close code=${event.code} reason=${event.reason || "-"}`);
    finish(0);
  };
  process.on("SIGINT", () => finish(0));
}

async function doExec(base, json, opts) {
  need(opts.ws, `exec needs --ws WS.`, HELP.exec);
  if (opts.command === undefined) failUsage(`exec needs --command CMD.`, HELP.exec);
  if (opts.path !== undefined || opts.body !== undefined || opts.bodyFile !== undefined || opts.out !== undefined)
    failUsage(`exec takes no --path/--body/--body-file/--out.`, HELP.exec);
  const payload = { command: opts.command };
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/exec`;
  const res = await doFetch(base, json, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  const note = `exit ${data.exit}`;
  emit(json, data, { text: typeof data.stdout === "string" && data.stdout.length > 0 ? data.stdout : undefined, hint: note });
  if (!json) {
    if (data.stderr) process.stderr.write(data.stderr.endsWith("\n") ? data.stderr : `${data.stderr}\n`);
    human(note);
  }
  process.exit(0);
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
    process.exit(0);
  }
  if (!cmd || cmd === "help") {
    process.stdout.write(sub ? helpFor(sub, extra[0]) : HELP.root);
    process.exit(0);
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
