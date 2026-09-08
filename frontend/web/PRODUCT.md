# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo developer directing coding agents. They open pi-do in a browser, point an agent at a repo-equivalent workspace, and steer while it works — reviewing progress, answering, redirecting.

## Product Purpose

Serverless coding agent, fully on Cloudflare Workers: one stateless Worker routes; one Durable Object per workspace is the machine (virtual filesystem, agent harness, session storage in DO SQLite). The web chat is the steering wheel — success means the agent's code changes land in the user's repo.

## Positioning

The DO is the machine: no local dependency, crash mid-run and the session tree is intact; every harness event is persisted before emit, so resume is replay. A library, not a service: `createPiCf()` embeds the agent in the host's own Worker.

## Operating Context

Single workspace = one repo-equivalent (one DO, one VFS, many sessions). A session is one agent conversation plus work history, resumed via replay. Driven from any browser, 24/7, no local machine. Keyed models arrive only as Worker secrets; without a key turns run the stub.

## Capabilities and Constraints

Confirmed: Workers-only, single-user, self-deployed on the user's own Cloudflare account. No multi-tenant auth/billing, no containers, no node/python execution in v1. Pi's tools only (`read/write/edit/bash` against one execution env). Undecided: multi-user/teams later — explicitly out of scope, do not design around it.

UI is composed from vendored libraries, never implemented from scratch: `beautiful-ui` kit and `aicss` (agentic components) today, more libraries to come. Design starts from what components exist; check the library before building anything. Reuse is verbatim port unless adapted with a decision.

## Brand Commitments

Name: pi-do. Binding references the user made for the chat surface: aicss input bar, shadcn preset `b1D0dxmC` theme, T3-style thread/composer layout logic. No other voice, asset, or identity constraints.

## Evidence on Hand

Live: `worker/` API (Hono + Valibot), `packages/pi-cf/` agent core, `cli/` (`pi-do doctor`, workspace/files/session/stream commands), `verify/*.sh` behavior proofs under `artifacts/`. Web chat: input-bar shell only (`frontend/web`), no thread or backend wiring yet. Real user content, testimonials, press: none — do not fabricate.

## Product Principles

1. Working first: done means proven over the real path, not typechecked.
2. Lean and boring: small focused changes, existing patterns, fight scope creep.
3. Storage is the truth: persist before emit; every state must survive a crash.
4. Errors tell the user what to do next, never just what failed.
