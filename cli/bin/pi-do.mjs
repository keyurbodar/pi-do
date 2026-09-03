#!/usr/bin/env node
// pi-do CLI driver: doctor / workspace create / session create / files put|get|ls|rm / exec / git / run / entries.
// Zero dependencies, plain JS on global fetch (node >= 18).
import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_BASE = "http://127.0.0.1:8787";

const ROOT_HELP = `pi-do — front door for the pi-do worker

usage:
  pi-do [--base URL] [--json] <command> [options]

commands:
  doctor                        check the worker is listening (GET BASE/)
  workspace create              create a workspace (POST /workspaces)
  session create                mint a session (POST /workspaces/:id/sessions)
  files put|get|ls|rm           read/write/list/remove workspace files
  exec                          run a one-off shell command (POST /workspaces/:id/exec)
  git                           narrow git reads (POST /workspaces/:id/sessions/:sid/git)
  run                           one headless harness turn (POST /workspaces/:id/sessions/:sid/run)
  claim                         rotate owner fence via revision CAS (POST /workspaces/:id/sessions/:sid/claim)
  model                         switch the session model (POST /workspaces/:id/sessions/:sid/model)
  thinking                      switch the thinking level (POST /workspaces/:id/sessions/:sid/thinking)
  models                        list catalog models (GET /models)
  settings                      workspace default model triple (PUT|GET /workspaces/:id/settings)
  entries                       raw replay slice (GET /workspaces/:id/sessions/:sid/entries)
  stream                        live turns over WS (GET /workspaces/:id/sessions/:sid/stream)
  meta                          resume cursor (GET /workspaces/:id/sessions/:sid/meta)

global flags:
  --base URL    worker base URL (default ${DEFAULT_BASE})
  --json        machine data on stdout, human text on stderr
  --help, -h    show help (also: pi-do <command> --help)

examples:
  pi-do doctor
  pi-do workspace create
  pi-do files put --ws <id> --path hello.txt --body "hi"
  pi-do exec --ws <id> --command "echo hi"
`;
const DOCTOR_HELP = `pi-do doctor — check the worker is listening

usage:
  pi-do doctor [--base URL] [--json]

behavior:
  GETs BASE/ and reports whether a server answers. Any HTTP response
  counts as listening (exit 0). A connection failure means absent (exit 2).
  Read-only: creates nothing. Human text goes to stderr.

exit codes:
  0  server listening
  2  absent / usage error

example:
  pi-do doctor --base http://127.0.0.1:8787
`;

const WORKSPACE_HELP = `pi-do workspace — manage workspaces

usage:
  pi-do workspace create [--base URL] [--json]

subcommands:
  create    create a workspace (POST /workspaces)

example:
  pi-do workspace create
`;

const WORKSPACE_CREATE_HELP = `pi-do workspace create — create a workspace

usage:
  pi-do workspace create [--base URL] [--json]

behavior:
  POSTs /workspaces. Prints the new workspace id.
  Without --json stdout is "workspace <id>"; with --json stdout is the
  raw server JSON and the human line goes to stderr.

exit codes:
  0  created
  1  server-side failure (error + hint printed from the body)
  2  usage error

example:
  pi-do workspace create --base http://127.0.0.1:8787
`;
const SESSION_HELP = `pi-do session — manage sessions

usage:
  pi-do session create --ws WS [--base URL] [--json]

subcommands:
  create    mint a session (POST /workspaces/:id/sessions)

example:
  pi-do session create --ws <workspace-id>
`;

const SESSION_CREATE_HELP = `pi-do session create — mint a session in a workspace

usage:
  pi-do session create --ws WS [--base URL] [--json]

behavior:
  POSTs /workspaces/:id/sessions. Prints the new session id.
  Without --json stdout is "session <id>"; with --json stdout is the
  raw server JSON and the human line goes to stderr.

exit codes:
  0  created
  1  server-side failure (error + hint printed from the body)
  2  usage error

example:
  pi-do session create --ws 550e8400-e29b-41d4-a716-446655440000
`;
const CLAIM_HELP = `pi-do claim — rotate the owner fence via revision CAS

usage:
  pi-do claim --ws WS --sid SID --fence F --expected N [--base URL] [--json]

behavior:
  POSTs {fence, expected} to /workspaces/:id/sessions/:sid/claim. Wrong
  fence answers 403 (Fenced); stale expected answers 409 (Conflict) naming
  the current revision. Success rotates the fence, bumps revision, returns
  both. Every error path mutates nothing.

exit codes:
  0  claimed ({fence, revision})
  1  server-side failure, e.g. 403 Fenced or 409 Conflict (error + hint printed)
  2  usage error

example:
  pi-do claim --ws <id> --sid <sid> --fence <fence> --expected 0
`;

const RUN_HELP = `pi-do run — one headless harness turn in a session

  pi-do run --ws WS --sid SID --prompt T [--model provider/id] [--thinking L] [--fence F --expected N] [--base URL] [--json]

behavior:
  POSTs {prompt} to /workspaces/:id/sessions/:sid/run. The stub model reads
  seed.txt and echoes a bash marker, then answers {result, toolCalls}.
  The turn resolves the session model triple; --model/--thinking carry
  one-shot overrides that the turn uses without persisting (same fail-closed
  validation as the model/thinking switches).
  With --fence/--expected the run enforces the owner fence like claim
  before opening the run (403 Fenced on wrong fence, 409 Conflict on stale
  revision); success rotates the fence, bumps revision, and returns both
  alongside the turn. Omit both for the legacy path.
  Without --json stdout is the result text; with --json stdout is the raw
  server JSON and the human line goes to stderr.

exit codes:
  0  ok
  1  server-side failure, e.g. unknown workspace/session (error + hint printed)
  2  usage error

example:
  pi-do run --ws <id> --sid <sid> --prompt "read seed.txt"
`;
const MODEL_HELP = `pi-do model — switch the session model mid-session

usage:
  pi-do model --ws WS --sid SID --model provider/id [--fence F --expected N] [--base URL] [--json]

behavior:
  POSTs {provider, id} to /workspaces/:id/sessions/:sid/model. Unknown ids
  fail closed naming the catalog (nothing mutates). Success updates the
  session row and appends a model_change pi entry in one transaction, so the
  next run resolves the new model. With --fence/--expected the switch
  enforces the owner fence like claim; omit both for the legacy path.

exit codes:
  0  switched ({model, revision})
  1  server-side failure, e.g. unknown model (error + hint printed)
  2  usage error

example:
  pi-do model --ws <id> --sid <sid> --model anthropic/claude-opus-4-6
`;

