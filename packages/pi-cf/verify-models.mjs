// verify-models.mjs — same buildRuntime lookup production runs take.
// Fake key material only, never process.env; the catalog needs no credentials.
import {
  buildRuntime,
  customKeyEnvVar,
  STUB_MODEL_ID,
} from "../../worker/src/model-runtime.ts";
import { ANT_LING_MODELS } from "@earendil-works/pi-ai/providers/ant-ling.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { AZURE_OPENAI_RESPONSES_MODELS } from "@earendil-works/pi-ai/providers/azure-openai-responses.models";
import { BASETEN_MODELS } from "@earendil-works/pi-ai/providers/baseten.models";
import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { MINIMAX_CN_MODELS } from "@earendil-works/pi-ai/providers/minimax-cn.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { NVIDIA_MODELS } from "@earendil-works/pi-ai/providers/nvidia.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENCODE_MODELS } from "@earendil-works/pi-ai/providers/opencode.models";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { QWEN_TOKEN_PLAN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan.models";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn.models";
import { QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual.models";
import { TOGETHER_MODELS } from "@earendil-works/pi-ai/providers/together.models";
import { VERCEL_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { XIAOMI_MODELS } from "@earendil-works/pi-ai/providers/xiaomi.models";
import { XIAOMI_TOKEN_PLAN_AMS_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams.models";
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models";
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { ZAI_CODING_CN_MODELS } from "@earendil-works/pi-ai/providers/zai-coding-cn.models";

const TABLE = [
  { envVar: "ANTHROPIC_API_KEY", catalog: ANTHROPIC_MODELS },
  { envVar: "OPENAI_API_KEY", catalog: OPENAI_MODELS },
  { envVar: "ANT_LING_API_KEY", catalog: ANT_LING_MODELS },
  { envVar: "AZURE_OPENAI_API_KEY", catalog: AZURE_OPENAI_RESPONSES_MODELS },
  { envVar: "BASETEN_API_KEY", catalog: BASETEN_MODELS },
  { envVar: "CEREBRAS_API_KEY", catalog: CEREBRAS_MODELS },
  { envVar: "DEEPSEEK_API_KEY", catalog: DEEPSEEK_MODELS },
  { envVar: "FIREWORKS_API_KEY", catalog: FIREWORKS_MODELS },
  { envVar: "GEMINI_API_KEY", catalog: GOOGLE_MODELS },
  { envVar: "GROQ_API_KEY", catalog: GROQ_MODELS },
  { envVar: "HF_TOKEN", catalog: HUGGINGFACE_MODELS },
  { envVar: "KIMI_API_KEY", catalog: KIMI_CODING_MODELS },
  { envVar: "MINIMAX_API_KEY", catalog: MINIMAX_MODELS },
  { envVar: "MINIMAX_CN_API_KEY", catalog: MINIMAX_CN_MODELS },
  { envVar: "MISTRAL_API_KEY", catalog: MISTRAL_MODELS },
  { envVar: "MOONSHOT_API_KEY", catalog: MOONSHOTAI_MODELS },
  { envVar: "MOONSHOT_API_KEY", catalog: MOONSHOTAI_CN_MODELS },
  { envVar: "NVIDIA_API_KEY", catalog: NVIDIA_MODELS },
  { envVar: "OPENCODE_API_KEY", catalog: OPENCODE_MODELS },
  { envVar: "OPENCODE_API_KEY", catalog: OPENCODE_GO_MODELS },
  { envVar: "OPENROUTER_API_KEY", catalog: OPENROUTER_MODELS },
  { envVar: "QWEN_TOKEN_PLAN_API_KEY", catalog: QWEN_TOKEN_PLAN_MODELS },
  { envVar: "QWEN_TOKEN_PLAN_CN_API_KEY", catalog: QWEN_TOKEN_PLAN_CN_MODELS },
  {
    envVar: "QWEN_TOKEN_PLAN_API_KEY",
    catalog: QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS,
  },
  { envVar: "TOGETHER_API_KEY", catalog: TOGETHER_MODELS },
  { envVar: "AI_GATEWAY_API_KEY", catalog: VERCEL_AI_GATEWAY_MODELS },
  { envVar: "XAI_API_KEY", catalog: XAI_MODELS },
  { envVar: "XIAOMI_API_KEY", catalog: XIAOMI_MODELS },
  { envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", catalog: XIAOMI_TOKEN_PLAN_AMS_MODELS },
  { envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY", catalog: XIAOMI_TOKEN_PLAN_CN_MODELS },
  { envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", catalog: XIAOMI_TOKEN_PLAN_SGP_MODELS },
  { envVar: "ZAI_API_KEY", catalog: ZAI_MODELS },
  { envVar: "ZAI_CODING_CN_API_KEY", catalog: ZAI_CODING_CN_MODELS },
];

const UNKNOWN_SENTINEL = "nope-123";

function providerId(catalog) {
  return Object.values(catalog)[0].provider;
}

function sortedIds(catalog) {
  return Object.keys(catalog).sort();
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
  // Azure ships an empty catalog baseUrl (deployment-scoped endpoint, set
  // per deployment via models.json baseUrl); everything else ships https.
  if (catalogEntry.baseUrl === "") {
    eq(`${step}-base-empty`, model.baseUrl, "");
  } else if (
    typeof model.baseUrl !== "string" ||
    !model.baseUrl.startsWith("https://")
  )
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
      return e;
    fail(step, `{ error: string, hint naming ${mustName} }`, JSON.stringify(e));
  }
  fail(step, "throw", "no throw");
}

const seenIds = new Set();
for (const { envVar, catalog } of TABLE) {
  const id = providerId(catalog);
  if (seenIds.has(id)) fail("provider-ids-unique", "unique", id);
  seenIds.add(id);
  const ids = sortedIds(catalog);
  const first = ids[0];
  const env = { [envVar]: "fake" };

  const scoped = buildRuntime({ ...env, MODEL_ID: `${id}/${first}` });
  eq(`${id}-scoped-stub`, scoped.stub, false);
  eq(`${id}-scoped-provider`, scoped.model.provider, id);
  sane(`${id}-scoped`, scoped.model, catalog[first]);

  // Shared keys (moonshot, opencode, qwen pairs) key several providers;
  // the default is the first of them in table (precedence) order.
  const peers = TABLE.filter((row) => row.envVar === envVar).map((row) =>
    providerId(row.catalog),
  );
  const winner = TABLE.find((row) => providerId(row.catalog) === peers[0]);
  const fallback = buildRuntime(env);
  eq(`${id}-default-stub`, fallback.stub, false);
  eq(`${id}-default-provider`, fallback.model.provider, peers[0]);
  eq(`${id}-default-id`, fallback.model.id, sortedIds(winner.catalog)[0]);
  sane(`${id}-default`, fallback.model, winner.catalog[fallback.model.id]);

  throwsHinted(
    `${id}-unknown-bare`,
    () => buildRuntime({ ...env, MODEL_ID: UNKNOWN_SENTINEL }),
    first,
  );
  const scopedUnknown = throwsHinted(
    `${id}-unknown-scoped`,
    () => buildRuntime({ ...env, MODEL_ID: `${id}/${UNKNOWN_SENTINEL}` }),
    first,
  );
  eq(`${id}-unknown-scoped-error`, scopedUnknown.error, `unknown model: ${id}/${UNKNOWN_SENTINEL}`);
}

const anthropicFirst = sortedIds(ANTHROPIC_MODELS)[0];
const bare = buildRuntime({
  ANTHROPIC_API_KEY: "fake",
  MODEL_ID: anthropicFirst,
});
eq("bare-stub", bare.stub, false);
eq("bare-provider", bare.model.provider, "anthropic");
sane("bare", bare.model, ANTHROPIC_MODELS[anthropicFirst]);

const both = buildRuntime({ ANTHROPIC_API_KEY: "fake", OPENAI_API_KEY: "fake" });
eq("both-provider", both.model.provider, "anthropic");
const openaiGroq = buildRuntime({ OPENAI_API_KEY: "fake", GROQ_API_KEY: "fake" });
eq("openai-groq-provider", openaiGroq.model.provider, "openai");
const allKeys = Object.fromEntries(TABLE.map(({ envVar }) => [envVar, "fake"]));
eq("all-provider", buildRuntime(allKeys).model.provider, "anthropic");

const openaiEnv = { ANTHROPIC_API_KEY: "fake", OPENCODE_API_KEY: "fake" };
const shared = sortedIds(ANTHROPIC_MODELS).find((id) => id in OPENCODE_MODELS);
if (shared === undefined) fail("ambiguous-fixture", "shared id", "none");
const ambiguous = throwsHinted(
  "ambiguous",
  () => buildRuntime({ ...openaiEnv, MODEL_ID: shared }),
  "anthropic",
);
eq("ambiguous-error", ambiguous.error, `ambiguous model id: ${shared}`);
if (!ambiguous.hint.includes("opencode"))
  fail("ambiguous-hint", "hint naming opencode", ambiguous.hint);

const fakeFixture = {
  providers: {
    "fake-proxy": {
      api: "openai-completions",
      baseUrl: "https://fake.example/v1",
      models: [
        {
          id: "fake-1",
          contextWindow: 8000,
          maxTokens: 2000,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};
const fakeEntry = fakeFixture.providers["fake-proxy"].models[0];
const fakeKey = customKeyEnvVar("fake-proxy");
const fakeEnv = { [fakeKey]: "fake" };
const fakeScoped = buildRuntime(
  { ...fakeEnv, MODEL_ID: "fake-proxy/fake-1" },
  fakeFixture,
);
eq("fake-scoped-stub", fakeScoped.stub, false);
eq("fake-scoped-provider", fakeScoped.model.provider, "fake-proxy");
eq("fake-scoped-api", fakeScoped.model.api, "openai-completions");
sane(
  "fake-scoped",
  fakeScoped.model,
  { ...fakeEntry, name: fakeEntry.id, provider: "fake-proxy", api: "openai-completions", baseUrl: "https://fake.example/v1" },
);
const fakeBare = buildRuntime({ ...fakeEnv, MODEL_ID: "fake-1" }, fakeFixture);
eq("fake-bare-provider", fakeBare.model.provider, "fake-proxy");
const fakeDefault = buildRuntime(
  { ANTHROPIC_API_KEY: "fake", ...fakeEnv },
  fakeFixture,
);
eq("fake-default-provider", fakeDefault.model.provider, "anthropic");
const openaiFirstKeyless = sortedIds(OPENAI_MODELS)[0];
throwsHinted(
  "fake-keyless",
  () =>
    buildRuntime(
      { OPENAI_API_KEY: "fake", MODEL_ID: "fake-proxy/fake-1" },
      fakeFixture,
    ),
  openaiFirstKeyless,
);

const openaiId = providerId(OPENAI_MODELS);
const openaiFirst = sortedIds(OPENAI_MODELS)[0];
const mergeFixture = {
  providers: {
    [openaiId]: {
      models: [{ id: "custom-added", baseUrl: "https://fake.example/v1", contextWindow: 4000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      modelOverrides: { [openaiFirst]: { maxTokens: 1234 } },
    },
  },
};
const merged = buildRuntime(
  { OPENAI_API_KEY: "fake", MODEL_ID: `${openaiId}/custom-added` },
  mergeFixture,
);
eq("merge-added-provider", merged.model.provider, openaiId);
const overridden = buildRuntime(
  { OPENAI_API_KEY: "fake", MODEL_ID: `${openaiId}/${openaiFirst}` },
  mergeFixture,
);
eq("merge-override-max", overridden.model.maxTokens, 1234);
eq("merge-override-window", overridden.model.contextWindow, OPENAI_MODELS[openaiFirst].contextWindow);

const inlineFixture = {
  providers: { "fake-proxy": { apiKey: "secret", models: [] } },
};
const inlineError = throwsHinted(
  "inline-key",
  () => buildRuntime(fakeEnv, inlineFixture),
  fakeKey,
);
if (!inlineError.error.includes("apiKey"))
  fail("inline-key-error", "error naming apiKey", inlineError.error);

const s = buildRuntime({});
eq("stub", s.stub, true);
eq("stub-id", s.model.id, STUB_MODEL_ID);
const sFixture = buildRuntime({}, fakeFixture);
eq("stub-fixture", sFixture.stub, true);
eq("stub-fixture-id", sFixture.model.id, STUB_MODEL_ID);
const sModelId = buildRuntime({ MODEL_ID: UNKNOWN_SENTINEL });
eq("stub-model-id", sModelId.stub, true);

console.log("PASS verify-models");
