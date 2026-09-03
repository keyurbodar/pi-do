// Pattern source (read-only): refs/pi/packages/ai src/types.ts Model
// (id/name/api/provider/baseUrl plus a stream function) and
// refs/pi/packages/coding-agent ModelRuntime.create (async model/auth
// facade). Here the runtime is sync and key-driven: provider keys are read
// from env, otherwise the deterministic stub stands in. Never log keys:
// key material only decides the branch and never leaves memory.
// Catalog source: pi-ai owns model ids, urls, and prices. This file only
// looks models up in the installed anthropic/openai data slices (never the
// provider runtime or auth modules) and fails closed on unknown ids.
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import type { Api, Model } from "@earendil-works/pi-ai";
export const STUB_MODEL_ID = "stub";

export interface RuntimeModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  contextWindow: Model<Api>["contextWindow"];
  maxTokens: Model<Api>["maxTokens"];
  cost: Model<Api>["cost"];
}

export interface ModelRuntime {
  model: RuntimeModel;
  stub: boolean;
}

export interface RuntimeEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MODEL_ID?: string;
}

const ANTHROPIC_DEFAULT_ID =
  "claude-sonnet-4-5" satisfies keyof typeof ANTHROPIC_MODELS;
const OPENAI_DEFAULT_ID = "gpt-4o" satisfies keyof typeof OPENAI_MODELS;

function resolveModel(
  catalog: Record<string, Model<Api>>,
  provider: string,
  want: string,
): RuntimeModel {
  const entry = catalog[want];
  if (!entry) {
    throw {
      error: `unknown model: ${want}`,
      hint: `available ${provider} models: ${Object.keys(catalog).sort().join(", ")}`,
    };
  }
  return {
    id: entry.id,
    name: entry.name,
    api: entry.api,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: entry.cost,
  };
}

export function buildRuntime(env: RuntimeEnv): ModelRuntime {
  const override =
    typeof env.MODEL_ID === "string" && env.MODEL_ID.length > 0
      ? env.MODEL_ID
      : undefined;
  if (
    typeof env.ANTHROPIC_API_KEY === "string" &&
    env.ANTHROPIC_API_KEY.length > 0
  ) {
    return {
      model: resolveModel(
        ANTHROPIC_MODELS,
        "anthropic",
        override ?? ANTHROPIC_DEFAULT_ID,
      ),
      stub: false,
    };
  }
  if (
    typeof env.OPENAI_API_KEY === "string" &&
    env.OPENAI_API_KEY.length > 0
  ) {
    return {
      model: resolveModel(
        OPENAI_MODELS,
        "openai",
        override ?? OPENAI_DEFAULT_ID,
      ),
      stub: false,
    };
  }
  // DEV-ONLY fallback: no provider keys in env, so the keyless stub stands
  // in. Production callers must supply keys; this branch exists for local
  // verify without credentials.
  return {
    model: {
      id: STUB_MODEL_ID,
      name: STUB_MODEL_ID,
      api: "stub",
      provider: "stub",
      baseUrl: "",
      contextWindow: 0,
      maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stub: true,
  };
}