const THINKING_HELP = `pi-do thinking — switch the session thinking level

usage:
  pi-do thinking --ws WS --sid SID --level L [--fence F --expected N] [--base URL] [--json]

behavior:
  POSTs {level} to /workspaces/:id/sessions/:sid/thinking. Unknown levels
  fail closed naming the supported ones (nothing mutates). A known level the
  session model does not support clamps to the nearest supported one.
  Success updates the session row and appends a thinking_level_change pi
  entry in one transaction. With --fence/--expected the switch enforces the
  owner fence like claim; omit both for the legacy path.

exit codes:
  0  switched ({thinking, revision})
  1  server-side failure, e.g. unknown level (error + hint printed)
  2  usage error

example:
  pi-do thinking --ws <id> --sid <sid> --level high
`;

const MODELS_HELP = `pi-do models — list catalog models with context windows

usage:
  pi-do models [--provider P] [--base URL] [--json]

behavior:
  GETs /models (optionally ?provider=P). Unknown providers fail closed.
  Without --json stdout is one "provider/id (ctx N)" line per model.

exit codes:
  0  listed
  1  server-side failure (error + hint printed)
  2  usage error

example:
  pi-do models --provider anthropic
`;

const SETTINGS_HELP = `pi-do settings — workspace default model triple for session mint

usage:
  pi-do settings --ws WS [--model provider/id] [--level L] [--base URL] [--json]
  pi-do settings --ws WS [--base URL] [--json]

behavior:
  With --model/--level, merge-patches PUT /workspaces/:id/settings; omitted
  keys keep their values. Unknown model ids fail closed (nothing mutates).
  New sessions mint with the stored triple. Without flags, GETs the current
  defaults.

exit codes:
  0  stored or shown
  1  server-side failure (error + hint printed)
  2  usage error

example:
  pi-do settings --ws <id> --model anthropic/claude-opus-4-6 --level high
`;

const GIT_HELP = `pi-do git — narrow git reads over a session

usage:
  pi-do git --ws WS --sid SID [--base URL] [--json] <argv...>
  pi-do git --ws WS --sid SID [--base URL] [--json] -- <argv...>

behavior:
  POSTs { argv } to /workspaces/:id/sessions/:sid/git. Reads only:
  status, log, diff, show. Anything else is rejected before anything
  executes (403 forbidden, or 501 when the verb is a deferred write).

exit codes:
  0  ok (stdout is the command output)
  1  server-side failure (error + hint printed from the body)
  2  usage error

examples:
  pi-do git --ws <ws> --sid <sid> status
  pi-do git --ws <ws> --sid <sid> log
`;

const FILES_HELP = `pi-do files — read/write/list/remove workspace files

usage:
  pi-do files put --ws WS --path P [--body STR | --body-file F] [--base URL] [--json]
  pi-do files get --ws WS --path P [--out F] [--base URL] [--json]
  pi-do files ls  --ws WS [--path DIR] [--base URL] [--json]
  pi-do files rm  --ws WS --path P [--recursive] [--base URL] [--json]

subcommands:
  put     upload raw bytes (PUT /workspaces/:id/files?path=P)
  get     download raw bytes (GET ...?path=P); stdout stays byte-exact
  ls      list entries (GET ...?list=DIR, default "")
  rm      delete a file, or a directory tree with --recursive (DELETE ...?path=P)

examples:
  pi-do files put --ws <id> --path hello.txt --body "hi"
  pi-do files get --ws <id> --path hello.txt --out ./hello.txt
  pi-do files ls --ws <id> --path ""
  pi-do files rm --ws <id> --path hello.txt
`;

const FILES_PUT_HELP = `pi-do files put — upload raw bytes to a workspace file

usage:
  pi-do files put --ws WS --path P [--body STR | --body-file F] [--base URL] [--json]

behavior:
  PUTs the body bytes to /workspaces/:id/files?path=P with
  content-type application/octet-stream. Body source: --body (utf8 string),
  --body-file (file bytes), or piped stdin when neither is given.
  --body and --body-file are mutually exclusive.

exit codes:
  0  ok
  1  server-side failure (error + hint printed from the body)
  2  usage error

example:
  pi-do files put --ws 550e8400-e29b-41d4-a716-446655440000 --path notes/hi.txt --body "hello"
`;

const FILES_GET_HELP = `pi-do files get — download raw bytes of a workspace file

usage:
  pi-do files get --ws WS --path P [--out F] [--base URL] [--json]

behavior:
  GETs /workspaces/:id/files?path=P. On success stdout is the exact raw
  file bytes (or the file at --out when given); nothing else is written to
  stdout, so output stays byte-exact. Human progress goes to stderr.
  With --json the JSON metadata goes to stderr too (stdout stays raw).

exit codes:
  0  ok
  1  server-side failure, e.g. missing file (error + hint printed)
  2  usage error

example:
  pi-do files get --ws 550e8400-e29b-41d4-a716-446655440000 --path notes/hi.txt --out ./hi.txt
`;

