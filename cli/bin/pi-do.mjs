#!/usr/bin/env node
// pi-do CLI driver: doctor / workspace create / session create / files put|get|ls / git.
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
  files put|get|ls              read/write/list workspace files
  git                           narrow git reads (POST /workspaces/:id/sessions/:sid/git)

global flags:
  --base URL    worker base URL (default ${DEFAULT_BASE})
  --json        machine data on stdout, human text on stderr
  --help, -h    show help (also: pi-do <command> --help)

examples:
  pi-do doctor
  pi-do workspace create
  pi-do files put --ws <id> --path hello.txt --body "hi"
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

const FILES_HELP = `pi-do files — read/write/list workspace files

usage:
  pi-do files put --ws WS --path P [--body STR | --body-file F] [--base URL] [--json]
  pi-do files get --ws WS --path P [--out F] [--base URL] [--json]
  pi-do files ls  --ws WS [--path DIR] [--base URL] [--json]

subcommands:
  put     upload raw bytes (PUT /workspaces/:id/files?path=P)
  get     download raw bytes (GET ...?path=P); stdout stays byte-exact
  ls      list entries (GET ...?list=DIR, default "")

examples:
  pi-do files put --ws <id> --path hello.txt --body "hi"
  pi-do files get --ws <id> --path hello.txt --out ./hello.txt
  pi-do files ls --ws <id> --path ""
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
    path: undefined,
    body: undefined,
    bodyFile: undefined,
    out: undefined,
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
    } else if (tok.startsWith("-") && tok.length > 1) {
      failUsage(`unknown flag ${tok.split("=")[0]}.`);
    } else {
      positionals.push(tok);
    }
  }
  // Guard against empty-string values passed as `--flag ""`.
  if (baseSet && opts.base === "") failUsage(`flag --base needs a value.`);
  return { opts, positionals };
}

function stripBase(base) {
  return base.replace(/\/+$/, "");
}

function human(text) {
  process.stderr.write(`${text}\n`);
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

function helpFor(cmd, sub) {
  if (cmd === "doctor") return DOCTOR_HELP;
  if (cmd === "workspace") return sub === "create" ? WORKSPACE_CREATE_HELP : WORKSPACE_HELP;
  if (cmd === "session") return sub === "create" ? SESSION_CREATE_HELP : SESSION_HELP;
  if (cmd === "git") return GIT_HELP;
  if (cmd === "files") {
    if (sub === "put") return FILES_PUT_HELP;
    if (sub === "get") return FILES_GET_HELP;
    if (sub === "ls") return FILES_LS_HELP;
    return FILES_HELP;
  }
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
  } else if (cmd === "session") {
    if (sub !== "create" || extra.length > 0) failUsage(`unknown session subcommand '${sub ?? ""}'.`, SESSION_HELP);
    await doSessionCreate(opts.base, opts.json, opts);
  } else if (cmd === "git") {
    const gitArgv = sub === undefined ? [] : [sub, ...extra];
    await doGit(opts.base, opts.json, opts, gitArgv);
  } else if (cmd === "files") {
    if (sub === undefined) failUsage(`files needs a subcommand (put|get|ls).`, FILES_HELP);
    if (sub === "put" && extra.length === 0) await doFilesPut(opts.base, opts.json, opts);
    else if (sub === "get" && extra.length === 0) await doFilesGet(opts.base, opts.json, opts);
    else if (sub === "ls" && extra.length === 0) await doFilesLs(opts.base, opts.json, opts);
    else failUsage(`unknown files subcommand '${sub}'.`, FILES_HELP);
  } else {
    failUsage(`unknown command '${cmd}'.`, ROOT_HELP);
  }
}

main().catch((e) => {
  process.stderr.write(`pi-do: unexpected failure: ${e?.message ?? e}\n`);
  process.exit(1);
});
