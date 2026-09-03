// verify-models.mjs — resolves one known anthropic id and one known openai
// id through the worker's buildRuntime lookup, the same path production
// runs take. Asserts contextWindow plus cost plus baseUrl arrive from the
// pi-ai catalog and are sane, unknown ids fail closed with the provider
// model id list as the hint, and keyless env still yields the stub.
// Exit nonzero on the first gap. Fake key material only, never
// process.env; the catalog data needs no credentials.
import { buildRuntime, STUB_MODEL_ID } from "../../worker/src/model-runtime.ts";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";

const KNOWN_ANTHROPIC = "claude-sonnet-4-5";
const KNOWN_OPENAI = "gpt-4o";

function fail(step, want, got) {
  console.error(`FAIL ${step}: want ${want} got ${got}`);
  process.exit(1);
}

function eq(step, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(step, b, a);
}

function sane(step, model, catalogEntry) {
  eq(`${step}-id`, model.id, catalogEntry.id);
  eq(`${step}-baseUrl`, model.baseUrl, catalogEntry.baseUrl);
  eq(`${step}-contextWindow`, model.contextWindow, catalogEntry.contextWindow);
  eq(`${step}-maxTokens`, model.maxTokens, catalogEntry.maxTokens);
  eq(`${step}-cost`, model.cost, catalogEntry.cost);
  if (!(model.contextWindow > 0))
    fail(`${step}-sane-window`, "> 0", String(model.contextWindow));
  if (!(model.maxTokens > 0))
    fail(`${step}-sane-max`, "> 0", String(model.maxTokens));
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    const v = model.cost[k];
    if (typeof v !== "number" || !(v >= 0) || !Number.isFinite(v))
      fail(`${step}-sane-cost-${k}`, "finite number >= 0", String(v));
  }
  if (typeof model.baseUrl !== "string" || !model.baseUrl.startsWith("https://"))
    fail(`${step}-sane-base`, "https://…", String(model.baseUrl));
}

function throwsHinted(step, fn, mustName) {
  try {
    fn();
  } catch (e) {
    if (
      e !== null &&
      typeof e === "object" &&
      typeof e.error === "string" &&
      typeof e.hint === "string" &&
      e.hint.includes(mustName)
    )
      return;
    fail(step, `{ error: string, hint naming ${mustName} }`, JSON.stringify(e));
  }
  fail(step, "throw", "no throw");
}

const a = buildRuntime({ ANTHROPIC_API_KEY: "fake", MODEL_ID: KNOWN_ANTHROPIC });
eq("anthropic-stub", a.stub, false);
eq("anthropic-provider", a.model.provider, "anthropic");
sane("anthropic", a.model, ANTHROPIC_MODELS[KNOWN_ANTHROPIC]);

const aDefault = buildRuntime({ ANTHROPIC_API_KEY: "fake" });
eq("anthropic-default-stub", aDefault.stub, false);
sane("anthropic-default", aDefault.model, ANTHROPIC_MODELS[aDefault.model.id]);

const o = buildRuntime({ OPENAI_API_KEY: "fake", MODEL_ID: KNOWN_OPENAI });
eq("openai-stub", o.stub, false);
eq("openai-provider", o.model.provider, "openai");
sane("openai", o.model, OPENAI_MODELS[KNOWN_OPENAI]);

const oDefault = buildRuntime({ OPENAI_API_KEY: "fake" });
eq("openai-default-stub", oDefault.stub, false);
sane("openai-default", oDefault.model, OPENAI_MODELS[oDefault.model.id]);

const both = buildRuntime({ ANTHROPIC_API_KEY: "fake", OPENAI_API_KEY: "fake" });
eq("both-provider", both.model.provider, "anthropic");

throwsHinted(
  "unknown-anthropic",
  () => buildRuntime({ ANTHROPIC_API_KEY: "fake", MODEL_ID: "nope-123" }),
  KNOWN_ANTHROPIC,
);
throwsHinted(
  "unknown-openai",
  () => buildRuntime({ OPENAI_API_KEY: "fake", MODEL_ID: "nope-123" }),
  KNOWN_OPENAI,
);

const s = buildRuntime({});
eq("stub", s.stub, true);
eq("stub-id", s.model.id, STUB_MODEL_ID);

console.log("PASS verify-models");