const FILES_LS_HELP = `pi-do files ls — list workspace file entries

usage:
  pi-do files ls --ws WS [--path DIR] [--base URL] [--json]

behavior:
  GETs /workspaces/:id/files?list=DIR (--path doubles as the DIR prefix,
  default ""). Prints one entry per line without --json, raw server JSON
  on stdout with --json.

exit codes:
  0  ok
  1  server-side failure (error + hint printed from the body)
  2  usage error

example:
  pi-do files ls --ws 550e8400-e29b-41d4-a716-446655440000 --path notes/
`;
const FILES_RM_HELP = `pi-do files rm — delete a workspace file or directory tree

usage:
  pi-do files rm --ws WS --path P [--recursive] [--base URL] [--json]

behavior:
  DELETEs /workspaces/:id/files?path=P. A directory needs --recursive
  (?recursive=true) or the server refuses with a hint. Traversal outside
  the workspace root fails closed with a 400 plus hint.

exit codes:
  0  ok
  1  server-side failure (error + hint printed from the body)
  2  usage error

example:
  pi-do files rm --ws 550e8400-e29b-41d4-a716-446655440000 --path notes/hi.txt
`;
const EXEC_HELP = `pi-do exec — run a one-off shell command in a workspace

usage:
  pi-do exec --ws WS --command CMD [--cwd DIR] [--base URL] [--json]

behavior:
  POSTs {command, cwd} to /workspaces/:id/exec. The command runs once in
  an isolated shell (no workspace files or entries are touched) with output
  capped at 1 MiB and a fixed runtime timeout (kill arrives in PR12).
  Without --json stdout is the command stdout plus an "exit N" line on
  stderr; with --json stdout is the raw server JSON {stdout, stderr, exit}.

exit codes:
  0  ok (command exit is in the body, not the CLI exit)
  1  server-side failure, e.g. unknown workspace (error + hint printed)
  2  usage error

example:
  pi-do exec --ws 550e8400-e29b-41d4-a716-446655440000 --command "echo hi"
`;

const ENTRIES_HELP = `pi-do entries — ordered replay slice of persisted session entries

usage:
  pi-do entries --ws WS --sid SID [--after N] [--limit L] [--all] [--base URL] [--json]

behavior:
  GETs /workspaces/:id/sessions/:sid/entries?after=N&limit=L. Returns the
  ordered entry list plus the resume cursor ({entries: [{cursor, type, body}],
  head, count}). limit defaults to 100 and clamps at 1000. Without --json
  stdout is one "CURSOR TYPE BODY" line per entry; with --json stdout is
  the raw server JSON.
  With --all, pages after=lastCursor gaplessly until an empty page (limit
  per page from --limit, at most 100 pages). Pretty --all prints every entry
  once in cursor order; --json --all prints the assembled {entries, head,
  count}.

exit codes:
  0  ok
  1  server-side failure, e.g. unknown workspace/session (error + hint printed)
  2  usage error

example:
  pi-do entries --ws <id> --sid <sid> --after 0 --limit 3
  pi-do entries --ws <id> --sid <sid> --all
`;

const META_HELP = `pi-do meta — resume cursor for a session

usage:
  pi-do meta --ws WS --sid SID [--base URL] [--json]

behavior:
  GETs /workspaces/:id/sessions/:sid/meta. Returns {sid, ws, created, head,
  count, openRun} where openRun is the still-open run id or null. Without
  --json stdout is human lines; with --json stdout is the raw server JSON.

exit codes:
  0  ok
  1  server-side failure, e.g. unknown workspace/session (error + hint printed)
  2  usage error

example:
  pi-do meta --ws <id> --sid <sid>
`;
const STREAM_HELP = `pi-do stream — live turns over a WebSocket

usage:
  pi-do stream --ws WS --sid SID [--fence F --expected N] [--base URL] [--json]

behavior:
  Opens GET /workspaces/:id/sessions/:sid/stream as a WebSocket. Each stdin
  line becomes one {prompt} frame (the live fence attaches when --fence and
  --expected are given, and tracks {done} rotations). Every server frame
  prints on stdout as it arrives: {entry} frames carry the storage re-read,
  {done} carries the rotated {fence, revision} plus the result text,
  {aborted} ends a cancelled turn, {busy} means a turn is already running,
  {ping} is a heartbeat, {message}/{tool}/{agent} pass through for
  forward-compat, anything else prints as raw JSON.

stdin controls (one per line):
  <text>          send {prompt: text} (+fence/expected when given)
  {json}          send the raw JSON frame as-is
  /abort          send {abort: true}
  /steer <text>   send {steer: true, text} (+fence/expected when given)

exit codes:
  0  socket closed cleanly after stdin ended
  1  server-side failure or socket error (error + hint printed)
  2  usage error

example:
  printf 'read seed.txt\\n' | pi-do stream --ws <id> --sid <sid>
`;


