# pi-do

Serverless coding agent on Cloudflare Workers. One stateless Worker routes; one Durable Object per workspace is the machine: virtual filesystem, agent harness, and session storage in DO SQLite.

## Layout

- `worker/` — the Worker, Durable Object, stream protocol, model runtime. Run `npx wrangler dev` here.
- `packages/pi-cf/` — the agent core: session loop, context build, tools, entries, fence.
- `cli/` — `pi-do` command line. Run `node cli/bin/pi-do.mjs --help`.
- `verify/` — one proof script per behavior. Each writes `artifacts/{RUN_ID}/{check}/`.
- `refs/` — read-only vendor reference (never imported).

## Dev

```sh
npm install
npx wrangler dev --port 8793   # in worker/
node cli/bin/pi-do.mjs doctor --base http://127.0.0.1:8793
```

Keyed models arrive only as Worker secrets (`worker/.dev.vars`, gitignored, never committed). Without a key every turn runs the stub.

## Verify

```sh
sh verify/harness-smoke.sh http://127.0.0.1:8793
```

Green is a `^PASS` line in the transcript, never the exit code. Keyed batteries need `OPENCODE_API_KEY` in the caller env.