function failUsage(message, help) {
  process.stderr.write(`pi-do: ${message}\n`);
  if (help) process.stderr.write(`\n${help}`);
  else process.stderr.write(`Run 'pi-do --help' for usage.\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE,
    json: false,
    help: false,
    ws: undefined,
    sid: undefined,
    prompt: undefined,
    fence: undefined,
    expected: undefined,
    after: undefined,
    limit: undefined,
    path: undefined,
    body: undefined,
    bodyFile: undefined,
    out: undefined,
    command: undefined,
    cwd: undefined,
    model: undefined,
    level: undefined,
    provider: undefined,
    all: false,
  };
  const positionals = [];
  let baseSet = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const takeValue = (flag) => {
      const eq = tok.indexOf("=");
      if (eq !== -1) return tok.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        failUsage(`flag ${flag} needs a value.`);
      }
      i++;
      return next;
    };
    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    } else if (tok === "--base") {
      opts.base = takeValue("--base");
      baseSet = true;
    } else if (tok.startsWith("--base=")) {
      opts.base = tok.slice("--base=".length);
      baseSet = true;
    } else if (tok === "--json") {
      opts.json = true;
    } else if (tok === "--help" || tok === "-h") {
      opts.help = true;
    } else if (tok === "--ws" || tok === "--workspace") {
      opts.ws = takeValue(tok);
    } else if (tok.startsWith("--ws=")) {
      opts.ws = tok.slice("--ws=".length);
    } else if (tok.startsWith("--workspace=")) {
      opts.workspace = undefined;
      opts.ws = tok.slice("--workspace=".length);
    } else if (tok === "--sid" || tok === "--session") {
      opts.sid = takeValue(tok);
    } else if (tok.startsWith("--sid=")) {
      opts.sid = tok.slice("--sid=".length);
    } else if (tok.startsWith("--session=")) {
      opts.sid = tok.slice("--session=".length);
    } else if (tok === "--path") {
      opts.path = takeValue("--path");
    } else if (tok.startsWith("--path=")) {
      opts.path = tok.slice("--path=".length);
    } else if (tok === "--body") {
      opts.body = takeValue("--body");
    } else if (tok.startsWith("--body=")) {
      opts.body = tok.slice("--body=".length);
    } else if (tok === "--body-file") {
      opts.bodyFile = takeValue("--body-file");
    } else if (tok.startsWith("--body-file=")) {
      opts.bodyFile = tok.slice("--body-file=".length);
    } else if (tok === "--out" || tok === "-o") {
      opts.out = takeValue(tok);
    } else if (tok.startsWith("--out=")) {
      opts.out = tok.slice("--out=".length);
    } else if (tok === "--command") {
      opts.command = takeValue("--command");
    } else if (tok.startsWith("--command=")) {
      opts.command = tok.slice("--command=".length);
    } else if (tok === "--cwd") {
      opts.cwd = takeValue("--cwd");
    } else if (tok.startsWith("--cwd=")) {
      opts.cwd = tok.slice("--cwd=".length);
    } else if (tok === "--fence") {
      opts.fence = takeValue("--fence");
    } else if (tok.startsWith("--fence=")) {
      opts.fence = tok.slice("--fence=".length);
    } else if (tok === "--expected") {
      opts.expected = takeValue("--expected");
    } else if (tok.startsWith("--expected=")) {
      opts.expected = tok.slice("--expected=".length);
    } else if (tok === "--prompt") {
      opts.prompt = takeValue("--prompt");
    } else if (tok.startsWith("--prompt=")) {
      opts.prompt = tok.slice("--prompt=".length);
    } else if (tok === "--after") {
      opts.after = takeValue("--after");
    } else if (tok.startsWith("--after=")) {
      opts.after = tok.slice("--after=".length);
    } else if (tok === "--limit") {
      opts.limit = takeValue("--limit");
    } else if (tok.startsWith("--limit=")) {
      opts.limit = tok.slice("--limit=".length);
    } else if (tok === "--model") {
      opts.model = takeValue("--model");
    } else if (tok.startsWith("--model=")) {
      opts.model = tok.slice("--model=".length);
    } else if (tok === "--level" || tok === "--thinking") {
      opts.level = takeValue(tok);
    } else if (tok.startsWith("--level=") || tok.startsWith("--thinking=")) {
      opts.level = tok.slice(tok.indexOf("=") + 1);
    } else if (tok === "--provider") {
      opts.provider = takeValue("--provider");
    } else if (tok.startsWith("--provider=")) {
      opts.provider = tok.slice("--provider=".length);
    } else if (tok === "--all") {
      opts.all = true;
    } else if (tok === "--recursive") {
      opts.recursive = true;
    } else {
      positionals.push(tok);
    }
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

/** Print a non-2xx response as error+hint (stderr) and raw JSON (stdout when --json). Returns exit code 1. */
async function failFromResponse(res, json) {
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const errorMsg =
    parsed && typeof parsed.error === "string" ? parsed.error : `request failed (HTTP ${res.status})`;
  const hint = parsed && typeof parsed.hint === "string" ? parsed.hint : text.slice(0, 500);
  human(`error: ${errorMsg}`);
  if (hint) human(`hint: ${hint}`);
  if (json) printJson(parsed ?? { error: errorMsg, status: res.status });
  process.exit(1);
}
function printEntryPretty(entry) {
  process.stdout.write(`${entry.cursor} ${entry.type} ${entry.body}\n`);
}

function printEntriesPayload(data, opts) {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (opts.json) {
    printJson(data);
  } else {
    for (const e of entries) printEntryPretty(e);
  }
  human(`entries ${entries.length} (after ${opts.after} limit ${opts.limit} head ${data.head} count ${data.count})`);
}

async function fetchEntriesPage(base, json, ws, sid, after, limit) {
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(sid)}/entries?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  return res.json();
}

function printStreamFrame(frame, json) {
  if (json) {
    printJson(frame);
    return;
  }
  if (frame.entry) {
    process.stdout.write(`entry ${frame.entry.cursor} ${frame.entry.type} ${frame.entry.body}\n`);
  } else if (frame.done) {
    if (typeof frame.fence === "string") process.stdout.write(`done fence=${frame.fence} revision=${frame.revision}\n`);
    else process.stdout.write(`done\n`);
    if (frame.result) process.stdout.write(frame.result.endsWith("\n") ? frame.result : `${frame.result}\n`);
  } else if (frame.aborted) {
    process.stdout.write(`aborted run=${frame.runId ?? ""}\n`);
  } else if (frame.busy) {
    process.stdout.write(`busy ${frame.hint ?? ""}\n`);
  } else if (frame.ping) {
    process.stdout.write(`ping\n`);
  } else if (frame.error) {
    process.stdout.write(`error ${frame.error} ${frame.hint ?? ""}\n`);
  } else if (frame.message !== undefined) {
    process.stdout.write(`message ${JSON.stringify(frame.message)}\n`);
  } else if (frame.tool !== undefined) {
    process.stdout.write(`tool ${JSON.stringify(frame.tool)}\n`);
  } else if (frame.agent !== undefined) {
    process.stdout.write(`agent ${JSON.stringify(frame.agent)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

function helpFor(cmd, sub) {
  if (cmd === "doctor") return DOCTOR_HELP;
  if (cmd === "workspace") {
    if (sub === "create") return WORKSPACE_CREATE_HELP;
    return WORKSPACE_HELP;
  }
  if (cmd === "session") {
    if (sub === "create") return SESSION_CREATE_HELP;
    return SESSION_HELP;
  }
  if (cmd === "files") {
    if (sub === "put") return FILES_PUT_HELP;
    if (sub === "get") return FILES_GET_HELP;
    if (sub === "ls") return FILES_LS_HELP;
    if (sub === "rm") return FILES_RM_HELP;
    return FILES_HELP;
  }
  if (cmd === "exec") return EXEC_HELP;
  if (cmd === "git") return GIT_HELP;
  if (cmd === "run") return RUN_HELP;
  if (cmd === "claim") return CLAIM_HELP;
  if (cmd === "model") return MODEL_HELP;
  if (cmd === "thinking") return THINKING_HELP;
  if (cmd === "models") return MODELS_HELP;
  if (cmd === "settings") return SETTINGS_HELP;
  if (cmd === "entries") return ENTRIES_HELP;
  if (cmd === "meta") return META_HELP;
  if (cmd === "stream") return STREAM_HELP;
  return ROOT_HELP;
}

async function readStdinBytes() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function resolvePutBody(opts) {
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    failUsage(`--body and --body-file are mutually exclusive.`, FILES_PUT_HELP);
  }
  if (opts.body !== undefined) return Buffer.from(opts.body, "utf8");
  if (opts.bodyFile !== undefined) {
    try {
      return await readFile(opts.bodyFile);
    } catch (e) {
      failUsage(`cannot read --body-file ${opts.bodyFile}: ${e.message}.`);
    }
  }
  const piped = await readStdinBytes();
  if (piped === null) {
    failUsage(`need --body STR, --body-file F, or piped stdin bytes.`, FILES_PUT_HELP);
  }
  return piped;
}

async function doDoctor(base, json) {
  let res;
  try {
    res = await fetch(`${stripBase(base)}/`);
  } catch (e) {
    human(`pi-do doctor: absent — no server listening at ${base} (is 'wrangler dev' running?).`);
    human(`detail: ${e.cause?.message ?? e.message}`);
    if (json) printJson({ ok: false, base, error: "absent" });
    process.exit(2);
  }
  if (json) printJson({ ok: true, base, status: res.status });
  human(`ok — server listening at ${base} (status ${res.status})`);
  process.exit(0);
}

async function doWorkspaceCreate(base, json) {
  let res;
  try {
    res = await fetch(`${stripBase(base)}/workspaces`, { method: "POST" });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`workspace ${data.workspaceId}`);
  } else {
    process.stdout.write(`workspace ${data.workspaceId}\n`);
  }
  process.exit(0);
}
async function doSessionCreate(base, json, opts) {
  if (!opts.ws) failUsage(`session create needs --ws WS.`, SESSION_CREATE_HELP);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions`;
  let res;
  try {
    res = await fetch(url, { method: "POST" });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`session ${data.sessionId}`);
  } else {
    process.stdout.write(`session ${data.sessionId}\n`);
  }
  process.exit(0);
}

async function doRun(base, json, opts) {
  if (!opts.ws) failUsage(`run needs --ws WS.`, RUN_HELP);
  if (!opts.sid) failUsage(`run needs --sid SID.`, RUN_HELP);
  if (opts.prompt === undefined) failUsage(`run needs --prompt T.`, RUN_HELP);
  if ((opts.fence !== undefined) !== (opts.expected !== undefined)) {
    failUsage(`run needs both --fence F and --expected N together, or neither.`, RUN_HELP);
  }
  let expected;
  if (opts.expected !== undefined) {
    expected = Number(opts.expected);
    if (!Number.isInteger(expected) || expected < 0) failUsage(`run needs --expected N (a non-negative integer).`, RUN_HELP);
  }
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/run`;
  const payload = { prompt: opts.prompt };
  if (opts.fence !== undefined) {
    payload.fence = opts.fence;
    payload.expected = expected;
  }
  if (opts.model !== undefined) payload.model = splitProviderId(opts.model, `run needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, RUN_HELP);
  if (opts.level !== undefined) payload.thinking = opts.level;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
  if (json) {
    printJson(data);
    human(`run ok: ${calls.length} tool calls`);
  } else {
    if (data.result) process.stdout.write(data.result.endsWith("\n") ? data.result : `${data.result}\n`);
    human(`run ok: ${calls.length} tool calls`);
  }
  process.exit(0);
}

async function doClaim(base, json, opts) {
  if (!opts.ws) failUsage(`claim needs --ws WS.`, CLAIM_HELP);
  if (!opts.sid) failUsage(`claim needs --sid SID.`, CLAIM_HELP);
  if (opts.fence === undefined) failUsage(`claim needs --fence F.`, CLAIM_HELP);
  if (opts.expected === undefined) failUsage(`claim needs --expected N.`, CLAIM_HELP);
  const expected = Number(opts.expected);
  if (!Number.isInteger(expected) || expected < 0) failUsage(`claim needs --expected N (a non-negative integer).`, CLAIM_HELP);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/claim`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fence: opts.fence, expected }),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`claim ok: revision ${data.revision}`);
  } else {
    process.stdout.write(`fence ${data.fence} revision ${data.revision}\n`);
  }
  process.exit(0);
}
async function doModel(base, json, opts) {
  if (!opts.ws) failUsage(`model needs --ws WS.`, MODEL_HELP);
  if (!opts.sid) failUsage(`model needs --sid SID.`, MODEL_HELP);
  if (opts.model === undefined) failUsage(`model needs --model provider/id.`, MODEL_HELP);
  if ((opts.fence !== undefined) !== (opts.expected !== undefined)) {
    failUsage(`model needs both --fence F and --expected N together, or neither.`, MODEL_HELP);
  }
  let expected;
  if (opts.expected !== undefined) {
    expected = Number(opts.expected);
    if (!Number.isInteger(expected) || expected < 0) failUsage(`model needs --expected N (a non-negative integer).`, MODEL_HELP);
  }
  const { provider, id } = splitProviderId(opts.model, `model needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, MODEL_HELP);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/model`;
  const payload = { provider, id };
  if (opts.fence !== undefined) {
    payload.fence = opts.fence;
    payload.expected = expected;
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`model ok: ${data.model.provider}/${data.model.id} (revision ${data.revision})`);
  } else {
    process.stdout.write(`model ${data.model.provider}/${data.model.id} revision ${data.revision}\n`);
  }
  process.exit(0);
}

async function doThinking(base, json, opts) {
  if (!opts.ws) failUsage(`thinking needs --ws WS.`, THINKING_HELP);
  if (!opts.sid) failUsage(`thinking needs --sid SID.`, THINKING_HELP);
  if (opts.level === undefined) failUsage(`thinking needs --level L.`, THINKING_HELP);
  if ((opts.fence !== undefined) !== (opts.expected !== undefined)) {
    failUsage(`thinking needs both --fence F and --expected N together, or neither.`, THINKING_HELP);
  }
  let expected;
  if (opts.expected !== undefined) {
    expected = Number(opts.expected);
    if (!Number.isInteger(expected) || expected < 0) failUsage(`thinking needs --expected N (a non-negative integer).`, THINKING_HELP);
  }
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/thinking`;
  const payload = { level: opts.level };
  if (opts.fence !== undefined) {
    payload.fence = opts.fence;
    payload.expected = expected;
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`thinking ok: ${data.thinking} (revision ${data.revision})`);
  } else {
    process.stdout.write(`thinking ${data.thinking} revision ${data.revision}\n`);
  }
  process.exit(0);
}

async function doModels(base, json, opts) {
  let url = `${stripBase(base)}/models`;
  if (opts.provider !== undefined) url += `?provider=${encodeURIComponent(opts.provider)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  const models = Array.isArray(data.models) ? data.models : [];
  if (json) {
    printJson(data);
    human(`${models.length} models`);
  } else if (models.length === 0) {
    process.stdout.write(`(empty)\n`);
  } else {
    for (const m of models) process.stdout.write(`${m.provider}/${m.id} (ctx ${m.contextWindow})\n`);
  }
  process.exit(0);
}

async function doSettings(base, json, opts) {
  if (!opts.ws) failUsage(`settings needs --ws WS.`, SETTINGS_HELP);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/settings`;
  if (opts.model === undefined && opts.level === undefined) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      human(`error: cannot reach server at ${base}`);
      human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
      if (json) printJson({ error: "cannot reach server", base });
      process.exit(1);
    }
    if (!res.ok) await failFromResponse(res, json);
    const data = await res.json();
    if (json) {
      printJson(data);
      human(`settings shown`);
    } else {
      const s = data.settings ?? {};
      process.stdout.write(`model ${s.modelProvider ?? "null"}/${s.modelId ?? "null"} thinking ${s.thinkingLevel ?? "null"}\n`);
    }
    process.exit(0);
  }
  const patch = {};
  if (opts.model !== undefined) {
    const { provider, id } = splitProviderId(opts.model, `settings needs --model provider/id (e.g. --model anthropic/claude-opus-4-6).`, SETTINGS_HELP);
    patch.modelProvider = provider;
    patch.modelId = id;
  }
  if (opts.level !== undefined) patch.thinkingLevel = opts.level;
  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`settings stored`);
  } else {
    const s = data.settings ?? {};
    process.stdout.write(`model ${s.modelProvider ?? "null"}/${s.modelId ?? "null"} thinking ${s.thinkingLevel ?? "null"}\n`);
  }
  process.exit(0);
}

async function doGit(base, json, opts, gitArgv) {
  if (!opts.ws) failUsage(`git needs --ws WS.`, GIT_HELP);
  if (!opts.sid) failUsage(`git needs --sid SID.`, GIT_HELP);
  if (gitArgv.length === 0) failUsage(`git needs an argv (e.g. pi-do git --ws WS --sid SID status).`, GIT_HELP);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/git`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv: gitArgv }),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    if (typeof data.stdout === "string" && data.stdout.length > 0) human(String(data.stdout));
  } else if (typeof data.stdout === "string" && data.stdout.length > 0) {
    process.stdout.write(data.stdout.endsWith("\n") ? data.stdout : `${data.stdout}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  }
  process.exit(0);
}

async function doFilesPut(base, json, opts) {
  if (!opts.ws) failUsage(`files put needs --ws WS.`, FILES_PUT_HELP);
  if (opts.path === undefined) failUsage(`files put needs --path P.`, FILES_PUT_HELP);
  if (opts.out !== undefined) failUsage(`files put takes no --out (did you mean files get?).`, FILES_PUT_HELP);
  const body = await resolvePutBody(opts);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?path=${encodeURIComponent(opts.path)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`wrote ${data.bytes} bytes to ${data.path}`);
  } else {
    process.stdout.write(`wrote ${data.bytes} bytes to ${data.path}\n`);
  }
  process.exit(0);
}

async function doFilesGet(base, json, opts) {
  if (!opts.ws) failUsage(`files get needs --ws WS.`, FILES_GET_HELP);
  if (opts.path === undefined) failUsage(`files get needs --path P.`, FILES_GET_HELP);
  if (opts.body !== undefined || opts.bodyFile !== undefined) {
    failUsage(`files get takes no --body/--body-file (did you mean files put?).`, FILES_GET_HELP);
  }
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?path=${encodeURIComponent(opts.path)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (opts.out !== undefined) {
    try {
      await writeFile(opts.out, bytes);
    } catch (e) {
      failUsage(`cannot write --out ${opts.out}: ${e.message}.`);
    }
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
  if (!opts.ws) failUsage(`files ls needs --ws WS.`, FILES_LS_HELP);
  if (opts.body !== undefined || opts.bodyFile !== undefined || opts.out !== undefined) {
    failUsage(`files ls takes no --body/--body-file/--out.`, FILES_LS_HELP);
  }
  const dir = opts.path ?? "";
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?list=${encodeURIComponent(dir)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (json) {
    printJson(data);
    human(`${entries.length} entries under "${dir}"`);
  } else if (entries.length === 0) {
    process.stdout.write(`(empty)\n`);
  } else {
    for (const e of entries) process.stdout.write(`${e.path} (${e.bytes} bytes)\n`);
  }
  process.exit(0);
}
async function doFilesRm(base, json, opts) {
  if (!opts.ws) failUsage(`files rm needs --ws WS.`, FILES_RM_HELP);
  if (opts.path === undefined) failUsage(`files rm needs --path P.`, FILES_RM_HELP);
  if (opts.body !== undefined || opts.bodyFile !== undefined || opts.out !== undefined) {
    failUsage(`files rm takes no --body/--body-file/--out.`, FILES_RM_HELP);
  }
  const rec = opts.recursive === true ? "&recursive=true" : "";
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/files?path=${encodeURIComponent(opts.path)}${rec}`;
  let res;
  try {
    res = await fetch(url, { method: "DELETE" });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  const removed = Array.isArray(data.removed) ? data.removed : [];
  if (json) {
    printJson(data);
    human(`removed ${removed.length} path(s)`);
  } else if (removed.length === 0) {
    process.stdout.write(`(removed nothing)\n`);
  } else {
    for (const p of removed) process.stdout.write(`removed ${p}\n`);
  }
  process.exit(0);
}

async function doEntries(base, json, opts) {
  if (!opts.ws) failUsage(`entries needs --ws WS.`, ENTRIES_HELP);
  if (!opts.sid) failUsage(`entries needs --sid SID.`, ENTRIES_HELP);
  const after = opts.after ?? "0";
  if (!/^\d+$/.test(after)) failUsage(`entries needs --after N (a non-negative integer).`, ENTRIES_HELP);
  const limit = opts.limit ?? "100";
  if (!/^\d+$/.test(limit) || Number(limit) > 1000) {
    failUsage(`entries needs --limit L (a non-negative integer up to 1000).`, ENTRIES_HELP);
  }
  if (!opts.all) {
    const data = await fetchEntriesPage(base, json, opts.ws, opts.sid, after, limit);
    printEntriesPayload(data, { json, after, limit });
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
    for (const e of slice) {
      entries.push(e);
      if (!json) printEntryPretty(e);
    }
    cursor = String(slice[slice.length - 1].cursor);
  }
  if (json) printJson({ entries, head, count });
  human(`entries ${entries.length} (after ${after} limit ${limit} head ${head} count ${count})`);
  process.exit(0);
}

async function doMeta(base, json, opts) {
  if (!opts.ws) failUsage(`meta needs --ws WS.`, META_HELP);
  if (!opts.sid) failUsage(`meta needs --sid SID.`, META_HELP);
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/sessions/${encodeURIComponent(opts.sid)}/meta`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`meta head ${data.head} count ${data.count} openRun ${data.openRun ?? "null"}`);
  } else {
    process.stdout.write(`sid ${data.sid}\nws ${data.ws}\ncreated ${data.created}\nhead ${data.head}\ncount ${data.count}\nopenRun ${data.openRun ?? "null"}\n`);
    human(`meta head ${data.head} count ${data.count}`);
  }
  process.exit(0);
}
async function doStream(base, json, opts) {
  if (!opts.ws) failUsage(`stream needs --ws WS.`, STREAM_HELP);
  if (!opts.sid) failUsage(`stream needs --sid SID.`, STREAM_HELP);
  if ((opts.fence !== undefined) !== (opts.expected !== undefined)) {
    failUsage(`stream needs both --fence F and --expected N together, or neither.`, STREAM_HELP);
  }
  let expected;
  if (opts.expected !== undefined) {
    expected = Number(opts.expected);
    if (!Number.isInteger(expected) || expected < 0) failUsage(`stream needs --expected N (a non-negative integer).`, STREAM_HELP);
  }
  if (typeof WebSocket === "undefined") {
    human(`error: this node has no global WebSocket`);
    human(`hint: use node >= 22 for 'pi-do stream', or drive the socket from verify/stream-protocol.sh`);
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
    if (fence !== undefined) {
      frame.fence = fence;
      frame.expected = expected;
    }
    return frame;
  };
  const sendLine = (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "/abort") {
      sendRaw({ abort: true });
      return;
    }
    if (text === "/steer" || text.startsWith("/steer ")) {
      sendRaw(withFence({ steer: true, text: text.slice("/steer".length).trim() }));
      return;
    }
    if (text.startsWith("{")) {
      sock.send(text);
      return;
    }
    sendRaw(withFence({ prompt: text }));
  };
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    try {
      sock.close();
    } catch {
      // Already gone; exit code carries the outcome.
    }
    process.exit(code);
  };
  sock.onopen = () => {
    human(`stream open ${url.toString()}`);
    if (process.stdin.isTTY) {
      human(`hint: type prompts line by line; Ctrl-D ends stdin, Ctrl-C closes the socket`);
    }
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
    process.stdin.on("end", () => {
      if (rest.trim()) sendLine(rest);
    });
    process.stdin.resume();
  };
  sock.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      human(`error: non-JSON frame from server`);
      human(`hint: the stream speaks one JSON object per message; reconnect and retry`);
      finish(1);
      return;
    }
    if (frame.done === true && typeof frame.fence === "string") {
      fence = frame.fence;
      expected = frame.revision;
    }
    if (frame.error && !frame.entry) human(`error: ${frame.error}`);
    if (frame.error && frame.hint) human(`hint: ${frame.hint}`);
    printStreamFrame(frame, json);
  };
  sock.onerror = () => {
    human(`error: socket error talking to ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "socket error", base });
    finish(1);
  };
  sock.onclose = (event) => {
    human(`stream close code=${event.code} reason=${event.reason || "-"}`);
    finish(event.wasClean || event.code === 1000 ? 0 : 0);
  };
  process.on("SIGINT", () => finish(0));
}


async function doExec(base, json, opts) {
  if (!opts.ws) failUsage(`exec needs --ws WS.`, EXEC_HELP);
  if (opts.command === undefined) failUsage(`exec needs --command CMD.`, EXEC_HELP);
  if (opts.path !== undefined || opts.body !== undefined || opts.bodyFile !== undefined || opts.out !== undefined) {
    failUsage(`exec takes no --path/--body/--body-file/--out.`, EXEC_HELP);
  }
  const payload = { command: opts.command };
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  const url = `${stripBase(base)}/workspaces/${encodeURIComponent(opts.ws)}/exec`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    human(`error: cannot reach server at ${base}`);
    human(`hint: start it first (e.g. run 'wrangler dev' in worker/), then retry`);
    if (json) printJson({ error: "cannot reach server", base });
    process.exit(1);
  }
  if (!res.ok) await failFromResponse(res, json);
  const data = await res.json();
  if (json) {
    printJson(data);
    human(`exit ${data.exit}`);
  } else {
    if (data.stdout) process.stdout.write(data.stdout.endsWith("\n") ? data.stdout : `${data.stdout}\n`);
    if (data.stderr) process.stderr.write(data.stderr.endsWith("\n") ? data.stderr : `${data.stderr}\n`);
    human(`exit ${data.exit}`);
  }
  process.exit(0);
}

async function main() {
  const { opts, positionals } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...extra] = positionals;

  if (opts.help) {
    process.stdout.write(helpFor(cmd, sub));
    process.exit(0);
  }
  if (!cmd || cmd === "help") {
    if (sub) {
      process.stdout.write(helpFor(sub, extra[0]));
    } else {
      process.stdout.write(ROOT_HELP);
    }
    process.exit(0);
  }

  if (cmd === "doctor") {
    if (sub !== undefined || extra.length > 0) failUsage(`doctor takes no subcommand.`, DOCTOR_HELP);
    await doDoctor(opts.base, opts.json);
  } else if (cmd === "workspace") {
    if (sub === undefined) failUsage(`workspace needs a subcommand (create).`, WORKSPACE_HELP);
    if (sub !== "create" || extra.length > 0) failUsage(`unknown workspace subcommand '${sub ?? ""}'.`, WORKSPACE_HELP);
    await doWorkspaceCreate(opts.base, opts.json);
  } else if (cmd === "files") {
    if (sub === undefined) failUsage(`files needs a subcommand (put|get|ls|rm).`, FILES_HELP);
    if (sub === "put" && extra.length === 0) await doFilesPut(opts.base, opts.json, opts);
    else if (sub === "get" && extra.length === 0) await doFilesGet(opts.base, opts.json, opts);
    else if (sub === "ls" && extra.length === 0) await doFilesLs(opts.base, opts.json, opts);
    else if (sub === "rm" && extra.length === 0) await doFilesRm(opts.base, opts.json, opts);
    else failUsage(`unknown files subcommand '${sub}'.`, FILES_HELP);
  } else if (cmd === "exec") {
    if (sub !== undefined || extra.length > 0) failUsage(`exec takes no subcommand.`, EXEC_HELP);
    await doExec(opts.base, opts.json, opts);
  } else if (cmd === "git") {
    await doGit(opts.base, opts.json, opts, sub === undefined ? [...extra] : [sub, ...extra]);
  } else if (cmd === "entries") {
    if (sub !== undefined || extra.length > 0) failUsage(`entries takes no subcommand.`, ENTRIES_HELP);
    await doEntries(opts.base, opts.json, opts);
  } else if (cmd === "meta") {
    if (sub !== undefined || extra.length > 0) failUsage(`meta takes no subcommand.`, META_HELP);
    await doMeta(opts.base, opts.json, opts);
  } else if (cmd === "session") {
    if (sub !== "create" || extra.length > 0) failUsage(`unknown session subcommand '${sub ?? ""}'.`, SESSION_HELP);
    await doSessionCreate(opts.base, opts.json, opts);
  } else if (cmd === "claim") {
    if (sub !== undefined || extra.length > 0) failUsage(`claim takes no subcommand.`, CLAIM_HELP);
    await doClaim(opts.base, opts.json, opts);
  } else if (cmd === "run") {
    if (sub !== undefined || extra.length > 0) failUsage(`run takes no subcommand.`, RUN_HELP);
    await doRun(opts.base, opts.json, opts);
  } else if (cmd === "stream") {
    if (sub !== undefined || extra.length > 0) failUsage(`stream takes no subcommand.`, STREAM_HELP);
    await doStream(opts.base, opts.json, opts);
  } else if (cmd === "model") {
    if (sub !== undefined || extra.length > 0) failUsage(`model takes no subcommand.`, MODEL_HELP);
    await doModel(opts.base, opts.json, opts);
  } else if (cmd === "thinking") {
    if (sub !== undefined || extra.length > 0) failUsage(`thinking takes no subcommand.`, THINKING_HELP);
    await doThinking(opts.base, opts.json, opts);
  } else if (cmd === "models") {
    if (sub !== undefined || extra.length > 0) failUsage(`models takes no subcommand.`, MODELS_HELP);
    await doModels(opts.base, opts.json, opts);
  } else if (cmd === "settings") {
    await doSettings(opts.base, opts.json, opts);
  } else {
    failUsage(`unknown command '${cmd}'.`, ROOT_HELP);
  }
}

main().catch((e) => {
  process.stderr.write(`pi-do: unexpected failure: ${e?.message ?? e}\n`);
  process.exit(1);
});
